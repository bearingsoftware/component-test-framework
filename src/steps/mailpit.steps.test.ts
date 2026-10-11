import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'http'
import type { AddressInfo } from 'net'

type StepFn = (this: unknown, ...args: unknown[]) => unknown
interface Step {
  options: { timeout?: number }
  fn: StepFn
}

// Capture step definitions by expression so the real step functions can run
// without a Cucumber runtime.
const steps = vi.hoisted(() => new Map<string, Step>())

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (
    expression: string,
    optionsOrFn: Step['options'] | StepFn,
    maybeFn?: StepFn,
  ) => {
    if (typeof optionsOrFn === 'function') steps.set(expression, { options: {}, fn: optionsOrFn })
    else steps.set(expression, { options: optionsOrFn, fn: maybeFn as StepFn })
  }
  return { ...actual, Given: register, When: register, Then: register }
})

import { registerMailpitSteps, LAST_EMAIL, LAST_EMAIL_LINK } from './mailpit.steps'
import { ComponentTestWorld } from '../support/world'

const BUDGET = 300

const run = (world: unknown, expression: string, ...args: unknown[]) => {
  const step = steps.get(expression)
  if (!step) throw new Error(`Step not registered: ${expression}`)
  return step.fn.apply(world, args)
}

interface Stored {
  ID: string
  To: { Name: string; Address: string }[]
  Subject: string
  Text: string
  HTML: string
}

describe('Mailpit steps (COMPONENT-16)', () => {
  let server: http.Server
  let store: Stored[]

  const send = (to: string, Subject: string, Text = '', HTML = '') =>
    store.push({
      ID: String(store.length + 1),
      To: [{ Name: '', Address: to }],
      Subject,
      Text,
      HTML,
    })

  const world = () => {
    const w = new ComponentTestWorld({
      attach: vi.fn(),
      log: vi.fn(),
      link: vi.fn(),
      parameters: {},
    } as never)
    w.remember('ownerEmail', 'owner@x.test')
    return w
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://mailpit.test')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (url.pathname === '/api/v1/search') {
        const to = /to:(\S+)/.exec(url.searchParams.get('query') ?? '')?.[1] ?? ''
        const messages = store.filter((m) => m.To.some((a) => a.Address === to)).reverse()
        return res.end(JSON.stringify({ messages }))
      }
      const id = /^\/api\/v1\/message\/(.+)$/.exec(url.pathname)?.[1]
      res.end(JSON.stringify(store.find((m) => m.ID === id)))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    registerMailpitSteps({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      serviceWaitTimeout: BUDGET,
      // "the owner" is the address the scenario kept; anything else is literal.
      recipient: (w, name) => (name === 'the owner' ? w.recall<string>('ownerEmail') : name),
    })
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  beforeEach(() => {
    store = []
  })

  it('registers once, with step timeouts just over the wait', () => {
    const before = steps.size
    registerMailpitSteps()
    expect(steps.size).toBe(before)
    expect(
      steps.get('an email to {string} eventually arrives whose subject contains {string}')?.options
        .timeout,
    ).toBe(BUDGET + 1_000)
    expect(
      steps.get('exactly {int} email(s) arrive(s) for {string} within {int}s')?.options.timeout,
    ).toBe(-1)
  })

  it('finds an email by subject for a mapped recipient, and keeps it', async () => {
    const w = world()
    setTimeout(() => send('owner@x.test', 'Your sign-in link', 'Hello'), 50)
    await run(
      w,
      'an email to {string} eventually arrives whose subject contains {string}',
      'the owner',
      'sign-in',
    )
    expect(w.recall<{ Subject: string }>(LAST_EMAIL).Subject).toBe('Your sign-in link')
  })

  it('finds an email by body', async () => {
    const w = world()
    send('a@x.test', 'One', 'nothing here')
    send('a@x.test', 'Two', 'your code is 123456')
    await run(
      w,
      'an email to {string} eventually arrives containing {string}',
      'a@x.test',
      'code is',
    )
    expect(w.recall<{ Subject: string }>(LAST_EMAIL).Subject).toBe('Two')
  })

  it('fails within the budget when no email arrives', async () => {
    const started = Date.now()
    await expect(
      run(
        world(),
        'an email to {string} eventually arrives whose subject contains {string}',
        'b@x.test',
        'Hi',
      ),
    ).rejects.toThrow(/no email to b@x.test has arrived/)
    expect(Date.now() - started).toBeLessThan(BUDGET + 500)
  })

  it('checks the kept email, and says to find one first', async () => {
    const w = world()
    expect(() => run(w, 'that email contains {string}', 'x')).toThrow(/No email found yet/)
    send('a@x.test', 'Hi', 'plain', '<p>Fish &amp; chips</p>')
    await run(
      w,
      'an email to {string} eventually arrives whose subject contains {string}',
      'a@x.test',
      'Hi',
    )
    run(w, 'that email contains {string}', 'Fish & chips')
    expect(() => run(w, 'that email contains {string}', 'peas')).toThrow(
      /the email "Hi" doesn't contain "peas"/,
    )
  })

  it('keeps the first link matching the pattern', async () => {
    const w = world()
    send(
      'a@x.test',
      'Verify',
      '',
      '<a href="https://app.test/help">Help</a><a href="https://app.test/verify?token=abc&amp;u=1">Go</a>',
    )
    await run(
      w,
      'an email to {string} eventually arrives whose subject contains {string}',
      'a@x.test',
      'Verify',
    )
    run(w, 'that email has a link matching {string}', '/verify\\?token=')
    expect(w.recall(LAST_EMAIL_LINK)).toBe('https://app.test/verify?token=abc&u=1')
    expect(() => run(w, 'that email has a link matching {string}', 'reset')).toThrow(
      /no link matching \/reset\/. Its links: https:\/\/app.test\/help, https:\/\/app.test\/verify/,
    )
  })

  it('passes when exactly N arrive within the window', async () => {
    send('a@x.test', 'One')
    setTimeout(() => send('a@x.test', 'Two'), 100)
    await run(
      world(),
      'exactly {int} email(s) arrive(s) for {string} within {int}s',
      2,
      'a@x.test',
      1,
    )
  })

  it('fails as soon as one too many arrives', async () => {
    send('a@x.test', 'One')
    setTimeout(() => send('a@x.test', 'Two'), 100)
    const started = Date.now()
    await expect(
      run(world(), 'exactly {int} email(s) arrive(s) for {string} within {int}s', 1, 'a@x.test', 5),
    ).rejects.toThrow(/2 emails to a@x.test arrived, expected 1/)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('fails when too few arrive by the end of the window', async () => {
    await expect(
      run(world(), 'exactly {int} email(s) arrive(s) for {string} within {int}s', 1, 'a@x.test', 0),
    ).rejects.toThrow(/0 emails to a@x.test arrived, expected 1/)
  })
})
