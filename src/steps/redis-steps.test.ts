import { describe, it, expect, vi } from 'vitest'
import { DataTable } from '@cucumber/cucumber'
import { MessageQueue } from '../clients/message-queue'

type StepFn = (this: unknown, ...args: unknown[]) => unknown

// Capture step definitions so the real steps run without a Cucumber runtime.
const steps = vi.hoisted(() => new Map<string, StepFn>())
const stepOptions = vi.hoisted(() => new Map<string, unknown>())

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (expression: string, optionsOrFn: unknown, maybeFn?: StepFn) => {
    // A second definition of one expression is what Cucumber reports as ambiguous.
    if (steps.has(expression)) throw new Error(`Registered twice: ${expression}`)
    steps.set(expression, (typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn) as StepFn)
    if (typeof optionsOrFn !== 'function') stepOptions.set(expression, optionsOrFn)
  }
  return { ...actual, Given: register, When: register, Then: register }
})

import { defineRedisSteps } from './common/redis.steps'

defineRedisSteps()

const run = (world: unknown, expression: string, ...args: unknown[]) => {
  const step = steps.get(expression)
  if (!step) throw new Error(`Step not registered: ${expression}`)
  return step.apply(world, args)
}

/** A subscription over a queue the test pushes messages into. */
function fakeSubscription(describe: string) {
  const queue = new MessageQueue(describe)
  const sub = {
    queue,
    waitForMessage: (p?: unknown, t?: number) =>
      typeof p === 'function'
        ? queue.next(p as never, t ?? 30_000)
        : queue.next(undefined, (p as number) ?? 30_000),
    close: vi.fn(),
  }
  return sub
}

function fakeWorld() {
  const subs: ReturnType<typeof fakeSubscription>[] = []
  const redis = {
    subscribe: vi.fn(async (c: string) => {
      subs.push(fakeSubscription(c))
      return subs.at(-1)
    }),
    psubscribe: vi.fn(async (p: string) => {
      subs.push(fakeSubscription(`pattern ${p}`))
      return subs.at(-1)
    }),
    publish: vi.fn().mockResolvedValue(1),
    publishUntilHeard: vi.fn().mockResolvedValue(1),
    waitForValue: vi.fn().mockResolvedValue('{"ok":true}'),
  }
  const world = {
    config: { serviceWaitTimeout: 100 },
    redis,
    subscriptions: [] as unknown[],
    activeSubscription: undefined as unknown,
    lastRedisMessage: undefined as string | undefined,
    lastRedisValue: undefined as string | undefined,
  }
  return { world, redis, subs }
}

const RECEIVE = 'I receive a message on the subscribed Valkey channel/pattern'

