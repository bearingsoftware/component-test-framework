import { Before, After, AfterAll, setDefaultTimeout, setWorldConstructor } from '@cucumber/cucumber'
import type { ITestCaseHookParameter } from '@cucumber/cucumber'
import type { Browser } from '@playwright/test'
import { ComponentTestWorld } from './world'
import type { FrameworkConfig, FrameworkOptions } from '../types'
import { currentWorker, workerDatabaseUrl, workerRedisUrl } from './worker'
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
let sharedBrowser: Browser | null = null

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

// Playwright is an optional peer dependency, so it's loaded on the first @ui
// scenario rather than when this module is imported. A suite without @ui
// scenarios never needs it installed.
async function browserForWorker(): Promise<Browser> {
  sharedBrowser = await reuseBrowser(sharedBrowser, async () => {
    const { chromium } = await import('@playwright/test')
    return chromium.launch()
  })
  return sharedBrowser
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
  if (currentWorker().parallel && isolation) {
    if (isolation.database && config.databaseUrl) {
      config.databaseUrl = workerDatabaseUrl(config.databaseUrl)
    }
    if (isolation.redis && config.redisUrl) config.redisUrl = workerRedisUrl(config.redisUrl)
  }
  return config
}

export function registerHooks(options: FrameworkOptions): void {
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
  Before({ tags: '@ui' }, async function (this: ComponentTestWorld) {
    this.browser = await browserForWorker()
    this.browserContext = await this.browser.newContext()
    this.page = await this.browserContext.newPage()

    // Page objects from the pages option, so the suite needn't register them.
    for (const [name, PageObject] of Object.entries(config.pages ?? {})) {
      this.pageRegistry.set(name, new PageObject(this.page, config.webBaseUrl as string))
    }
  })

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
        await sharedBrowser?.close()
        sharedBrowser = null
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
