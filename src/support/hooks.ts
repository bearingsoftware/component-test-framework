import * as fs from 'fs'
import {
  Before,
  BeforeAll,
  After,
  AfterAll,
  setDefaultTimeout,
  setWorldConstructor,
} from '@cucumber/cucumber'
import type { Browser } from '@playwright/test'
import { ComponentTestWorld } from './world'
import { WireMockClient } from '../clients/wiremock-client'
import { DbClient } from '../clients/db-client'
import { RedisClient } from '../clients/redis-client'
import type { FrameworkConfig, FrameworkOptions } from '../types'

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
  return {
    ...options,
    apiBaseUrl: options.apiBaseUrl ?? '',
    wiremockUrl: options.wiremockUrl ?? '',
  }
}

export function registerHooks(options: FrameworkOptions): void {
  const config = resolveConfig(options)
  setWorldConstructor(ComponentTestWorld)

  if (config.defaultStepTimeout) {
    setDefaultTimeout(config.defaultStepTimeout)
  }

  if (config.wiremockStubsDir && !fs.existsSync(config.wiremockStubsDir)) {
    console.warn(
      `[component-test-framework] wiremockStubsDir does not exist: ${config.wiremockStubsDir}. ` +
        `Steps that register stubs from files will fail.`,
    )
  }

  const wiremock = new WireMockClient(config.wiremockUrl)
  let db: DbClient | undefined
  let redis: RedisClient | undefined

  if (config.databaseUrl) {
    db = new DbClient(config.databaseUrl)
  }
  if (config.redisUrl) {
    redis = new RedisClient(config.redisUrl)
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

    // Flush Redis cache
    if (redis) {
      await redis.flushDb()
    }
  })

  // --- Before @ui scenarios: launch Playwright ---
  Before({ tags: '@ui' }, async function (this: ComponentTestWorld) {
    this.browser = await browserForWorker()
    this.browserContext = await this.browser.newContext()
    this.page = await this.browserContext.newPage()
  })

  // --- After @ui scenarios: close Playwright ---
  After({ tags: '@ui' }, async function (this: ComponentTestWorld) {
    // The context goes; the browser stays for the next scenario. Closing a
    // context discards its pages, cookies and storage, which is the isolation
    // a scenario actually needs.
    await this.page?.close()
    await this.browserContext?.close()
    this.page = null
    this.browserContext = null
    this.browser = null
  })

  AfterAll(async function () {
    await sharedBrowser?.close()
    sharedBrowser = null
  })

  // --- After every scenario: DB cleanup + stray pub/sub subscription ---
  After(async function (this: ComponentTestWorld) {
    if (this.activeSubscription) {
      try {
        await this.activeSubscription.close()
      } catch {
        /* best-effort */
      }
      this.activeSubscription = undefined
    }
    if (db && config.cleanupTables && config.cleanupTables.length > 0) {
      await db.cleanTables(config.cleanupTables)
    }
  })
}
