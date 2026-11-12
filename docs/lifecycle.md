# Lifecycle

## Starting the service under test

`registerServiceUnderTest` starts a service (API, worker, test server) before the suite and stops it after, so a harness is the service's configuration and its environment:

```typescript
import { registerServiceUnderTest } from '@bearingsoftware/component-test-framework/core'

const api = registerServiceUnderTest({
  name: 'api',
  cwd: BACKEND_ROOT,
  cmd: 'go',
  args: ['run', './cmd/api'],
  binaryEnvVar: 'API_BIN', // run this prebuilt binary instead, when set
  skipEnvVar: 'SKIP_API_SPAWN', // =1: it's already running, leave it alone
  beforeStart: clearSettings, // before every start, restarts included
  env: { ...process.env, LISTEN_ADDR: ':18080', DATABASE_URL },
  logFile: path.join(__dirname, '..', '.api.log'),
  readyCheck: { url: 'http://localhost:18080/health' }, // or { probe: async () => boolean }
  healthTimeoutMs: 60_000,
  stopGraceMs: 15_000, // SIGINT, then SIGKILL after this
})

// Settings read once at start-up: restart with them changed for tagged
// scenarios, and with the original environment afterwards.
api.restartForTag('@actuation-locked', { ACTUATION_DISABLED: 'true' })
```

- **Process group and log.** The service runs in its own process group, so stopping it also stops anything it spawned (`go run` starts a child). Its output goes to `logFile`, which a restart keeps writing to. `appendLog` keeps an earlier run's log too.
- **Unexpected exits.** A service that dies on its own is reported on the console with its exit code.
- **Environment.** `env` is read when `registerServiceUnderTest` is called, at module load, not when the service starts.
- **Order.** Services start in the order they're registered. Register a dependency, such as a test server the API calls, first. Cucumber still runs later `BeforeAll` hooks when an earlier one fails, so a failed dependency can be followed by a slow failure of the service that needed it.
- **Stopping.** All registered services are stopped together, in parallel, after the suite. A stop waits for the service and every member of its process group to exit (POSIX only; Windows has no groups, so it waits for the service and its output; on Linux, members that are only unreaped zombies count as gone, elsewhere run containers with `--init` or tini so orphans are reaped), then sends SIGKILL to the group after `stopGraceMs`.
- **Failures are reported at once.** A missing command, or a service that exits before it's ready, fails the start immediately, naming the log. A service that never becomes ready is stopped, so it can't hold its port into the next run.
- **Skipping.** When `skipEnvVar` is `1`, the service isn't started, prepared or stopped, and `restartForTag` skips its scenarios.
- **Tags don't combine.** A scenario with two `restartForTag` tags is restarted for each, and runs with the last one's settings.

For more control, `startService(options)` does the same without registering hooks and returns a handle with `restart(envOverrides)` and `stop()`. `stopServices(a, b)` stops several at once. The older `spawnServiceUnderTest` still works, and also takes `binaryEnvVar`, `stopGraceMs` and `appendLog`; its handle gains `restart`.

**Patterns that keep runs fast and reliable:**

- **Build the binary once in CI** (`go build -cover`) and pass it with `binaryEnvVar`, rather than `go run` per job. Set `GOCOVERDIR`, and give `stopGraceMs` time (15s is safe) for coverage to be written on exit.
- **Shorten background intervals through the environment** (tick, poll and backoff settings), so scenarios don't wait on a schedule. Set them to 0 where the service supports turning the work off.
- **Point every vendor URL at WireMock** in the service's environment.
- **Clear state the service reads once at boot** in `beforeStart`. A table the previous run left behind otherwise reconfigures this one.

## Lifecycle hooks

Suites used to add their own `Before`/`After` hooks and rely on the order Cucumber runs them in, for example to collect coverage before the framework closes the page. The `hooks` option runs suite code at fixed points instead:

```typescript
registerHooks({
  ...loadConfig(),
  webBaseUrl: WEB_BASE_URL,
  pages: { login: LoginPage, dashboard: DashboardPage }, // no registry hook needed
  wiremockBaseline: ['wiremock/login'], // stubs every scenario needs
  hooks: {
    afterReset: (world) => world.remember('tenant', world.uniqueId('tenant')),
    onScenarioFailed: async (world, scenario) => {
      const name = scenario.pickle.name.replace(/[^\w-]+/g, '_')
      await world.page?.screenshot({ path: `reports/${name}.png` })
    },
    beforePageClose: (world) => collectCoverage(world),
  },
  cleanup: (world) => emptyBucket(world),
})
```

| Hook               | When                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `afterReset`       | After the per-scenario reset (world state, WireMock reset and baseline stubs, Redis flush). It runs before the framework's `@ui` hook, so there's no page yet, and before `Before` hooks registered after `registerHooks` |
| `onScenarioFailed` | When a scenario has failed, including an undefined, ambiguous or pending step, before anything is torn down; the page is still open. If it throws, cleanup still runs and the error is reported after it                  |
| `beforePageClose`  | In `@ui` scenarios, just before the framework closes the page. The page is closed even if it throws                                                                                                                       |
| `cleanup` (option) | After each scenario, after the `cleanupTables` cleanup                                                                                                                                                                    |

After a scenario the order is: `onScenarioFailed` (if it failed), cleanup, `beforePageClose`, then the page closes.

`wiremockBaseline` directories use WireMock's layout, `<dir>/mappings/*.json`, and need `wiremockUrl`. A missing directory, a baseline without WireMock, and `pages` without `webBaseUrl` are reported when `registerHooks` is called, not in every scenario.

## Before the suite

Each `BeforeAll` hook runs in the order it was registered. The `migrations` option runs in the Postgres adapter's `BeforeAll`, which `registerHooks` registers, and before the worker database copy when `workerIsolation.database` is set. A service registered with `registerServiceUnderTest` before `registerHooks` therefore starts, and runs its `beforeStart`, before the migrations. Call `runMigrations` in that `beforeStart`, or register the service after `registerHooks`. See [Migrations](postgres.md#migrations).

## Scenario lifecycle

Each scenario follows this lifecycle:

1. **Before** -- Reset world state, reset WireMock (if configured), load the `wiremockBaseline` stubs, flush Redis (if configured), run each of your [adapters](adapters.md)' `beforeScenario`, then run the `afterReset` hook
2. **Before @ui** -- Launch Chromium browser and page, and create the `pages` page objects
3. **Steps** -- Execute scenario steps
4. **After** -- Run `onScenarioFailed` and each adapter's `onScenarioFailed` (if the scenario failed), run your adapters' `afterScenario` in reverse order, close Valkey subscriptions, clear the `cleanupTables` (DELETE, falling back to TRUNCATE ... CASCADE; see [Postgres](postgres.md)), then run the `cleanup` option. Every step runs even if an earlier one throws; the first error is reported
5. **After @ui** -- Run `beforePageClose`, then close the page
