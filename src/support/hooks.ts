import { Before, After, AfterAll, setDefaultTimeout, setWorldConstructor } from '@cucumber/cucumber'
import type { ITestCaseHookParameter } from '@cucumber/cucumber'
import { debuglog } from 'node:util'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { ComponentTestWorld } from './world'
import type { FrameworkConfig, FrameworkOptions } from '../types'
import { currentWorker, setWorkerPortStride, workerDatabaseUrl, workerRedisUrl } from './worker'
import {
  initAdapters,
  beforeAllHooks,
  runBeforeScenario,
  runAll,
  afterScenarioSteps,
  teardownSteps,
  afterAllSteps,
  failed,
} from './adapter'
import { markHooksRegistered } from './hooks-state'
import type { AdapterContext } from './adapter'
import { builtinAdapters } from '../adapters/builtin'

/**
 * Register framework hooks with Cucumber. Call this once in the consumer's
 * support setup file, passing the project-specific configuration.
 *
 * @example
 * ```typescript
 * // support/setup.ts
 * import { registerHooks, loadConfig } from 'component-test-framework'
 * import { operationMap } from './operation-map'
 *
 * registerHooks({
 *   ...loadConfig(),
 *   operationMap,
 *   cleanupTables: ['users', 'integrations', 'readings'],
 * })
 * ```
 */
// SECREPO-602: one browser per worker, not one per scenario.
//
// A suite of 65 @ui scenarios meant 65 chromium.launch() and 65 browser.close()
// calls, and launching a browser is the part of this that suffers most under
// CPU contention. It showed up as a scenario whose every step passed failing in
// teardown, because closing Chromium took longer than the suite's 30s hook
// timeout while the host was at a load average of 101-180.
//
// Cucumber runs each parallel worker with its own module instances (a child
// process up to v12, a worker thread from v13), so this is per worker rather
// than global — the isolation that matters between scenarios is the browser
// context, which is still fresh every time.

/**
 * Return `current` if it is still usable, otherwise launch a replacement.
 *
 * Exported for its own test: the guard is the part that can regress quietly.
 * Drop the isConnected() check and one crashed browser fails every scenario
 * after it; drop the reuse and the cost this change exists to remove comes
 * straight back, with nothing failing to say so.
 */
export async function reuseBrowser(
  current: Browser | null,
  launch: () => Promise<Browser>,
): Promise<Browser> {
  if (current?.isConnected()) return current
  return launch()
}

// Playwright is loaded on the first @ui scenario rather than when this module
// is imported, so a suite without @ui scenarios never needs it installed.
/**
 * The worker's shared browser. `abandon()` marks launches in flight as timed
 * out: one that resolves afterwards is closed instead of assigned, so a late
 * launch can neither leak nor replace a newer browser.
 */
export function createBrowserSource(launch: () => Promise<Browser>) {
  let current: Browser | null = null
  let generation = 0
  return {
    peek: () => current,
    drop: () => {
      current = null
    },
    abandon: () => {
      generation++
    },
    async get(): Promise<Browser> {
      const mine = generation
      const browser = await reuseBrowser(current, launch)
      if (mine !== generation) {
        if (browser !== current) await discard(browser)
        throw new Error('@ui hook: browser launch finished after its timeout and was closed')
      }
      current = browser
      return browser
    },
  }
}

const source = createBrowserSource(launchBrowser)

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await loadPlaywright()
  return chromium.launch()
}

const defaultLog = debuglog('ctf')
type Log = (msg: string) => void
const CLOSE_TIMEOUT_MS = 2_000

export const DEFAULT_LAUNCH_TIMEOUT_MS = 15_000
export const DEFAULT_UI_SETUP_TIMEOUT_MS = 45_000
const MIN_ATTEMPT_MS = 5_000
const HOOK_MARGIN_MS = 5_000

export function validateUiTimeouts(config: {
  launchTimeoutMs?: number
  uiSetupTimeoutMs?: number
}): void {
  for (const key of ['launchTimeoutMs', 'uiSetupTimeoutMs'] as const) {
    const v = config[key]
    if (v !== undefined && !(Number.isInteger(v) && v > 0)) {
      throw new Error(`${key} must be a positive integer (milliseconds), got ${String(v)}`)
    }
  }
}

/** Timeout for the @ui Before hook: the setup deadline plus headroom to report its error. */
export function uiHookTimeout(config: { uiSetupTimeoutMs?: number }): number {
  return (config.uiSetupTimeoutMs ?? DEFAULT_UI_SETUP_TIMEOUT_MS) + HOOK_MARGIN_MS
}

