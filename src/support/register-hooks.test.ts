import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type HookFn = (this: unknown, ...args: unknown[]) => unknown
interface Hook {
  options: { tags?: string; timeout?: number }
  fn: HookFn
}

// Capture what registerHooks registers so the tests can inspect and run it.
const cucumber = vi.hoisted(() => ({
  before: [] as Hook[],
  beforeAll: [] as Hook[],
  after: [] as Hook[],
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
    After: register(cucumber.after),
    AfterAll: vi.fn(),
    setWorldConstructor: vi.fn(),
    setDefaultTimeout: cucumber.setDefaultTimeout,
  }
})

vi.mock('@playwright/test', () => {
  playwright.loads++
  const page = { close: vi.fn(), url: () => 'about:blank' }
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
    cucumber.after.length = 0
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

describe('registerHooks lifecycle options (COMPONENT-9)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    cucumber.before.length = 0
    cucumber.beforeAll.length = 0
    cucumber.after.length = 0
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    vi.restoreAllMocks()
  })

  const world = () =>
    ({ resetScenario: vi.fn(), pageRegistry: new Map() }) as Record<string, unknown>
  const uiBefore = () => cucumber.before.find((h) => h.options.tags === '@ui')!
  const uiAfter = () => cucumber.after.find((h) => h.options.tags === '@ui')!
  const everyAfter = () => cucumber.after.find((h) => !h.options.tags)!

  it('runs afterReset after the reset, once baseline stubs are loaded', async () => {
    const order: string[] = []
    fetchSpy.mockImplementation(async (url: unknown) => {
      order.push(String(url).replace('http://wiremock.test', ''))
      return new Response('{}')
    })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-baseline-'))
    fs.mkdirSync(`${dir}/login/mappings`, { recursive: true })
    fs.writeFileSync(
      `${dir}/login/mappings/login.json`,
      JSON.stringify({ request: { url: '/login' } }),
    )

    registerHooks({
      fixturesDir: dir,
      wiremockUrl: 'http://wiremock.test',
      wiremockBaseline: ['login'],
      hooks: { afterReset: () => void order.push('afterReset') },
    })
    await scenarioHook().fn.call(world())

    expect(order).toEqual(['/__admin/reset', '/__admin/mappings/import', 'afterReset'])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('creates page objects from the pages option for @ui scenarios', async () => {
    class LoginPage {
      constructor(
        readonly page: unknown,
        readonly baseUrl: string,
      ) {}
    }
    registerHooks({
      ...baseOptions,
      webBaseUrl: 'http://web.test',
      pages: { login: LoginPage as never },
    })
    const w = world()
    await uiBefore().fn.call(w)

    const login = (w.pageRegistry as Map<string, LoginPage>).get('login')
    expect(login).toBeInstanceOf(LoginPage)
    expect(login).toMatchObject({ page: w.page, baseUrl: 'http://web.test' })
  })

  it('says pages needs webBaseUrl when the hooks are registered', () => {
    expect(() => registerHooks({ ...baseOptions, pages: { login: class {} as never } })).toThrow(
      'The pages option needs webBaseUrl',
    )
  })

  it('checks wiremockBaseline when the hooks are registered', () => {
    expect(() => registerHooks({ ...baseOptions, wiremockBaseline: ['login'] })).toThrow(
      'wiremockBaseline needs wiremockUrl',
    )
    expect(() =>
      registerHooks({
        ...baseOptions,
        wiremockUrl: 'http://wiremock.test',
        wiremockBaseline: ['nope'],
      }),
    ).toThrow(/wiremockBaseline directory has no mappings folder: .*nope\/mappings/)
  })

  it('cleans up even when onScenarioFailed throws, then reports its error', async () => {
    const cleanup = vi.fn()
    registerHooks({
      ...baseOptions,
      cleanup,
      hooks: {
        onScenarioFailed: () => {
          throw new Error('screenshot failed')
        },
      },
    })
    const close = vi.fn()
    const w = Object.assign(world(), { activeSubscription: { close } })
    await expect(
      everyAfter().fn.call(w, { pickle: { name: 'x', uri: 'x' }, result: { status: 'FAILED' } }),
    ).rejects.toThrow('screenshot failed')
    expect(close).toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledWith(w)
  })

  it('closes the page even when beforePageClose throws', async () => {
    registerHooks({
      ...baseOptions,
      hooks: {
        beforePageClose: () => {
          throw new Error('coverage failed')
        },
      },
    })
    const page = { close: vi.fn() }
    const browserContext = { close: vi.fn() }
    const w = Object.assign(world(), { page, browserContext })
    await expect(uiAfter().fn.call(w)).rejects.toThrow('coverage failed')
    expect(page.close).toHaveBeenCalled()
    expect(browserContext.close).toHaveBeenCalled()
    expect(w).toMatchObject({ page: null, browserContext: null })
  })

  it.each(['FAILED', 'UNDEFINED', 'AMBIGUOUS', 'PENDING'])(
    'calls onScenarioFailed for a %s result',
    async (status) => {
      const onScenarioFailed = vi.fn()
      registerHooks({ ...baseOptions, hooks: { onScenarioFailed } })
      await everyAfter().fn.call(world(), { pickle: { name: 'x', uri: 'x' }, result: { status } })
      expect(onScenarioFailed).toHaveBeenCalled()
    },
  )

  it('calls onScenarioFailed while the page is open, then beforePageClose, then closes the page', async () => {
    const order: string[] = []
    registerHooks({
      ...baseOptions,
      hooks: {
        onScenarioFailed: (_w, scenario) => void order.push(`failed: ${scenario.pickle.name}`),
        beforePageClose: (w) => void order.push(`beforePageClose, page open: ${w.page !== null}`),
      },
    })
    // Cucumber runs After hooks in reverse registration order.
    expect(cucumber.after.indexOf(everyAfter())).toBeGreaterThan(cucumber.after.indexOf(uiAfter()))

    const w = world()
    const page = { close: vi.fn(() => void order.push('page closed')) }
    Object.assign(w, { page, browserContext: { close: vi.fn() } })
    const scenario = {
      pickle: { name: 'checkout', uri: 'x.feature' },
      result: { status: 'FAILED' },
    }
    await everyAfter().fn.call(w, scenario)
    await uiAfter().fn.call(w, scenario)

    expect(order).toEqual(['failed: checkout', 'beforePageClose, page open: true', 'page closed'])
  })

  it('leaves onScenarioFailed alone when the scenario passed', async () => {
    const onScenarioFailed = vi.fn()
    registerHooks({ ...baseOptions, hooks: { onScenarioFailed } })
    await everyAfter().fn.call(world(), {
      pickle: { name: 'ok', uri: 'x' },
      result: { status: 'PASSED' },
    })
    expect(onScenarioFailed).not.toHaveBeenCalled()
  })

  it('runs the cleanup option after each scenario', async () => {
    const cleanup = vi.fn()
    registerHooks({ ...baseOptions, cleanup })
    const w = world()
    await everyAfter().fn.call(w, {
      pickle: { name: 'ok', uri: 'x' },
      result: { status: 'PASSED' },
    })
    expect(cleanup).toHaveBeenCalledWith(w)
  })
})
