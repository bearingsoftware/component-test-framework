// `@bearingsoftware/component-test-framework/postgres`: the Postgres client,
// row-count helpers and steps. Registers nothing on import; pg is loaded when
// a DbClient is first created.
export { DbClient } from './clients/db-client'
export { countRows, assertSafeTableName, requireDb, queryOnce } from './support/db'
export { registerDbSteps, registerServiceSteps } from './steps/register'
export { prepareWorkerDatabase } from './support/worker-database'
export type { WorkerDatabaseOptions } from './support/worker-database'