class LaunchTimeout extends Error {
  constructor(
    readonly call: string,
    message: string,
  ) {
    super(message)
  }
}

async function bounded<T>(
  call: string,
  budgetMs: number,
  getBrowser: () => Browser | null,
  work: () => Promise<T>,
  log: Log,
): Promise<T> {
  const start = Date.now()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const connected = getBrowser()?.isConnected() ?? false
      reject(
        new LaunchTimeout(
          call,
          `@ui hook: ${call} did not finish within ${budgetMs}ms (elapsed ${Date.now() - start}ms, shared browser connected: ${connected})`,
        ),
      )
    }, budgetMs)
  })
  try {
    const result = await Promise.race([work(), timeout])
    log(`${call} took ${Date.now() - start}ms`)
    return result
  } finally {
    clearTimeout(timer)
  }
}

async function discard(target: { close(): Promise<void> } | null | undefined): Promise<void> {
  if (!target) return
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      target.close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_TIMEOUT_MS)
      }),
    ])
  } catch {
    // Abandoned already; a failed close changes nothing about the retry.
  } finally {
    clearTimeout(timer)
  }
}

export interface UiLaunchDeps {
  getBrowser: () => Promise<Browser>
  peekBrowser: () => Browser | null
  dropBrowser: () => void
  abandonLaunch?: () => void
  log?: Log
}

export interface UiLaunchOptions {
  launchTimeoutMs?: number
  uiSetupTimeoutMs?: number
}

/**
 * Browser, context and page for a @ui scenario. One deadline of
 * `uiSetupTimeoutMs` covers everything; each call gets the smaller of
 * `launchTimeoutMs` and the time left less 1s. A disconnected browser or a
 * hung newContext is relaunched once, and only if two minimum attempts of
 * time remain.
 */
export async function launchUi(
  options: UiLaunchOptions,
  deps: UiLaunchDeps,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const log = deps.log ?? defaultLog
  const deadline = Date.now() + (options.uiSetupTimeoutMs ?? DEFAULT_UI_SETUP_TIMEOUT_MS)
  const remaining = () => deadline - Date.now()
  const budget = () =>
    Math.max(1, Math.min(options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS, remaining() - 1_000))
  const attempt = async () => {
    let browser: Browser
    try {
      browser = await bounded('browserForWorker', budget(), deps.peekBrowser, deps.getBrowser, log)
    } catch (err) {
      if (err instanceof LaunchTimeout) deps.abandonLaunch?.()
      throw err
    }
    let context: BrowserContext | undefined
    const pendingContext = browser.newContext()
    try {
      context = await bounded(
        'newContext',
        budget(),
        () => browser,
        () => pendingContext,
        log,
      )
      const page = await bounded(
        'newPage',
        budget(),
        () => browser,
        () => context!.newPage(),
        log,
      )
      return { browser, context, page }
    } catch (err) {
      // A context that resolves after its timeout would otherwise leak.
      void pendingContext.then(
        (c) => discard(c),
        () => undefined,
      )
      await discard(context)
      throw err
    }
  }
  try {
    return await attempt()
  } catch (err) {
    const stale = deps.peekBrowser()
    const retry = err instanceof LaunchTimeout && err.call === 'newContext'
    if (!retry && stale?.isConnected() !== false) throw err
    if (remaining() < 2 * MIN_ATTEMPT_MS) {
      throw new Error(
        `${(err as Error).message}; relaunch retry skipped, only ${Math.max(0, remaining())}ms of the ${options.uiSetupTimeoutMs ?? DEFAULT_UI_SETUP_TIMEOUT_MS}ms setup budget left`,
      )
    }
    log(`relaunching shared browser after: ${(err as Error).message}`)
    deps.dropBrowser()
    await discard(stale)
    return attempt()
  }
}

