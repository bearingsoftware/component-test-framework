import { describe, it, expect, vi, afterAll } from 'vitest'
import * as http from 'http'

type StepFn = (this: unknown, ...args: unknown[]) => unknown
interface Step {
  options: { timeout?: number }
  fn: StepFn
}
const steps = vi.hoisted(() => new Map<string, Step>())

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (expression: string, a: Step['options'] | StepFn, b?: StepFn) => {
    if (typeof a === 'function') steps.set(expression, { options: {}, fn: a })
    else steps.set(expression, { options: a, fn: b as StepFn })
  }
  return { ...actual, Given: register, When: register, Then: register }
})

import { registerStubSteps } from './stub.steps'
import { startCaptureServer } from './capture-server'

const run = (expression: string, ...args: unknown[]) => {
  const step = steps.get(expression)
  if (!step) throw new Error(`Step not registered: ${expression}`)
  return step.fn.call({}, ...args)
}

const get = (url: string) =>
  new Promise<number>((resolve, reject) => {
    http
      .get(url, { agent: false }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      .on('error', reject)
  })

describe('stub steps', async () => {
  const siem = await startCaptureServer({ kind: 'http' })
  afterAll(async () => {
    await siem.stop()
  })
  registerStubSteps({ siem }, { stubWaitTimeout: 400 })
  registerStubSteps({}) // a second call defines nothing more
  registerStubSteps({}, { stubWaitTimeout: 150 }) // and a later timeout wins

  it('scripts answers, counts requests and waits', async () => {
    run(
      'the {word} stub answers {int} once for requests matching {string}',
      'siem',
      503,
      'path=/in',
    )
    expect(await get(`${siem.url}/in`)).toBe(503)
    expect(await get(`${siem.url}/in`)).toBe(200)
    run('the {word} stub answers {int} for requests matching {string}', 'siem', 410, 'path=/gone')
    expect(await get(`${siem.url}/gone`)).toBe(410)
    run('the {word} stub saw {int} request(s) matching {string}', 'siem', 2, 'path=/in')
    expect(() =>
      run('the {word} stub saw {int} request(s) matching {string}', 'siem', 5, 'path=/in'),
    ).toThrow(/saw 2 requests.*expected 5/)
    const later = setTimeout(() => void get(`${siem.url}/late`), 50)
    await run(
      'I wait for the {word} stub to see {int} request(s) matching {string}',
      'siem',
      1,
      'path=/late',
    )
    clearTimeout(later)
    await expect(
      run(
        'I wait for the {word} stub to see {int} request(s) matching {string}',
        'siem',
        1,
        'path=/never',
      ),
    ).rejects.toThrow(/timed out/)
  })

  it('takes the stub down and up, and names a missing one', async () => {
    await run('the {word} stub is down', 'siem')
    await expect(get(siem.url)).rejects.toThrow(/ECONNREFUSED/)
    await run('the {word} stub is up', 'siem')
    expect(await get(siem.url)).toBe(200)
    await expect(run('the {word} stub is up', 'nope')).rejects.toThrow(/No stub named "nope".*siem/)
  })

  it('uses the latest stubWaitTimeout and leaves the step timeout to it', async () => {
    const wait = 'I wait for the {word} stub to see {int} request(s) matching {string}'
    expect(steps.get(wait)?.options.timeout).toBe(-1)
    const t = Date.now()
    await expect(run(wait, 'siem', 1, 'path=/never2')).rejects.toThrow(/timed out after 150ms/)
    expect(Date.now() - t).toBeLessThan(380)
  })
})
