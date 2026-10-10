import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type StepFn = (this: unknown, ...args: unknown[]) => unknown

// Capture step definitions so the real steps run without a Cucumber runtime.
const steps = vi.hoisted(() => new Map<string, StepFn>())

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (expression: string, optionsOrFn: unknown, maybeFn?: StepFn) => {
    steps.set(expression, (typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn) as StepFn)
  }
  return { ...actual, Given: register, When: register, Then: register }
})

import './common/response-assertion.steps'
import './common/redis.steps'
import './worker/generic-service.steps'

const run = (world: unknown, expression: string, ...args: unknown[]) => {
  const step = steps.get(expression)
  if (!step) throw new Error(`Step not registered: ${expression}`)
  return step.apply(world, args)
}

// The three steps that compare JSON shared one matcher in this change, but
// they disagreed about null in the expectation, and each keeps its own rule:
// the response body step requires null to match null; the service and
// Valkey steps treat null as "any value".
describe('null in an expectation, per step (COMPONENT-6)', () => {
  let fixturesDir: string

  beforeAll(() => {
    fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-match-'))
    for (const dir of ['requests', 'responses']) fs.mkdirSync(path.join(fixturesDir, dir))
    fs.writeFileSync(path.join(fixturesDir, 'requests', 'empty.json'), '{}')
    fs.writeFileSync(
      path.join(fixturesDir, 'responses', 'with-null.json'),
      JSON.stringify({ id: 1, note: null }),
    )
  })

  afterAll(() => fs.rmSync(fixturesDir, { recursive: true, force: true }))

  it('the response body step requires null to match null', () => {
    const world = {
      config: { fixturesDir },
      lastResponse: { status: 200, body: { id: 1, note: 'set' }, headers: {} },
    }
    expect(() => run(world, 'the response body should match {word}', 'with-null')).toThrow(
      /Mismatch at note/,
    )
  })

  it('the service step treats null as any value', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 1, note: 'set' })))
    const world = {
      config: { apiBaseUrl: 'http://api.test', fixturesDir },
      operationMap: { getThing: { method: 'GET', path: '/thing' } },
      accessToken: null,
      trackCall: vi.fn(),
    }
    try {
      await run(
        world,
        'the service {word} is called with the request {word} it returns the response {word}',
        'getThing',
        'empty',
        'with-null',
      )
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('the Valkey step treats null as any value', async () => {
    const world = {
      redis: { get: vi.fn().mockResolvedValue(JSON.stringify({ id: 1, note: 'set' })) },
    }
    await run(
      world,
      'the Valkey key {string} contains JSON matching {string}',
      'k',
      '{"id":1,"note":null}',
    )
  })
})
