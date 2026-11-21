import { DbClient } from '../clients/db-client'
import { defineAdapter } from '../support/adapter'
import type { Adapter } from '../support/adapter'
import { parseCleanupTables } from '../support/cleanup-tables'
import { runMigrations } from '../support/migrations'
import type { MigrationsOptions } from '../support/migrations'
import { prepareWorkerDatabase } from '../support/worker-database'
import type { DiscoverTablesOptions } from '../types'

export interface PostgresAdapterOptions {
  url: string
  /** Tables to empty after each scenario: a list, or `{ discover: true, … }`. */
  cleanupTables?: string[] | DiscoverTablesOptions
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
  const { workerDatabase, migrations } = options
  const cleanup = parseCleanupTables(options.cleanupTables)
  let guarded = false
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
    async beforeScenario(world, db) {
      world.db = db
      if (cleanup?.kind === 'discover' && cleanup.assertEmptyAtStart && !guarded) {
        const tables = await db.discoverTables(cleanup.schema, cleanup.keep)
        const dirty = await db.nonEmptyTables(cleanup.schema, tables)
        // Checked once per worker, and only once there are tables to check.
        if (tables.length > 0) guarded = true
        if (dirty.length > 0) {
          throw new Error(
            `cleanupTables.assertEmptyAtStart: tables not empty before the first scenario: ${dirty.join(', ')}. ` +
              `A previous run left rows behind, or something wrote outside a scenario.`,
          )
        }
      }
    },
    async afterScenario(_world, _scenario, db) {
      if (cleanup?.kind === 'discover') await db.cleanDiscovered(cleanup)
      else if (cleanup && cleanup.tables.length > 0) await db.cleanTables(cleanup.tables)
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
