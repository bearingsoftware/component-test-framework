import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type HookFn = (this: unknown, ...args: unknown[]) => unknown
interface Hook {
  options: { tags?: string; timeout?: number }
  fn: HookFn
}

// Capture what registerHooks registers so the tests can inspect and run it.
const cucumber = vi.hoisted(() => ({
  before: [] as Hook[],
  beforeAll: [] as Hook[],
  setDefaultTimeout: vi.fn(),
}))

// Count Playwright loads, to check it's only loaded when a @ui scenario runs.
const playwright = vi.hoisted(() => ({ loads: 0 }))

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (into: Hook[]) => (optionsOrFn: Hook['options'] | HookFn, maybeFn?: HookFn) => {
    if (typeof optionsOrFn === 'function') into.push({ options: {}, fn: optionsOrFn })
    else into.push({ options: optionsOrFn, fn: maybeFn as HookFn })
  }
  return {
    ...actual,
    Before: register(cucumber.before),
    BeforeAll: register(cucumber.beforeAll),
    After: vi.fn(),
    AfterAll: vi.fn(),
    setWorldConstructor: vi.fn(),
    setDefaultTimeout: cucumber.setDefaultTimeout,
  }
})

vi.mock('@playwright/test', () => {
  playwright.loads++
  const page = { close: vi.fn() }
  const context = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn() }
  const browser = { isConnected: () => true, newContext: vi.fn().mockResolvedValue(context) }
  return { chromium: { launch: vi.fn().mockResolvedValue(browser) } }
})

import { registerHooks } from './hooks'

const baseOptions = { fixturesDir: './fixtures' }

const fakeWorld = () => ({ resetScenario: vi.fn() }) as Record<string, unknown>

const scenarioHook = () => {
  const hook = cucumber.before.find((h) => !h.options.tags)
  if (!hook) throw new Error('scenario Before hook not registered')
  return hook
}

describe('registerHooks (COMPONENT-5)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    cucumber.before.length = 0
    cucumber.beforeAll.length = 0
    cucumber.setDefaultTimeout.mockClear()
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('sets the default step timeout when asked', () => {
    registerHooks({ ...baseOptions, defaultStepTimeout: 60_000 })
    expect(cucumber.setDefaultTimeout).toHaveBeenCalledWith(60_000)
  })

  it("leaves the suite's own timeout alone when not asked", () => {
    registerHooks(baseOptions)
    expect(cucumber.setDefaultTimeout).not.toHaveBeenCalled()
  })

  it('runs without WireMock or an API configured', async () => {
    registerHooks(baseOptions)
    const world = fakeWorld()

    await scenarioHook().fn.call(world)

    expect(cucumber.beforeAll).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(world.config).toMatchObject({ apiBaseUrl: '', wiremockUrl: '' })
  })

  it('waits for and resets WireMock when it is configured', async () => {
    registerHooks({ ...baseOptions, wiremockUrl: 'http://wiremock.test' })

    await scenarioHook().fn.call(fakeWorld())

    expect(cucumber.beforeAll).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://wiremock.test/__admin/reset',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    )
  })

  it('warns when wiremockStubsDir does not exist', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    registerHooks({ ...baseOptions, wiremockStubsDir: '/no/such/dir' })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/no/such/dir'))
  })

  it('only loads Playwright when a @ui scenario starts', async () => {
    registerHooks(baseOptions)
    expect(playwright.loads).toBe(0)

    const uiHook = cucumber.before.find((h) => h.options.tags === '@ui')
    const world = fakeWorld()
    await uiHook?.fn.call(world)

    expect(playwright.loads).toBe(1)
    expect(world.page).toBeTruthy()
  })
})
