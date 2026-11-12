# Running in parallel

Cucumber's `parallel` option (or `--parallel N`) runs scenarios in N workers at once. A suite that resets shared state before every scenario (WireMock, a database, Redis) can't simply turn it on: one worker's reset wipes another's stubs and rows mid-scenario. `workerIsolation` keeps the workers apart. It's opt-in, and it only takes effect in a parallel run: run serially, a suite with it set behaves exactly as it did without it.

```typescript
import * as path from 'path'
import {
  registerHooks,
  registerServiceUnderTest,
  workerPort,
  workerDatabaseUrl,
  workerRedisUrl,
  workerWiremockUrl,
  prepareWorkerDatabase,
} from '@bearingsoftware/component-test-framework/core'

const WIREMOCK_URL = process.env.WIREMOCK_URL ?? 'http://localhost:8443'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app'
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const apiPort = workerPort(18080) // 18080, or 18080 + n in worker n

// One service per worker, pointed at the worker's own database, Redis and WireMock prefix.
registerServiceUnderTest({
  name: 'api',
  cwd: BACKEND_ROOT,
  cmd: 'go',
  args: ['run', './cmd/api'],
  env: {
    ...process.env,
    LISTEN_ADDR: `:${apiPort}`,
    DATABASE_URL: workerDatabaseUrl(DATABASE_URL),
    REDIS_URL: workerRedisUrl(REDIS_URL),
    PAYMENTS_URL: `${workerWiremockUrl(WIREMOCK_URL)}/payments`,
  },
  beforeStart: () => prepareWorkerDatabase(DATABASE_URL), // the worker's database must exist first
  logFile: path.join(__dirname, '..', '.api.log'), // .api.w<n>.log in worker n
  readyCheck: { url: `http://localhost:${apiPort}/health` },
})

registerHooks({
  apiBaseUrl: `http://localhost:${apiPort}`,
  wiremockUrl: WIREMOCK_URL,
  databaseUrl: DATABASE_URL,
  redisUrl: REDIS_URL,
  fixturesDir: path.join(__dirname, '..', 'fixtures'),
  cleanupTables: ['orders'],
  workerIsolation: { wiremock: true, database: true, redis: true },
})
```

Each worker gets:

|  | How | What the service under test needs |
|---|---|---|
| WireMock | One WireMock, shared. The worker's stubs are registered under `/__worker-<n>`, with their ids and scenario names namespaced too, and the per-scenario reset removes only the worker's stubs and requests. Request counts and searches look only under the prefix, and report URLs without it. | Call WireMock at `workerWiremockUrl(url)`. For an SPA, pass it as `registerSpaServer`'s `apiUrl`. |
| Postgres | A database per worker, `<name>_w<n>`, copied from the configured one before the first scenario (`CREATE DATABASE … TEMPLATE`). A copy left by an earlier run is dropped first. Cleanup and the database steps use the worker's. | Use `workerDatabaseUrl(url)`, and await `prepareWorkerDatabase(url)` before starting; it runs once per worker however often it's called. |
| Redis | A database index per worker: the URL's index plus n. The per-scenario flush empties only the worker's. | Use `workerRedisUrl(url)`. |
| Ports and logs | `workerPort(base)` is `base + n`; `registerSpaServer` adds n itself. Service logs go to `<name>.w<n>.<ext>`. | Listen on the worker's port. |

`currentWorker()` returns `{ id, total, parallel }`, from Cucumber's `CUCUMBER_WORKER_ID` and `CUCUMBER_TOTAL_WORKERS`. Outside a parallel run every helper returns what it was given.

Things to know:

- **WireMock's own mappings don't apply.** A worker's reset no longer resets the whole of WireMock, and stubs WireMock loads from its own `mappings` folder aren't under any worker's prefix, so the service never reaches them. Load shared stubs with `wiremockBaseline`, which registers them under each worker's prefix after every reset.
- **`workerWiremockUrl` takes WireMock's root URL**, such as `http://localhost:8443`, as `wiremockUrl` does: the prefix is added at the root.
- **Prepare the template first.** Workers copy the configured database, so migrate (and seed) it before the run, and leave nothing connected to it: Postgres won't copy a database another session is using. `prepareWorkerDatabase` retries for 15s, then fails naming the cause. It needs Postgres 13 or later. Pass `workerIsolation.database: { template: 'app_template' }` to copy a different database, and the same `template` to `prepareWorkerDatabase`: two calls that disagree fail rather than copying the wrong one. A URL with no database name, or `postgres`, copies `postgres` itself, connecting through `template1` while it does.
- **One run per Postgres at a time.** Each run drops and recreates `<name>_w<n>`, so two runs sharing a server and a database name would drop each other's databases mid-run. The same goes for two runs sharing a coverage folder.
- **Space ports apart.** Workers use `base` to `base + N - 1`, so keep services' bases further apart than the worker count.
- **Redis has 16 databases** unless configured otherwise, so with a base index of 0 that's up to 16 workers.
- **Pub/sub isn't isolated.** Channels are shared across Redis databases, so parallel scenarios mustn't rely on a channel name being theirs alone.
- **Suite code that calls WireMock's admin API itself** sees every worker's requests. Use `world.wiremock`, which is namespaced, instead.
- **Stubs that echo the request path** (response templates using `request.path` or `request.url`, or `proxyBaseUrl`) see the worker's prefix.

The reference suite, `tests/parallel`, runs a service with WireMock, Postgres and Redis behind it, and an SPA, in four workers: `npm run test:parallel`, with the containers from `.github/workflows/ci.yml` running. `CTF_NO_ISOLATION=1` (or `wiremock`, `database` or `redis`) turns isolation off, to watch the scenarios fail.

## Making component suites fast in CI

Ways consumers have cut their component suites' run time, parallel or not:

- **Postgres without durability.** A database that lives for one CI job needn't survive a crash, and flushing to disk is the most expensive part of database-heavy tests. Start it with `-c fsync=off -c synchronous_commit=off -c full_page_writes=off`. A GitHub Actions `services:` container can't take `-c` flags, but all three settings can be changed on a running server, as secure-repo does:
  ```sh
  psql -h 127.0.0.1 -U postgres -c "ALTER SYSTEM SET fsync = off" \
    -c "ALTER SYSTEM SET synchronous_commit = off" \
    -c "ALTER SYSTEM SET full_page_writes = off" -c "SELECT pg_reload_conf()"
  ```
- **Cheap password hashing for seeded users.** Seed test users with the lowest bcrypt cost (4, Go's `bcrypt.MinCost`) rather than the production default: each hash costs 2^cost rounds, so a login takes a fraction of a millisecond rather than tens of milliseconds. Keep one test that checks production code uses the real cost, as secure-repo does.
- **Prebuilt binaries.** Build the service once and point `binaryEnvVar` at the binary, rather than `go run` (or the equivalent) compiling it when the suite starts.
- **Load common stubs once per scenario in one request** with `wiremockBaseline`, rather than a POST per stub.
- **DELETE rather than TRUNCATE** for cleanup, which `cleanupTables` already does: on near-empty tables it's about 40 times faster.
