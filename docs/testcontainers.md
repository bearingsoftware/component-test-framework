# Testcontainers

`startContainers` starts Postgres, Redis (or Valkey) and WireMock in Docker for a run, so a suite needs no `docker-compose.yml`. It is opt-in: a suite that doesn't call it is unchanged.

Install the packages it needs (they are optional peers, loaded only when something has to start):

```bash
npm install -D testcontainers @testcontainers/postgresql @testcontainers/redis
```

It needs Docker and Node 22.22 or later (testcontainers 12 requires that).

## `cucumber.mjs`

Containers start in the Cucumber config file, before any support code loads, so the URLs they set are in the environment when `support/setup.ts` runs, in the main process and in every parallel worker. The config must be an ES module, because it uses a top-level `await`:

```js
// cucumber.mjs
import { cucumberPreset } from '@bearingsoftware/component-test-framework/preset'
import { startContainers } from '@bearingsoftware/component-test-framework/testcontainers'

await startContainers({
  postgres: { image: 'postgres:17-alpine', database: 'app' },
  redis: { image: 'valkey/valkey:8-alpine' }, // or redis:7-alpine
  wiremock: { image: 'wiremock/wiremock:3.13.2', mappingsDir: './mappings' },
})

export default cucumberPreset()
```

Run `npx cucumber-js`. `support/setup.ts` stays as it is.

`ctf init --containers` writes this file, in place of `cucumber.js` and `docker-compose.yml`, for the pieces in `--with` (not `mailpit`, which has no container).

| Option | Meaning |
|---|---|
| `postgres` | `image` (required); `database`, `username`, `password`. The database is the template that `postgresAdapter`'s `migrations` and `workerIsolation` copy from. |
| `redis` | `image` (required). Valkey images work here too. |
| `wiremock` | `image` (required); `mappingsDir` is mounted read-only as WireMock's mappings. |
| `reuse` | See [Reuse](#reuse). Off by default. |

`startContainers` returns `{ started, skipped }`: the services it started and the ones it left alone.

### Moving from `cucumber.js`

Rename `cucumber.js` to `cucumber.mjs` and change it to ES module syntax:

```js
// before: cucumber.js
const { cucumberPreset } = require('@bearingsoftware/component-test-framework/preset')
module.exports = { default: cucumberPreset() }

// after: cucumber.mjs
import { cucumberPreset } from '@bearingsoftware/component-test-framework/preset'
export default cucumberPreset()
```

`__dirname` is not defined in an ES module; use `import.meta.dirname`. The rest of the suite stays CommonJS.

## Which variable wins

A service starts only when its variable is unset: `DATABASE_URL` for Postgres, `REDIS_URL` for Redis and `WIREMOCK_URL` for WireMock. When it is set, that service is yours and nothing starts. CI that already provides services sets the variables, so no container starts there and `testcontainers` is not even imported. This reads `process.env`, not `loadConfig()`, because `loadConfig` defaults the WireMock URL.

When it does start a service, it sets the variable from the container, on a random port.

If a package is missing, the error names the `npm install` command and says to set the variables to use your own.

## Parallel runs

One set of containers is started by the main process before the workers spawn, and shared. [`workerIsolation`](parallel.md) already separates the workers inside one WireMock (a namespace per worker), one Postgres server (a database per worker, copied from the template) and one Redis (an index per worker), so a container per worker would add memory and startup time for no more isolation. The Redis limit of 16 databases still applies.

## Reuse

`reuse: true` keeps the containers between runs: the next run finds them and skips the start. It is for local development only. Reused containers are not managed by Ryuk and are never stopped, by this package or on exit; they stay running until you remove them (`docker rm -f`). Identical options share one container, so state a previous run left in it is still there. Leave it off in CI.

## Cleanup

Without `reuse`, the containers are removed when the run ends:

- Testcontainers' Ryuk helper removes them within seconds if the process crashes or is killed.
- On a normal end, `startContainers` stops them itself, in the process that started them and never in a worker. Cucumber ends the process with `process.exit`, so this is a synchronous `docker rm --force` when no async stop has run. A failure to stop is logged once and swallowed: the run is over anyway.

`stopContainers()` (exported next to `startContainers`) stops them earlier.

## Startup time

Measured once, on one machine (Docker 29.8, images already pulled, testcontainers 12.2.1). Yours will differ, and image pulls are not included.

| | cold (first run, includes Ryuk) | warm | reuse, second run |
|---|---|---|---|
| Postgres 17-alpine | 3.8 s | 1.9 s | 0.06 s |
| Redis 7-alpine | 0.19 s | 0.18 s | about 0 |
| Valkey 8-alpine | 0.22 s | 0.17 s | about 0 |
| WireMock 3.13.2 | 1.2 s | 1.2 s | 0.02 s |

The services start side by side.
