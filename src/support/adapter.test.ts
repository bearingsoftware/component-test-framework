import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from 'vitest'

type HookFn = (this: unknown, ...args: unknown[]) => unknown
interface Hook {
  options: { tags?: string; timeout?: number }
  fn: HookFn
}

const cucumber = vi.hoisted(() => ({
  before: [] as Hook[],
  beforeAll: [] as Hook[],
  after: [] as Hook[],
  afterAll: [] as Hook[],
  log: [] as string[],
}))

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (into: Hook[], tag: string) => (a: Hook['options'] | HookFn, b?: HookFn) => {
    cucumber.log.push(tag)
    if (typeof a === 'function') into.push({ options: {}, fn: a })
    else into.push({ options: a, fn: b as HookFn })
  }
  return {
    ...actual,
    Before: register(cucumber.before, 'Before'),
    BeforeAll: register(cucumber.beforeAll, 'BeforeAll'),
    After: register(cucumber.after, 'After'),
    AfterAll: register(cucumber.afterAll, 'AfterAll'),
    setWorldConstructor: vi.fn(),
    setDefaultTimeout: vi.fn(),
  }
})

import { registerHooks } from './hooks'
import { defineAdapter, registerAdapter } from './adapter'
import type { Adapter } from './adapter'
import { ComponentTestWorld } from './world'
import { redisAdapter } from '../adapters/redis'
import type { RedisClient } from '../clients/redis-client'

const baseOptions = { fixturesDir: './fixtures' }
const passed = { pickle: { name: 'x', uri: 'x' }, result: { status: 'PASSED' } }
const failedScenario = { pickle: { name: 'x', uri: 'x' }, result: { status: 'FAILED' } }

const world = () =>
  ({ resetScenario: vi.fn(), pageRegistry: new Map() }) as unknown as ComponentTestWorld &
    Record<string, unknown>

let calls: string[]

/** An adapter that records each hook it gets, and can be made to throw in one. */
function fake(name: string, throwIn?: string): Adapter<{ name: string }> {
  const record = (hook: string) => () => {
    calls.push(`${name}.${hook}`)
    if (throwIn === hook) throw new Error(`${name}.${hook} failed`)
  }
  return defineAdapter({
    name,
    validate: record('validate'),
    setup: () => {
      record('setup')()
      return { name }
    },
    registerSteps: record('registerSteps'),
    beforeAll: record('beforeAll'),
    beforeScenario: record('beforeScenario'),
    onScenarioFailed: record('onScenarioFailed'),
    afterScenario: record('afterScenario'),
    afterAll: record('afterAll'),
  })
}

const everyBefore = () => cucumber.before.find((h) => !h.options.tags)!
const everyAfter = () => cucumber.after.find((h) => !h.options.tags)!

