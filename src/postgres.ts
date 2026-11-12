// `@bearingsoftware/component-test-framework/postgres`: the Postgres client,
// row-count helpers and steps. Registers nothing on import; pg is loaded when
// a DbClient is first created.
export { DbClient } from './clients/db-client'
export { countRows, assertSafeTableName, requireDb, queryOnce } from './support/db'
export { registerDbSteps, registerServiceSteps } from './steps/register'
export { prepareWorkerDatabase } from './support/worker-database'
export type { WorkerDatabaseOptions } from './support/worker-database'
export { runMigrations } from './support/migrations'
export type { MigrationsOptions } from './support/migrations'
export { postgresAdapter } from './adapters/postgres'
export type { PostgresAdapterOptions } from './adapters/postgres'
