# Postgres

Set `DATABASE_URL` (or `databaseUrl` in `registerHooks`) and the framework creates a `DbClient`, available in steps as `this.db`. The `/postgres` entry point exports `DbClient`, `countRows`, `queryOnce`, `registerDbSteps`, `registerServiceSteps` and `prepareWorkerDatabase`; the `pg` driver loads only when a client is first created. See [Entry points](entry-points.md).

- **Cleanup.** `cleanupTables` lists the tables to clear after each scenario, children first. The rows are removed with DELETE, falling back to `TRUNCATE ... CASCADE` when a foreign key from a table you didn't list blocks the delete. See [Lifecycle](lifecycle.md#scenario-lifecycle) and [Configuration](configuration.md).
- **Steps.** `registerDbSteps()` adds `the {word} table contains {int} row(s) matching {string}`, and `registerServiceSteps()` adds the record waits and `the {word} table is empty`. They're listed in [Service call tracking steps](steps.md#service-call-tracking-steps); the opt-in `at least` and `exactly` waits are in [Opt-in waiting steps](steps.md#opt-in-waiting-steps).
- **Helpers.** `countRows(world, table, predicate?)` and `queryOnce(world, sql)` are described under [In your own steps](steps.md#in-your-own-steps).
- **Migrations and seeding.** The `migrations` option runs a migrate command before the suite, and `registerDbSteps()` adds steps that insert rows. See [Migrations](#migrations) and [Seeding](#seeding).
- **Parallel runs.** `workerIsolation.database` gives each Cucumber worker its own database. See [Running in parallel](parallel.md).

## Discovering tables

Instead of listing tables, let the framework read them:

```typescript
registerHooks({
  ...loadConfig(),
  cleanupTables: { discover: true, keep: ['countries'], assertEmptyAtStart: true },
})
```

| Field | Default | |
|---|---|---|
| `discover` | | Must be `true` |
| `schema` | `public` | The schema to read |
| `keep` | _(none)_ | Tables to leave alone, added to the migration tables that are always kept: `schema_migrations`, `goose_db_version`, `flyway_schema_history`, `knex_migrations`, `_prisma_migrations`, `alembic_version`, `django_migrations` and a few more |
| `assertEmptyAtStart` | `false` | Before a worker's first scenario, fail naming every discovered table that already has rows |

Discovery takes the schema's base tables (views and partitions are left out) and empties them after each scenario with one `TRUNCATE ... RESTART IDENTITY CASCADE`, so foreign keys need no ordering. CASCADE also empties any table, kept or not, that references a discovered one. Unlike the DELETE used for a list, TRUNCATE costs more per scenario on a large schema.

The list is read once per run and then reused. An empty result is not remembered, so a service that applies its schema after the first hook is picked up once its tables exist, and a table dropped since the last read triggers one re-read. A table created later than the first non-empty read is not noticed until then.

## Migrations

Set `migrations` to a shell command that migrates the database named by `$DATABASE_URL`:

```typescript
registerHooks({
  ...loadConfig(),
  migrations: { command: 'migrate -path ./migrations -database "$DATABASE_URL" up' },
})
```

| Field | Default | |
|---|---|---|
| `command` | | Run through the shell. `DATABASE_URL` is always set to the target database |
| `cwd` | `process.cwd()` | |
| `env` | _(none)_ | Merged over `process.env` |
| `timeoutMs` | `120000` | The command is killed, with its child processes, after this |

It runs before the suite, in the Postgres adapter's `BeforeAll`, against the database the workers copy from: `databaseUrl`, or `workerIsolation.database.template` when set. Under `workerIsolation.database` it runs before the worker's copy is made. `postgresAdapter({ url, migrations })` takes the same option.

- **It must be idempotent.** Under Cucumber `--parallel` every worker runs the command, one at a time: the first migrates and the rest find nothing to do. golang-migrate, goose, prisma (`migrate deploy`), knex and dbmate all behave this way.
- **The lock.** Each run holds a Postgres advisory lock, keyed on the database name, on the server's `postgres` maintenance database (`template1` when the source is `postgres`), not on the migrated database. Each worker takes the lock, migrates, makes its database copy, then releases it, so another worker's migrate command is never connected to the template during a copy, and the lock's own connection never is either. A worker waits for the lock for up to twice `timeoutMs` plus 30s, then fails with an error naming the lock.
- **Failures.** A non-zero exit, a timeout or a command that can't start fails the run with the command, the exit code and the last 40 lines of its output. The database password is replaced with `***`.

**Which call order needs which approach.** `BeforeAll` hooks run in registration order:

- `registerHooks` first, then `registerServiceUnderTest`: use the `migrations` option. The migrations and the worker copy are done before the service starts.
- `registerServiceUnderTest` first, then `registerHooks`: the service's `beforeStart` runs before the adapter's `BeforeAll`, so the option is too late for it. Call `runMigrations(databaseUrl, options)`, exported from `/core` and `/postgres`, in `beforeStart`, before `prepareWorkerDatabase`:

```typescript
registerServiceUnderTest({
  // ...
  beforeStart: async () => {
    await runMigrations(DATABASE_URL, { command: 'migrate -path ./migrations -database "$DATABASE_URL" up' })
    if (isolation.database) await prepareWorkerDatabase(DATABASE_URL)
  },
})
```

Leave the `migrations` option off in that case, or the command runs a second time, harmlessly.

## Seeding

`registerDbSteps()` adds two steps that insert rows before a scenario.

A data table. The header row is the columns, the cells are strings that Postgres converts to the column's type, and an empty cell is `NULL`:

```gherkin
Given the orders table contains:
  | sku | qty | note |
  | A-1 | 2   |      |
  | B-7 | 5   | gift |
```

A fixture file, with a path relative to `fixturesDir`:

```gherkin
Given the database is seeded from "seed/orders.json"
```

- `.json` is `{ "<table>": [ { "<column>": value, … }, … ], … }`. Tables are inserted in key order, so list parents before children. Values keep their JSON types, and `null` is `NULL`.
- `.sql` is run as one multi-statement query.

The table name must be a plain identifier (no schema), and column names in the data table and JSON are quoted, so they keep their case. Seeded rows are removed by the `cleanupTables` cleanup after the scenario, so list every table you seed there. Rows a `.sql` file inserts into other tables are only removed if those are listed too. `DbClient.seed(table, rows)` is unchanged: it doesn't quote column names, so Postgres folds them to lower case.
