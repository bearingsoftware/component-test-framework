import * as fs from 'fs'
import * as path from 'path'
import {
  Before,
  BeforeAll,
  After,
  AfterAll,
  Status,
  setDefaultTimeout,
  setWorldConstructor,
} from '@cucumber/cucumber'
import type { ITestCaseHookParameter } from '@cucumber/cucumber'
import type { Browser } from '@playwright/test'
import { ComponentTestWorld } from './world'
import { WireMockClient } from '../clients/wiremock-client'
import { DbClient } from '../clients/db-client'
import { RedisClient } from '../clients/redis-client'
import type { FrameworkConfig, FrameworkOptions } from '../types'
import { currentWorker, wiremockNamespace, workerDatabaseUrl, workerRedisUrl } from './worker'
import { prepareWorkerDatabase } from './worker-database'

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
  if (config.wiremockBaseline?.length) {
    if (!config.wiremockUrl) {
      throw new Error('wiremockBaseline needs wiremockUrl: set WIREMOCK_URL or pass wiremockUrl.')
    }
    for (const dir of config.wiremockBaseline) {
      const mappings = path.join(path.resolve(config.fixturesDir, dir), 'mappings')
      if (!fs.existsSync(mappings)) {
        throw new Error(
          `wiremockBaseline directory has no mappings folder: ${mappings}. ` +
            `Stub directories use WireMock's layout, <dir>/mappings/*.json.`,
        )
      }
    }
  }

  if (config.wiremockStubsDir && !fs.existsSync(config.wiremockStubsDir)) {
    console.warn(
      `[component-test-framework] wiremockStubsDir does not exist: ${config.wiremockStubsDir}. ` +
        `Steps that register stubs from files will fail.`,
    )
  }

  const worker = currentWorker()
  const isolation = worker.parallel ? options.workerIsolation : undefined
  const wiremock = new WireMockClient(config.wiremockUrl, undefined, {
    namespace: isolation?.wiremock ? wiremockNamespace(worker.id) : undefined,
  })
  let db: DbClient | undefined
  let redis: RedisClient | undefined

  if (config.databaseUrl) {
    db = new DbClient(config.databaseUrl)
  }
  if (config.redisUrl) {
    redis = new RedisClient(config.redisUrl)
  }

  // --- Before the suite: this worker's database, copied from the template ---
  if (isolation?.database && options.databaseUrl) {
    const sourceUrl = options.databaseUrl
    const template =
      typeof isolation.database === 'object' ? isolation.database.template : undefined
    BeforeAll({ timeout: 60_000 }, async function () {
      await prepareWorkerDatabase(sourceUrl, { template })
    })
  }

  // --- Before the suite: wait for WireMock to accept admin requests ---
  if (config.wiremockUrl) {
    BeforeAll({ timeout: 30_000 }, async function () {
      await wiremock.waitForReady(30_000)
    })
  }

  // --- Before every scenario ---
  Before(async function (this: ComponentTestWorld) {
    this.config = config
    this.operationMap = config.operationMap ?? {}
    this.wiremock = wiremock
    this.db = db
    this.redis = redis
    this.resetScenario()

    // Reset WireMock state
    if (config.wiremockUrl) {
      await wiremock.resetAll()
    }

    // Stubs most scenarios need, loaded after every reset
    for (const dir of config.wiremockBaseline ?? []) {
      await wiremock.loadMappingsFromDir(path.resolve(config.fixturesDir, dir))
    }

    // Flush Redis cache
    if (redis) {
      await redis.flushDb()
    }

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

  AfterAll(async function () {
    await sharedBrowser?.close()
    sharedBrowser = null
  })

  // --- After every scenario: failure hook, stray pub/sub subscription, cleanup ---
  // Registered after the @ui After, so Cucumber runs it first: the page is
  // still open for onScenarioFailed.
  After(async function (this: ComponentTestWorld, scenario: ITestCaseHookParameter) {
    // Cleanup runs even when onScenarioFailed throws, so one failed
    // screenshot can't leave state behind for the next scenario. Its error
    // is reported once cleanup is done.
    let hookError: unknown
    if (FAILED_STATUSES.has(String(scenario.result?.status))) {
      try {
        await config.hooks?.onScenarioFailed?.(this, scenario)
      } catch (err) {
        hookError = err
      }
    }
    // Steps' subscriptions, and one a suite's own step left as the active one.
    const subscriptions = new Set(this.subscriptions ?? [])
    if (this.activeSubscription) subscriptions.add(this.activeSubscription)
    for (const sub of subscriptions) {
      try {
        await sub.close()
      } catch {
        /* best-effort */
      }
    }
    this.subscriptions = []
    this.activeSubscription = undefined
    if (db && config.cleanupTables && config.cleanupTables.length > 0) {
      await db.cleanTables(config.cleanupTables)
    }
    await config.cleanup?.(this)
    if (hookError) throw hookError
  })
}

/** Results that fail the run (undefined and pending ones under --strict). */
const FAILED_STATUSES = new Set<string>([
  Status.FAILED,
  Status.AMBIGUOUS,
  Status.UNDEFINED,
  Status.PENDING,
])