export async function loadPlaywright(
  importer: () => Promise<typeof import('@playwright/test')> = () => import('@playwright/test'),
): Promise<typeof import('@playwright/test')> {
  try {
    return await importer()
  } catch (err) {
    const { cause } = err as { cause?: unknown }
    // Only the package being loaded missing means "not installed"; a missing dependency of it is a real error.
    const notInstalled = [err, cause].some((e) => {
      const { code, message } = (e ?? {}) as NodeJS.ErrnoException
      return (
        (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') &&
        typeof message === 'string' &&
        message.includes("'@playwright/test'")
      )
    })
    if (!notInstalled) throw err
    throw new Error(
      "@ui scenarios need @playwright/test. Add it to the suite's dependencies: npm install --save-dev @playwright/test (then npx playwright install chromium)",
    )
  }
}

/**
 * Fill in defaults for the optional URLs. An empty string means "not
 * configured": the WireMock client and `requireApiBaseUrl` throw a clear
 * error if something tries to use it.
 */
function resolveConfig(options: FrameworkOptions): FrameworkConfig {
  const config: FrameworkConfig = {
    ...options,
    apiBaseUrl: options.apiBaseUrl ?? '',
    wiremockUrl: options.wiremockUrl ?? '',
  }
  // This worker's own database and Redis index, so steps, cleanup and the
  // suite's own code (through world.config) all use the worker's.
  const isolation = options.workerIsolation
  if (isolation?.portStride !== undefined) setWorkerPortStride(isolation.portStride)
  if (currentWorker().parallel && isolation) {
    if (isolation.database && config.databaseUrl) {
      config.databaseUrl = workerDatabaseUrl(config.databaseUrl)
    }
    if (isolation.redis && config.redisUrl) config.redisUrl = workerRedisUrl(config.redisUrl)
  }
  return config
}

export function registerHooks(options: FrameworkOptions): void {
  markHooksRegistered()
  validateUiTimeouts(options)
  const config = resolveConfig(options)
  setWorldConstructor(ComponentTestWorld)

  if (config.defaultStepTimeout) {
    setDefaultTimeout(config.defaultStepTimeout)
  }

  // Configuration mistakes are reported here, once, rather than in every scenario.
  if (config.pages && Object.keys(config.pages).length > 0 && !config.webBaseUrl) {
    throw new Error('The pages option needs webBaseUrl, the base URL page objects navigate from.')
  }
  const worker = currentWorker()
  const ctx: AdapterContext = { config, worker }
  const adapters = [...builtinAdapters(options, config, worker), ...(config.adapters ?? [])]
  initAdapters(adapters, ctx)

  beforeAllHooks(adapters, ctx)

  // --- Before every scenario ---
  Before(async function (this: ComponentTestWorld) {
    this.config = config
    this.operationMap = config.operationMap ?? {}
    this.resetScenario()
    await runBeforeScenario(adapters, this)

    await config.hooks?.afterReset?.(this)
  })

  // --- Before @ui scenarios: launch Playwright ---
  Before(
    { tags: '@ui', timeout: uiHookTimeout(config) },
    async function (this: ComponentTestWorld) {
      const ui = await launchUi(config, {
        getBrowser: source.get,
        peekBrowser: source.peek,
        dropBrowser: source.drop,
        abandonLaunch: source.abandon,
      })
      this.browser = ui.browser
      this.browserContext = ui.context
      this.page = ui.page

      // Page objects from the pages option, so the suite needn't register them.
      for (const [name, PageObject] of Object.entries(config.pages ?? {})) {
        this.pageRegistry.set(name, new PageObject(this.page, config.webBaseUrl as string))
      }
    },
  )

  // --- After @ui scenarios: close Playwright ---
  After({ tags: '@ui' }, async function (this: ComponentTestWorld) {
    try {
      if (this.page) await config.hooks?.beforePageClose?.(this)
    } finally {
      // Closed even when beforePageClose throws, or the context would outlive
      // the scenario on the worker's shared browser. The context goes; the
      // browser stays for the next scenario. Closing a context discards its
      // pages, cookies and storage, which is the isolation a scenario needs.
      await this.page?.close()
      await this.browserContext?.close()
      this.page = null
      this.browserContext = null
      this.browser = null
    }
  })

  const afterAllTimeouts = adapters.map((a) => a.afterAllTimeout ?? 0)
  AfterAll({ timeout: Math.max(0, ...afterAllTimeouts) || undefined }, async function () {
    await runAll([
      async () => {
        await source.peek()?.close()
        source.drop()
      },
      ...afterAllSteps(adapters, ctx),
    ])
  })

  // --- After every scenario: failure hooks, adapter teardown, cleanup ---
  // Registered after the @ui After, so Cucumber runs it first: the page is
  // still open for onScenarioFailed. Every step runs even when an earlier one
  // throws, so one failed screenshot can't leave state behind for the next
  // scenario; the first error is reported once they have all run.
  After(async function (this: ComponentTestWorld, scenario: ITestCaseHookParameter) {
    await runAll([
      () => failed(scenario) && config.hooks?.onScenarioFailed?.(this, scenario),
      ...afterScenarioSteps(adapters, this, scenario),
      ...teardownSteps(adapters, this, scenario),
      () => config.cleanup?.(this),
    ])
  })
}
