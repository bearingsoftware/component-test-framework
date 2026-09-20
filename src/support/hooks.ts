import { Before, BeforeAll, After, setWorldConstructor } from '@cucumber/cucumber'
import { chromium } from '@playwright/test'
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
    this.browser = await chromium.launch()
    this.browserContext = await this.browser.newContext()
    this.page = await this.browserContext.newPage()
  })

  // --- After @ui scenarios: close Playwright ---
  After({ tags: '@ui' }, async function (this: ComponentTestWorld) {
    await this.page?.close()
    await this.browserContext?.close()
    await this.browser?.close()
    this.page = null
    this.browserContext = null
    this.browser = null
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
