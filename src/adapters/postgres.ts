import { DbClient } from '../clients/db-client'
import { defineAdapter } from '../support/adapter'
import type { Adapter } from '../support/adapter'
import { prepareWorkerDatabase } from '../support/worker-database'

export interface PostgresAdapterOptions {
  url: string
  /** Tables to truncate after each scenario. */
  cleanupTables?: string[]
  /** Copy this worker's database from `sourceUrl` before the suite (see `workerIsolation.database`). */
  workerDatabase?: { sourceUrl: string; template?: string }
}

/** Cleans tables after each scenario. State is the client. */
export function postgresAdapter(options: PostgresAdapterOptions): Adapter<DbClient> {
  const { cleanupTables, workerDatabase } = options
  return defineAdapter<DbClient>({
    name: 'postgres',
    setup: () => new DbClient(options.url),
    ...(workerDatabase && {
      beforeAllTimeout: 60_000,
      beforeAll: () =>
        prepareWorkerDatabase(workerDatabase.sourceUrl, { template: workerDatabase.template }),
    }),
    beforeScenario(world, db) {
      world.db = db
    },
    async afterScenario(_world, _scenario, db) {
      if (cleanupTables && cleanupTables.length > 0) await db.cleanTables(cleanupTables)
    },
  })
}