describe('adapters', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    for (const hooks of [cucumber.before, cucumber.beforeAll, cucumber.after, cucumber.afterAll]) {
      hooks.length = 0
    }
    cucumber.log.length = 0
    calls = []
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      calls.push(`fetch ${String(url).replace('http://wm.test/__admin', '')}`)
      return new Response('{}')
    })
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    vi.restoreAllMocks()
  })

  describe('registration order', () => {
    it('validates all, then sets up all, then registers steps, in array order', () => {
      registerHooks({ ...baseOptions, adapters: [fake('a'), fake('b')] })
      expect(calls).toEqual([
        'a.validate',
        'b.validate',
        'a.setup',
        'b.setup',
        'a.registerSteps',
        'b.registerSteps',
      ])
    })

    it('runs consumer adapters after the built-in ones, which come from config', async () => {
      registerHooks({ ...baseOptions, wiremockUrl: 'http://wm.test', adapters: [fake('a')] })
      calls.length = 0
      await everyBefore().fn.call(world())
      expect(calls).toEqual(['fetch /reset', 'a.beforeScenario'])
    })

    it('throws on a duplicate adapter name', () => {
      expect(() => registerHooks({ ...baseOptions, adapters: [fake('a'), fake('a')] })).toThrow(
        'Adapter "a" is registered twice.',
      )
    })

    it('lets a validate throw surface from registerHooks, before any setup', () => {
      expect(() =>
        registerHooks({ ...baseOptions, adapters: [fake('a', 'validate'), fake('b')] }),
      ).toThrow('a.validate failed')
      expect(calls).not.toContain('a.setup')
    })

    it('keeps the built-in configuration errors and their messages', () => {
      expect(() => registerHooks({ ...baseOptions, wiremockBaseline: ['x'] })).toThrow(
        'wiremockBaseline needs wiremockUrl: set WIREMOCK_URL or pass wiremockUrl.',
      )
      expect(() => registerHooks({ ...baseOptions, pages: { p: class {} as never } })).toThrow(
        'The pages option needs webBaseUrl',
      )
    })
  })

  describe('BeforeAll', () => {
    it('runs in adapter order, with the default and the adapter-set timeout', async () => {
      const slow = defineAdapter({
        name: 'slow',
        beforeAllTimeout: 5_000,
        beforeAll: () => void calls.push('slow'),
      })
      registerHooks({ ...baseOptions, adapters: [fake('a'), slow] })
      expect(cucumber.beforeAll.map((h) => h.options.timeout)).toEqual([30_000, 5_000])
      calls.length = 0
      for (const hook of cucumber.beforeAll) await hook.fn.call({})
      expect(calls).toEqual(['a.beforeAll', 'slow'])
    })

    it('puts consumer adapters after the built-in WireMock wait', async () => {
      registerHooks({ ...baseOptions, wiremockUrl: 'http://wm.test', adapters: [fake('a')] })
      expect(cucumber.beforeAll.map((h) => h.options.timeout)).toEqual([30_000, 30_000])
      calls.length = 0
      for (const hook of cucumber.beforeAll) await hook.fn.call({})
      expect(calls).toEqual(['fetch /health', 'a.beforeAll'])
    })
  })

  describe('Before', () => {
    it('wires the world and resets first, then adapters in order, then afterReset', async () => {
      const w = world()
      ;(w.resetScenario as ReturnType<typeof vi.fn>).mockImplementation(() => calls.push('reset'))
      registerHooks({
        ...baseOptions,
        adapters: [fake('a'), fake('b')],
        hooks: { afterReset: () => void calls.push('afterReset') },
      })
      calls.length = 0
      await everyBefore().fn.call(w)
      expect(calls).toEqual(['reset', 'a.beforeScenario', 'b.beforeScenario', 'afterReset'])
      expect(w.config).toBeDefined()
    })

    it('stops at the first throw, so nothing after it runs', async () => {
      registerHooks({
        ...baseOptions,
        adapters: [fake('a', 'beforeScenario'), fake('b')],
        hooks: { afterReset: () => void calls.push('afterReset') },
      })
      calls.length = 0
      await expect(everyBefore().fn.call(world())).rejects.toThrow('a.beforeScenario failed')
      expect(calls).toEqual(['a.beforeScenario'])
    })

    it('registers the @ui Before after the scenario Before', () => {
      registerHooks(baseOptions)
      expect(cucumber.before.map((h) => h.options.tags)).toEqual([undefined, '@ui'])
    })
  })

  describe('After', () => {
    it('runs failure hooks, then afterScenario in reverse order, then cleanup', async () => {
      registerHooks({
        ...baseOptions,
        adapters: [fake('a'), fake('b')],
        hooks: { onScenarioFailed: () => void calls.push('hooks.onScenarioFailed') },
        cleanup: () => void calls.push('cleanup'),
      })
      calls.length = 0
      await everyAfter().fn.call(world(), failedScenario)
      expect(calls).toEqual([
        'hooks.onScenarioFailed',
        'a.onScenarioFailed',
        'b.onScenarioFailed',
        'b.afterScenario',
        'a.afterScenario',
        'cleanup',
      ])
    })

    it('skips the failure hooks when the scenario passed', async () => {
      registerHooks({ ...baseOptions, adapters: [fake('a')] })
      calls.length = 0
      await everyAfter().fn.call(world(), passed)
      expect(calls).toEqual(['a.afterScenario'])
    })

    it('runs consumer adapters, then Redis subscriptions, then cleanup', async () => {
      const order: string[] = []
      const sub = { close: vi.fn(async () => void order.push('subscription')) }
      const consumer = defineAdapter({
        name: 'c',
        afterScenario: () => void order.push('consumer'),
      })
      registerHooks({
        ...baseOptions,
        adapters: [consumer],
        cleanup: () => void order.push('cleanup'),
      })
      await everyAfter().fn.call(Object.assign(world(), { activeSubscription: sub }), passed)
      expect(order).toEqual(['consumer', 'subscription', 'cleanup'])
    })

    it('runs every step when one throws, then rethrows the first error', async () => {
      registerHooks({
        ...baseOptions,
        adapters: [fake('a'), fake('b', 'afterScenario'), fake('c', 'afterScenario')],
        cleanup: () => void calls.push('cleanup'),
      })
      calls.length = 0
      await expect(everyAfter().fn.call(world(), passed)).rejects.toThrow('c.afterScenario failed')
      expect(calls).toEqual(['c.afterScenario', 'b.afterScenario', 'a.afterScenario', 'cleanup'])
    })

    it('reports the failure hook error first when a later step throws too', async () => {
      registerHooks({
        ...baseOptions,
        adapters: [fake('a', 'afterScenario')],
        hooks: {
          onScenarioFailed: () => {
            throw new Error('screenshot failed')
          },
        },
      })
      await expect(everyAfter().fn.call(world(), failedScenario)).rejects.toThrow(
        'screenshot failed',
      )
    })
  })

  describe('AfterAll', () => {
    it('runs in reverse adapter order', async () => {
      registerHooks({ ...baseOptions, adapters: [fake('a'), fake('b')] })
      calls.length = 0
      await cucumber.afterAll[0].fn.call({})
      expect(calls).toEqual(['b.afterAll', 'a.afterAll'])
    })

    it('runs every step when one throws, then rethrows the first error', async () => {
      registerHooks({
        ...baseOptions,
        adapters: [fake('a'), fake('b', 'afterAll'), fake('c', 'afterAll')],
      })
      calls.length = 0
      await expect(cucumber.afterAll[0].fn.call({})).rejects.toThrow('c.afterAll failed')
      expect(calls).toEqual(['c.afterAll', 'b.afterAll', 'a.afterAll'])
    })
  })

  describe('world.adapter', () => {
    const newWorld = () =>
      new ComponentTestWorld({ attach: vi.fn(), log: vi.fn(), parameters: {} } as never)

    it('returns the state setup made, typed through the generic', () => {
      const counter = defineAdapter({ name: 'counter', setup: () => ({ count: 3 }) })
      const none = defineAdapter({ name: 'none' })
      registerHooks({ ...baseOptions, adapters: [counter, none] })
      const w = newWorld()
      const state = w.adapter(counter)
      expect(state).toEqual({ count: 3 })
      expectTypeOf(state).toEqualTypeOf<{ count: number }>()
      expectTypeOf(w.adapter(none)).toEqualTypeOf<undefined>()
    })

    it('types the Redis adapter state as possibly undefined', () => {
      expectTypeOf(redisAdapter({ url: '' })).toEqualTypeOf<Adapter<RedisClient | undefined>>()
    })

    it('throws, naming the adapter, when it is not registered', () => {
      expect(() => newWorld().adapter(defineAdapter({ name: 'ghost' }))).toThrow(
        /Adapter "ghost" isn't registered/,
      )
    })
  })

  describe('registerAdapter', () => {
    it('registers the adapter hooks in place and returns its state', async () => {
      const adapter = defineAdapter({
        name: 'standalone',
        setup: () => ({ ok: true }),
        beforeAll: () => void calls.push('beforeAll'),
        beforeScenario: () => void calls.push('beforeScenario'),
        afterScenario: () => void calls.push('afterScenario'),
        afterAll: () => void calls.push('afterAll'),
        afterAllTimeout: 15_000,
      })
      cucumber.log.push('first')
      const state = registerAdapter(adapter)
      cucumber.log.push('last')

      expect(state).toEqual({ ok: true })
      expect(cucumber.log).toEqual(['first', 'BeforeAll', 'Before', 'After', 'AfterAll', 'last'])
      expect(cucumber.afterAll[0].options.timeout).toBe(15_000)
      await cucumber.beforeAll[0].fn.call({})
      await cucumber.before[0].fn.call(world())
      await cucumber.after[0].fn.call(world(), passed)
      await cucumber.afterAll[0].fn.call({})
      expect(calls).toEqual(['beforeAll', 'beforeScenario', 'afterScenario', 'afterAll'])
    })

    it('tolerates registerSpaServer and registerCoverage being called twice, as before', async () => {
      const { registerSpaServer } = await import('../spa/server')
      const { registerCoverage } = await import('../spa/coverage')
      const spa = { distDir: '.', apiUrl: 'http://wm.test', defaultPort: 4200 }
      expect(() => {
        registerSpaServer(spa)
        registerSpaServer(spa)
        registerCoverage({ outDir: 'out' })
        registerCoverage({ outDir: 'out' })
      }).not.toThrow()
    })
  })
})