describe('Valkey pub/sub steps (COMPONENT-15)', () => {
  it('subscribes by pattern, tracks the subscription and receives without closing it', async () => {
    const { world, redis, subs } = fakeWorld()
    await run(world, 'I subscribe to Valkey pattern {string}', 'events:*')
    expect(redis.psubscribe).toHaveBeenCalledWith('events:*')
    expect(world.subscriptions).toEqual([subs[0]])
    expect(world.activeSubscription).toBe(subs[0])

    subs[0].queue.push({ pattern: 'events:*', channel: 'events:1', message: 'one' })
    subs[0].queue.push({ pattern: 'events:*', channel: 'events:1', message: 'two' })
    await run(world, RECEIVE)
    expect(world.lastRedisMessage).toBe('one')
    await run(world, RECEIVE)
    expect(world.lastRedisMessage).toBe('two')
    expect(subs[0].close).not.toHaveBeenCalled()
  })

  it('keeps every subscription so the After hook can close them all', async () => {
    const { world, subs } = fakeWorld()
    await run(world, 'I subscribe to Valkey channel {string}', 'a')
    await run(world, 'I subscribe to Valkey pattern {string}', 'b:*')
    expect(world.subscriptions).toEqual(subs)
    expect(world.activeSubscription).toBe(subs[1])
  })

  it('skips to the message with the wanted type, ignoring non-JSON', async () => {
    const { world, subs } = fakeWorld()
    await run(world, 'I subscribe to Valkey channel {string}', 'events')
    for (const message of ['not json', '{"type":"reading"}', '{"type":"optimiser","n":1}']) {
      subs[0].queue.push({ channel: 'events', message })
    }
    await run(
      world,
      'I receive a message with type {string} on the subscribed Valkey channel/pattern',
      'optimiser',
    )
    expect(world.lastRedisMessage).toBe('{"type":"optimiser","n":1}')
  })

  it('receives the first message whose JSON partially matches, inline or as a doc string', async () => {
    const { world, subs } = fakeWorld()
    await run(world, 'I subscribe to Valkey channel {string}', 'events')
    subs[0].queue.push({ channel: 'events', message: '{"type":"a","user":{"id":1}}' })
    subs[0].queue.push({ channel: 'events', message: '{"type":"a","user":{"id":2},"x":1}' })
    subs[0].queue.push({ channel: 'events', message: '{"type":"b"}' })
    await run(world, `${RECEIVE} matching JSON {string}`, '{"user":{"id":2}}')
    expect(world.lastRedisMessage).toBe('{"type":"a","user":{"id":2},"x":1}')
    await run(world, `${RECEIVE} matching JSON:`, '{\n  "type": "b"\n}')
    expect(world.lastRedisMessage).toBe('{"type":"b"}')
  })

  it('matches a table of paths and values, reading values as JSON when they parse', async () => {
    const { world, subs } = fakeWorld()
    await run(world, 'I subscribe to Valkey channel {string}', 'events')
    subs[0].queue.push({ channel: 'events', message: '{"user":{"id":"7"},"items":[{"n":3}]}' })
    subs[0].queue.push({
      channel: 'events',
      message: '{"user":{"id":7},"items":[{"n":3}],"ok":true}',
    })
    const table = new DataTable([
      ['user.id', '7'],
      ['items[0].n', '3'],
      ['ok', 'true'],
    ])
    await run(world, `${RECEIVE} with fields:`, table)
    expect(world.lastRedisMessage).toBe('{"user":{"id":7},"items":[{"n":3}],"ok":true}')
  })

  it('fails after serviceWaitTimeout, saying what arrived that did not match', async () => {
    const { world, subs } = fakeWorld()
    await run(world, 'I subscribe to Valkey pattern {string}', 'events:*')
    subs[0].queue.push({ channel: 'events:1', message: '{"type":"reading"}' })
    await expect(
      run(
        world,
        'I receive a message with type {string} on the subscribed Valkey channel/pattern',
        'x',
      ),
    ).rejects.toThrow(
      /Timed out after 100ms waiting for a pub\/sub message on pattern events:\*; 1 message\(s\) arrived/,
    )
  })

  it('says to subscribe first', async () => {
    const { world } = fakeWorld()
    await expect(run(world, RECEIVE)).rejects.toThrow(/no active subscription/)
  })

  it('still waits for a message on a channel and closes that subscription', async () => {
    const { world, subs } = fakeWorld()
    const waiting = run(world, 'I wait for a message on Valkey channel {string}', 'once')
    await vi.waitFor(() => expect(subs).toHaveLength(1))
    subs[0].queue.push({ channel: 'once', message: 'hi' })
    await waiting
    expect(world.lastRedisMessage).toBe('hi')
    expect(subs[0].close).toHaveBeenCalled()
    expect(world.subscriptions).toEqual([])
  })

  it('publishes inline, as a doc string, and until heard', async () => {
    const { world, redis } = fakeWorld()
    await run(world, 'I publish {string} to Valkey channel {string}', 'hi', 'chan')
    await run(world, 'I publish to Valkey channel {string}:', 'chan', '{"a":1}')
    expect(redis.publish.mock.calls).toEqual([
      ['chan', 'hi'],
      ['chan', '{"a":1}'],
    ])
    await run(
      world,
      'I publish {string} to Valkey channel {string} until a subscriber hears it',
      'go',
      'chan',
    )
    expect(redis.publishUntilHeard).toHaveBeenCalledWith('chan', 'go', { timeoutMs: 100 })
  })

  it('waits for a key to contain matching JSON', async () => {
    const { world, redis } = fakeWorld()
    await run(
      world,
      'the Valkey key {string} eventually contains JSON matching {string}',
      'k',
      '{"ok":true}',
    )
    await run(
      world,
      'the Valkey key {string} eventually contains JSON matching:',
      'k',
      '{"ok": true}',
    )
    expect(redis.waitForValue.mock.calls).toEqual([
      ['k', { ok: true }, { timeoutMs: 100 }],
      ['k', { ok: true }, { timeoutMs: 100 }],
    ])
    expect(world.lastRedisValue).toBe('{"ok":true}')
    await expect(
      run(world, 'the Valkey key {string} eventually contains JSON matching {string}', 'k', '{bad'),
    ).rejects.toThrow(/expected JSON is malformed/)
  })

  it('gives each waiting step a Cucumber timeout 1s past the 30s default wait, once', () => {
    // Registered above with no options; a second call adds nothing.
    defineRedisSteps({ serviceWaitTimeout: 5_000 })
    const waiting = [
      'I wait for the Valkey key {string} to be set',
      'the Valkey key {string} eventually contains JSON matching {string}',
      'the Valkey key {string} eventually contains JSON matching:',
      'I wait for a message on Valkey channel {string}',
      RECEIVE,
      'I receive a message with type {string} on the subscribed Valkey channel/pattern',
      `${RECEIVE} matching JSON {string}`,
      `${RECEIVE} matching JSON:`,
      `${RECEIVE} with fields:`,
      'I publish {string} to Valkey channel {string} until a subscriber hears it',
    ]
    for (const expression of waiting) {
      expect(stepOptions.get(expression), expression).toEqual({ timeout: 31_000 })
    }
    expect(stepOptions.has('the Valkey key {string} exists')).toBe(false)
  })

  it("caps the suite's serviceWaitTimeout at the step's budget, so the wait fails first", async () => {
    const { world } = fakeWorld()
    world.config = { serviceWaitTimeout: 60_000 }
    await run(
      world,
      'I publish {string} to Valkey channel {string} until a subscriber hears it',
      'x',
      'c',
    )
    expect(world.redis.publishUntilHeard).toHaveBeenCalledWith('c', 'x', { timeoutMs: 30_000 })
  })
})
