import { Before, BeforeAll, After, AfterAll, setWorldConstructor } from '@cucumber/cucumber'
import { chromium, type Browser } from '@playwright/test'
import { ComponentTestWorld } from './world'
import { WireMockClient } from '../clients/wiremock-client'
import { DbClient } from '../clients/db-client'
import { RedisClient } from '../clients/redis-client'
import type { FrameworkConfig } from '../types'

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
// SECREPO-602: one browser per worker process, not one per scenario.
//
// A suite of 65 @ui scenarios meant 65 chromium.launch() and 65 browser.close()
// calls, and launching a browser is the part of this that suffers most under
// CPU contention. It showed up as a scenario whose every step passed failing in
// teardown, because closing Chromium took longer than the suite's 30s hook
// timeout while the host was at a load average of 101-180.
//
// Cucumber runs each parallel worker in its own process, so this is per worker
// rather than global — the isolation that matters between scenarios is the
// browser context, which is still fresh every time.
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

async function browserForWorker(): Promise<Browser> {
  sharedBrowser = await reuseBrowser(sharedBrowser, () => chromium.launch())
  return sharedBrowser
}

export function registerHooks(config: FrameworkConfig): void {
  setWorldConstructor(ComponentTestWorld)

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
    await wiremock.resetAll()

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
