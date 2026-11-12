import type { AnyAdapter } from '../support/adapter'
import type { FrameworkConfig, FrameworkOptions } from '../types'
import type { WorkerInfo } from '../support/worker'
import { wiremockNamespace } from '../support/worker'
import { wiremockAdapter } from './wiremock'
import { postgresAdapter } from './postgres'
import { redisAdapter } from './redis'

/**
 * The adapters the config implies, in order: Postgres, WireMock, Redis. The
 * teardown runs them in reverse, so subscriptions close before tables are
 * cleaned, and the one-time worker database copy runs before WireMock's wait.
 */
export function builtinAdapters(
  options: FrameworkOptions,
  config: FrameworkConfig,
  worker: WorkerInfo,
): AnyAdapter[] {
  const isolation = worker.parallel ? options.workerIsolation : undefined
  const adapters: AnyAdapter[] = []

  if (config.databaseUrl) {
    const database = isolation?.database
    adapters.push(
      postgresAdapter({
        url: config.databaseUrl,
        cleanupTables: config.cleanupTables,
        workerDatabase:
          database && options.databaseUrl
            ? {
                sourceUrl: options.databaseUrl,
                template: typeof database === 'object' ? database.template : undefined,
              }
            : undefined,
      }),
    )
  }
  // Also derived with no URL when a WireMock-only option is set, so its
  // configuration mistakes are still reported.
  if (config.wiremockUrl || config.wiremockBaseline?.length || config.wiremockStubsDir) {
    adapters.push(
      wiremockAdapter({
        url: config.wiremockUrl,
        namespace: isolation?.wiremock ? wiremockNamespace(worker.id) : undefined,
        baseline: config.wiremockBaseline,
        fixturesDir: config.fixturesDir,
        stubsDir: config.wiremockStubsDir,
      }),
    )
  }
  // Always: steps' pub/sub subscriptions are closed after each scenario.
  adapters.push(redisAdapter({ url: config.redisUrl ?? '' }))
  return adapters
}
