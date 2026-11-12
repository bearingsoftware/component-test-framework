# Postgres

Set `DATABASE_URL` (or `databaseUrl` in `registerHooks`) and the framework creates a `DbClient`, available in steps as `this.db`. The `/postgres` entry point exports `DbClient`, `countRows`, `queryOnce`, `registerDbSteps`, `registerServiceSteps` and `prepareWorkerDatabase`; the `pg` driver loads only when a client is first created. See [Entry points](entry-points.md).

- **Cleanup.** `cleanupTables` lists the tables to clear after each scenario, children first. The rows are removed with DELETE, falling back to `TRUNCATE ... CASCADE` when a foreign key from a table you didn't list blocks the delete. See [Lifecycle](lifecycle.md#scenario-lifecycle) and [Configuration](configuration.md).
- **Steps.** `registerDbSteps()` adds `the {word} table contains {int} row(s) matching {string}`, and `registerServiceSteps()` adds the record waits and `the {word} table is empty`. They're listed in [Service call tracking steps](steps.md#service-call-tracking-steps); the opt-in `at least` and `exactly` waits are in [Opt-in waiting steps](steps.md#opt-in-waiting-steps).
- **Helpers.** `countRows(world, table, predicate?)` and `queryOnce(world, sql)` are described under [In your own steps](steps.md#in-your-own-steps).
- **Parallel runs.** `workerIsolation.database` gives each Cucumber worker its own database. See [Running in parallel](parallel.md).
