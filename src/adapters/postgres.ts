import { DbClient } from '../clients/db-client'
import { defineAdapter } from '../support/adapter'
import type { Adapter } from '../support/adapter'
import { runMigrations } from '../support/migrations'
import type { MigrationsOptions } from '../support/migrations'
import { prepareWorkerDatabase } from '../support/worker-database'

export interface PostgresAdapterOptions {
  url: string
  /** Tables to truncate after each scenario. */
  cleanupTables?: string[]
  /** Copy this worker's database from `sourceUrl` before the suite (see `workerIsolation.database`). */
  workerDatabase?: { sourceUrl: string; template?: string }
  /**
   * Migrate the source database before the suite (and before the worker copy):
   * `url`, or with `workerDatabase` the template the workers copy. The command
   * must be idempotent.
   */
  migrations?: MigrationsOptions
}

/** Cleans tables after each scenario. State is the client. */
export function postgresAdapter(options: PostgresAdapterOptions): Adapter<DbClient> {
  const { cleanupTables, workerDatabase, migrations } = options
  return defineAdapter<DbClient>({
    name: 'postgres',
    setup: () => new DbClient(options.url),
    ...((workerDatabase || migrations) && {
      // The lock wait (up to twice the command's timeout plus 30s), the command, then the copy.
      beforeAllTimeout: migrations ? 90_000 + 3 * (migrations.timeoutMs ?? 120_000) : 60_000,
      async beforeAll() {
        const copy = () =>
          workerDatabase
            ? prepareWorkerDatabase(workerDatabase.sourceUrl, { template: workerDatabase.template })
            : undefined
        if (migrations) {
          // The copy runs under the lock, so no other worker's migration command is connected to the template meanwhile.
          await runMigrations(
            workerDatabase ? templateUrl(workerDatabase) : options.url,
            migrations,
            { whileLocked: copy },
          )
        } else {
          await copy()
        }
      },
    }),
    beforeScenario(world, db) {
      world.db = db
    },
    async afterScenario(_world, _scenario, db) {
      if (cleanupTables && cleanupTables.length > 0) await db.cleanTables(cleanupTables)
    },
  })
}

/** The database workers copy from, as a URL. */
function templateUrl({ sourceUrl, template }: { sourceUrl: string; template?: string }): string {
  if (!template) return sourceUrl
  const url = new URL(sourceUrl)
  url.pathname = `/${encodeURIComponent(template)}`
  return url.toString()
}
