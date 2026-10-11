# Component Test Framework (TypeScript)

A reusable Cucumber-based component test framework for testing deployed services as isolated building blocks. Provides generic Gherkin step definitions for API testing (driven by OpenAPI operation IDs), UI testing (Playwright + Page Object Model), and worker/background service testing.

Services under test run against real infrastructure (PostgreSQL, Redis) while external API dependencies are mocked with WireMock.

## Installation

```bash
npm install component-test-framework
```

Peer dependencies (install in your project):

```bash
npm install @cucumber/cucumber @playwright/test
```

Playwright is optional -- only needed if you use the `@ui` tagged features. It is loaded when the first `@ui` scenario starts, so suites without UI scenarios don't need it installed to run. The published type declarations still reference Playwright's types, so type-checking with `skipLibCheck: false` needs it installed.

## Project Setup

A consuming project provides its own feature files, fixtures, operation map, and page objects. Typical structure:

```
my-project/
  test/component/
    package.json              # depends on component-test-framework
    cucumber.js               # Cucumber profiles
    support/
      setup.ts                # registerHooks + step imports
      operation-map.ts        # maps your API's operationIds to paths
    fixtures/
      requests/
        auth/login-valid.json
      responses/
        auth/login-success.json
      wiremock/
        my-vendor/mappings/*.json
    pages/                    # Page Object Models (for UI tests)
      login.page.ts
      dashboard.page.ts
    features/
      api/auth.feature
      ui/login.feature
```

### support/setup.ts

This is the entry point that wires the framework into your project:

```typescript
import {
  registerHooks,
  loadConfig,
  // Importing step modules registers them with Cucumber
  apiSteps,
  responseSteps,
  wiremockSteps,
  serviceSteps,
  uiSteps,
} from 'component-test-framework'
import { operationMap } from './operation-map'

// Suppress unused variable warnings -- imports register steps as a side effect
void apiSteps
void responseSteps
void wiremockSteps
void serviceSteps
void uiSteps

registerHooks({
  ...loadConfig(),
  operationMap,
  cleanupTables: ['users', 'integrations', 'readings'],
})
```

### support/operation-map.ts

Maps each OpenAPI `operationId` from your spec to its HTTP method and path:

```typescript
import type { OperationMap } from 'component-test-framework'

export const operationMap: OperationMap = {
  login:              { method: 'POST', path: '/auth/login' },
  register:           { method: 'POST', path: '/auth/register' },
  listIntegrations:   { method: 'GET',  path: '/integrations' },
  createIntegration:  { method: 'POST', path: '/integrations' },
  deleteIntegration:  { method: 'DELETE', path: '/integrations/{id}' },
  dashboardSummary:   { method: 'GET',  path: '/dashboard/summary' },
  // ...
}
```

### cucumber.js

Configure Cucumber profiles to run subsets of tests:

```javascript
module.exports = {
  default: {
    requireModule: ['ts-node/register'],
    require: ['support/**/*.ts', 'pages/**/*.ts'],
    format: ['progress-bar', 'html:reports/cucumber-report.html'],
  },
  api: {
    requireModule: ['ts-node/register'],
    require: ['support/**/*.ts'],
    paths: ['features/api/**/*.feature'],
  },
  ui: {
    requireModule: ['ts-node/register'],
    require: ['support/**/*.ts', 'pages/**/*.ts'],
    paths: ['features/ui/**/*.feature'],
    tags: '@ui',
  },
}
```

## Configuration

All configuration is loaded from environment variables via `loadConfig()`. Override any value by passing a partial config object.

| Environment Variable | Default | Description |
|---|---|---|
| `API_BASE_URL` | `http://localhost:8080` | Base URL of the API under test |
| `WEB_BASE_URL` | `http://localhost:3000` | Base URL of the web UI under test |
| `WIREMOCK_URL` | `http://localhost:8443` | WireMock admin API base URL |
| `DATABASE_URL` | _(none)_ | PostgreSQL connection string |
| `REDIS_URL` | _(none)_ | Redis connection string |
| `FIXTURES_DIR` | `./fixtures` | Path to your fixtures directory |
| `WIREMOCK_STUBS_DIR` | `{FIXTURES_DIR}/wiremock` | Root for `the WireMock stub {string} is registered`. A warning is logged at start-up if it doesn't exist |

### Options only available in code

| Option | Default | Description |
|---|---|---|
| `operationMap` | `{}` | Your API's operationId-to-path map |
| `cleanupTables` | _(none)_ | Tables to clear after each scenario, children first |
| `defaultStepTimeout` | _(Cucumber's 5s)_ | Timeout in ms for every step and hook. Leave unset to keep a `setDefaultTimeout` call of your own |
| `waitTimeout` | _(see [Waiting](#waiting))_ | How long UI and assertion waits poll before failing, in ms |
| `auth` | _(none)_ | How the API issues tokens: `loginPath`, `tokenPath` (default `access_token`), `refreshTokenPath`, `loginMethod`, `loginBody`. See [Requests, values and login](#requests-values-and-login) |
| `hooks` | _(none)_ | Suite code at fixed points: `afterReset`, `onScenarioFailed`, `beforePageClose`. See [Lifecycle hooks](#lifecycle-hooks) |
| `pages` | _(none)_ | Page object classes by name, created for every `@ui` scenario. Needs `webBaseUrl` |
| `wiremockBaseline` | _(none)_ | WireMock stub directories, relative to `fixturesDir`, loaded after every reset |
| `cleanup` | _(none)_ | Cleanup after each scenario for what `cleanupTables` doesn't cover |
| `serviceWaitTimeout` | `30000` | How long waits for background work (DB record waits, opt-in WireMock and DB steps) poll, in ms |

### Suites that don't use WireMock or an API

`wiremockUrl` and `apiBaseUrl` are optional in `registerHooks`. Leave one out (or set it to `''` or `undefined` after `loadConfig()`) and the framework skips it:

- Without `wiremockUrl`, there's no readiness wait and no reset before each scenario. Any WireMock step fails with "WireMock is not configured".
- Without `apiBaseUrl`, any API step fails with "apiBaseUrl is not configured".

```typescript
// A UI-only suite: no WireMock, no API, no database.
registerHooks({
  ...loadConfig(),
  wiremockUrl: undefined,
  apiBaseUrl: undefined,
  defaultStepTimeout: 30_000,
})
```

## Fixtures

Fixtures are JSON files organized by category under your `FIXTURES_DIR`:

```
fixtures/
  requests/auth/login-valid.json
  requests/auth/register-valid.json
  responses/auth/login-success.json
  responses/auth/login-unauthorized.json
  seeds/users/admin-user.json
  wiremock/sunsynk/mappings/auth_login.json
  wiremock/sunsynk/__files/token_response.json
```

### Path and Query Parameters

Request fixtures can include `_pathParams` and `_queryParams` keys. These are extracted before sending and used to resolve the URL. They are not sent in the request body.

```json
{
  "_pathParams": { "id": "int-123" },
  "_queryParams": { "page": "2", "per_page": "50" },
  "identifier": "INV-456",
  "credentials": { "email": "a@b.com" }
}
```

Given an operation with path `/integrations/{id}`, this produces:
`GET /integrations/int-123?page=2&per_page=50` with body `{"identifier":"INV-456","credentials":{"email":"a@b.com"}}`.

## Step Definitions

### API Steps

Driven by the operation map. The `{word}` parameters are fixture file paths (without `.json`) and operationIds.

| Step | Description |
|---|---|
| `Given I send the request {word} to the {word} operation` | Send authenticated request to an operation |
| `Given I send the request {word} to the {word} operation with token {word}` | Send with explicit token |
| `Given I send the request {word} to the {word} operation without authentication` | Send without auth header |
| `When I authenticate with the request {word} to the {word} operation` | Send login request and store tokens in world |

Example:

```gherkin
Scenario: Successful login
  When I authenticate with the request auth/login-valid to the login operation
  Then the response status should be 200
  And the response body at access_token should not be empty
```

### Response Assertion Steps

Assert against the last API response stored in the world.

| Step | Description |
|---|---|
| `Then the response status should be {int}` | Assert HTTP status code |
| `Then the response body should match {word}` | Deep partial match against a response fixture |
| `Then the response body at {word} should equal {string}` | Assert a dot-path value in the response |
| `Then the response body at {word} should be an integer` | Assert a field is an integer |
| `Then the response body at {word} should contain {int} items` | Assert array length at a path |
| `Then the response should contain header {word} with value {string}` | Assert a response header value |
| `Then the response should contain header {word}` | Assert a response header exists |

The `match` step uses **partial matching**: every key in the expected fixture must exist in the actual response with the same value, but extra keys in the response are ignored.

### WireMock Steps

Manage external API stubs during scenarios.

| Step | Description |
|---|---|
| `Given the {word} API is stubbed from {word}` | Load WireMock mappings from a fixture directory |
| `Given the {word} API returns HTTP {int}` | Override all routes for a provider with a status code |
| `Given the {word} API at {string} returns HTTP {int}` | Override a specific path |
| `Given the {word} API at {string} returns the response {word}` | Override a path with a fixture body |
| `Then the {word} API at {string} was called {int} time(s)` | Wait until a specific path has been called exactly N times |
| `Then the {word} API was called {int} time(s)` | Wait until a provider has been called exactly N times in total |

`the {word} API is stubbed from {word}` sends every mapping in the directory to WireMock in a single `/__admin/mappings/import` call. Mapping files can hold one mapping or WireMock's multi-mapping form, `{ "mappings": [...] }`. Stub precedence is the same as registering each mapping in turn: for equal priorities, the last file wins. Tested against WireMock 3.9.

Each admin request to WireMock times out after 10s, so a stalled WireMock fails a step rather than hanging the run.

From code, `this.wiremock` exposes the client. Its `baseUrl` is public, and `getRequestCount`, `verifyCallCount` and `findRequests` take an optional filter: `method`, `exactPath` (match the path literally rather than as a regex) and `bodyJsonPath`:

```typescript
const posts = await this.wiremock.getRequestCount('/vendor/orders', {
  method: 'POST',
  bodyJsonPath: "$[?(@.status == 'active')]",
})
```

Example:

```gherkin
Scenario: Handle vendor API failure
  Given the sunsynk API is stubbed from wiremock/sunsynk
  And the sunsynk API at "/api/v1/inverter/readings" returns HTTP 500
  When I send the request dashboard/summary to the dashboardSummary operation
  Then the response status should be 502
  And the sunsynk API at "/api/v1/inverter/readings" was called 1 time
```

### Service Call Tracking Steps

Generic steps for calling services and counting invocations. Call counts are tracked in the Cucumber world and persist across steps within a scenario.

| Step | Description |
|---|---|
| `When the service {word} is called with the request {word} it returns the response {word}` | Call service, compare response with fixture |
| `Then the request to the service {word} with request {word} was called {int} time(s)` | Assert call count |
| `Then the total calls to the service {word} should be {int}` | Assert total calls to a service |
| `When I wait for a new record in {word} matching {string}` | Poll DB until a matching row appears |
| `When I wait for {int} record(s) in {word} matching {string}` | Poll DB until at least N matching rows exist |
| `Then the {word} table contains {int} row(s) matching {string}` | Wait until exactly N rows match |
| `Then the {word} table is empty` | Wait until the table is empty |

The two `I wait for` steps poll for `serviceWaitTimeout` (30s by default, as they always have). Table names must be plain SQL identifiers, such as `jobs`, not `schema.jobs`. Predicates are inserted into the SQL as written, so they must come from your own feature files. A query error fails the step at once rather than being retried.

### UI Steps (Playwright)

Tag scenarios with `@ui` to activate Playwright browser lifecycle. All element interaction uses `data-testid` attributes.

| Step | Description |
|---|---|
| `Given I navigate to the {word} page` | Navigate to a registered page |
| `When I click on the {word} on the {word} page, then save the value of {word}` | Click element, save another element's value |
| `When I click on the {word} on the {word} page` | Click an element |
| `When I fill {word} with {string} on the {word} page` | Type into an input |
| `When I save the value of {word} on the {word} page` | Save an element's current value |
| `Then the saved value {word} should be {string}` | Assert a previously saved value |
| `Then the saved value {word} should not be empty` | Assert a saved value is non-empty |
| `Then I should see {word} on the {word} page` | Wait for an element to be visible |
| `Then I should not see {word} on the {word} page` | Wait for an element to be hidden or removed |
| `Then the {word} page should be displayed` | Wait for the URL to contain the page's path |

Example:

```gherkin
@ui
Scenario: Login and view dashboard
  Given I navigate to the login page
  When I fill login-email with "test@example.com" on the login page
  And I fill login-password with "SecurePass123!" on the login page
  And I click on the login-submit on the login page
  Then the dashboard page should be displayed
  And I should see dashboard-battery-level on the dashboard page
```

### Page Object Model

Create page objects by extending `BasePage`. Register them in the world during setup:

```typescript
import { BasePage } from 'component-test-framework'
import type { Page } from '@playwright/test'

export class LoginPage extends BasePage {
  constructor(page: Page, baseUrl: string) {
    super(page, baseUrl)
  }
  get url() { return '/login' }
}

export class DashboardPage extends BasePage {
  constructor(page: Page, baseUrl: string) {
    super(page, baseUrl)
  }
  get url() { return '/' }
}
```

Register pages in a Before hook:

```typescript
import { Before } from '@cucumber/cucumber'
import type { ComponentTestWorld } from 'component-test-framework'
import { LoginPage } from '../pages/login.page'
import { DashboardPage } from '../pages/dashboard.page'

Before({ tags: '@ui' }, function (this: ComponentTestWorld) {
  const baseUrl = this.config.webBaseUrl!
  this.pageRegistry.set('login', new LoginPage(this.page!, baseUrl))
  this.pageRegistry.set('dashboard', new DashboardPage(this.page!, baseUrl))
})
```

## Requests, values and login

### Saved values

The world keeps named values for the scenario, so one step can save an id that a later request needs:

```typescript
this.remember('org', body.id)       // keep a value
this.recall<number>('org')          // read it back; throws, naming what is kept, if missing
this.uniqueId('owner')              // e.g. "owner-k3x9q2": the same all scenario, new next scenario
```

Values and unique ids are cleared before each scenario.

### Sending requests from your own steps

`sendOperation` is what the `I send the request … to the … operation` steps use. Call it for anything they don't cover:

```typescript
import { sendOperation } from '@bearingsoftware/component-test-framework'

await sendOperation(this, 'getScan', {
  requestFile: '_empty',                       // or a fixture name; _empty means none
  pathParams: { oid: this.recall('org'), sid: this.recall('scan') },
  queryParams: { page: '2' },
  headers: { 'X-Request-Id': 'abc' },
  auth: 'current',                             // or 'none', or { token: '…' }
})
```

It fills every `{placeholder}` in the path (explicit values win over the fixture's `_pathParams`), keeps `_queryParams`, and records the response, headers included, as the last response. Headers you pass win over the defaults, including an `Authorization` of your own. `rawBody` and `contentType` send a body other than the fixture's JSON; a GET or HEAD can't have one.

### Login

Tell the framework how the API issues tokens:

```typescript
registerHooks({
  ...loadConfig(),
  auth: {
    loginPath: '/auth/login',
    tokenPath: 'token',                          // where the token is in the response; default access_token
    loginBody: (username, password) => ({ email: username, password }), // the default
  },
})
```

`tokenPath` is also used by the existing `I authenticate with the request … to the … operation` step.

**Logging in before tagged scenarios.** `registerLoginTag` replaces hand-written `@auth-required` hooks. Register it after `registerHooks`, so it runs after the per-scenario reset:

```typescript
registerLoginTag('@auth-required', {
  before: (world) => seedUser(world, 'owner@example.com'),   // optional
  credentials: { username: 'owner@example.com', password: 'Sup3rSecret!' },
  cache: false, // true reuses the worker's first login; see below
})
```

`cache: true` is only safe when the user, its session and everything its token refers to outlive a scenario. It isn't safe when cleanup deletes the user, when `before` seeds data the token carries (such as a household id in a claim), or when a scenario logs out or revokes the session. `clearLoginCache()` empties the cache.

Helpers: `login(world, username, password)`, `requestLogin(config, username, password)` (doesn't change the world), `adoptTokens(world, body, { refresh })` and `jwtClaims(token)` (decodes without verifying). A login or adopt replaces the refresh token, clearing it when the response has none, so an earlier user's can't linger. Errors about tokens name the response's keys, never its values, so tokens stay out of CI logs.

### Opt-in request steps

`registerRequestSteps()` adds steps worded as secure-repo and joule-genie wrote them. Like the waiting steps, they're registered only when called: delete your own copies first, then call it once, after `registerHooks`. It registers all of them, so a suite that wants to keep its own version of one of these steps can't use it yet.

**Migrating:** these steps keep values with `world.remember` and read them with `world.recall`. Your own steps that read or write those values (for example a seed step that saves an id for a later `saved as` step) must use the same methods, not their own fields such as `world.savedIds`.

| Step | Description |
|---|---|
| `Given I capture the id as {word}` | Remember the last response's `id` |
| `Given I capture {word} from the last response as {word}` | Remember any value, e.g. `items[0].id` |
| `When I send the request {word} to the {word} operation with {word} saved as {word}` | Fill a placeholder from a remembered value |
| `When I send the request {word} to the {word} operation with saved id {word}` | Fill `{id}` from a remembered value |
| `When I send the request {word} to the {word} operation with oid from last response` | Fill any placeholder (`oid`, `sid`, …) from the last response's `id`; `with id from last response` is the existing step |
| `When I send the request {word} to the {word} operation with {word} {word} and {word} from last response` | One placeholder from a remembered value, another from the last response's `id` |
| `When I send an authed {word} to {string} with body {string}` | Raw request with the current token |
| `When I log in as {string} with password {string}` | Log in; fails if refused. Doesn't change the last response |
| `When I attempt to log in as {string} with password {string}` | Log in without failing; the response becomes the last response |
| `When I remember the current token as {word}` / `When I use the remembered token {word}` | Keep a token aside and switch back to it |
| `When I adopt the tokens from the last response` | Use the token pair in the last response; fails if either token is missing |
| `Then the response body contains {string}` / `does not contain {string}` | Text anywhere in the JSON body |
| `Then the response header {word} contains {string}` | Part of a header value |
| `Then the response body at {word} should be a non-empty string` | A non-empty string at a path |
| `Then the response body at {word} should not be empty` | Not null, `""`, `[]` or `{}` |
| `Then the response body should contain {int} items` | Length of a root array |
| `Then the response body should not have {word}` | A top-level key is absent |
| `Then the token at {word} in the response has claim {word} equal to {string}` | A JWT claim, e.g. `access_token`, `tier`, `beta` |
| `Then I dump the last response` | Write status and body to stderr |

Response paths accept `a.b`, `items[0].id` and `items.0.id` (`valueAt`).

## Waiting

Services, workers and SPAs settle asynchronously, so assertions on them wait rather than check once. Each one polls until its condition holds, and passes as soon as it does. A page or table that's already right is no slower.

**How long steps wait.** There are two budgets:

- **UI and assertions** (`I should see`, `was called N times`, `table contains N rows` and the opt-in UI steps): `waitTimeout` if set, otherwise 1s less than `defaultStepTimeout` (so the step reports what it was waiting for before Cucumber's own timeout fires), otherwise 4s (just under Cucumber's 5s default).
- **Background work** (the DB `I wait for` steps and the opt-in WireMock and DB steps): `serviceWaitTimeout`, default 30s.

If your suite calls `setDefaultTimeout` itself, set `waitTimeout` too, a little below it. Waits are never shorter than 1ms, because Playwright treats 0 as "wait forever".

**Counts that can only grow fail early.** `was called {int} time(s)` fails straight away if WireMock has already received more requests than expected.

### Opt-in waiting steps

Several suites wrote their own waiting steps. The framework now provides them, with the same wording, but registers them only when you call `registerWaitingSteps()`. If they were registered automatically, a suite that still has its own copy would get two matching definitions, and Cucumber fails any step that matches both. Delete your copies, then:

```typescript
import { registerHooks, registerWaitingSteps, loadConfig } from '@bearingsoftware/component-test-framework'

const options = { ...loadConfig(), operationMap, waitTimeout: 10_000 }
registerHooks(options)
registerWaitingSteps(options)
```

UI steps wait up to `waitTimeout`; WireMock and DB steps up to `serviceWaitTimeout`. Each gets a Cucumber timeout 1s longer than its wait. Steps that watch a window you set in the feature file (`over {int} seconds`, `for {int} seconds`) have no Cucumber timeout; their own waits bound them.

**Migrating.** Keep the waits your copies used, or flakes they fixed can come back:

| Suite | Copies waited | Set |
|---|---|---|
| joule-genie web | 25s (JG-829) | `waitTimeout: 25_000` |
| joule-genie admin, secure-repo web, health-web | 10s | `waitTimeout: 10_000` |
| joule-genie worker | 30s | nothing: `serviceWaitTimeout` defaults to 30s |

health-web words some steps differently (`WireMock has received …`, `I accept the next confirmation on …`), so it keeps those.

| Step | Description |
|---|---|
| `Then the {word} page should eventually be displayed` | Wait for the URL to end with the page's path. A query string, `#hash` or trailing `/` after it doesn't match, as with the steps it replaces |
| `Then the URL should contain {string}` | Wait for the URL to contain a fragment |
| `Then I should eventually see {word} on the {word} page` | Wait for an element to be visible |
| `Then I should eventually not see {word} on the {word} page` | Wait for an element to be removed from the page |
| `Then I should still see {word} on the {word} page` | Assert an element is visible now, without waiting |
| `Then I should eventually see {word} containing {string} on the {word} page` | Wait for an element's text to contain a string |
| `Then {word} on the {word} page should eventually read {string}` | Wait for an element's trimmed text to equal a string |
| `Then the {word} on the {word} page should have value {string}` | Wait for an input's value |
| `When I hover over {word} on the {word} page` | Hover over an element |
| `When I select {string} from {word} on the {word} page` | Choose an option in a select |
| `Given I accept the next confirm dialog` | Accept the next `confirm()` |
| `Given I dismiss the next confirm dialog` | Dismiss the next `confirm()` |
| `Then the {word} API eventually receives {int} {word} request(s) to {string}` | Wait for at least N requests with this method to a path pattern |
| `Then the {word} API eventually receives {int} {word} request(s) to {string} whose body matches {string}` | As above, counting only bodies that match a JSONPath |
| `Then the {word} API receives exactly {int} {word} request(s) to {string} whose body matches {string} over {int} seconds` | Reach N, then stay at N for the window |
| `Then the {word} API receives no further {word} requests to {string} for {int} seconds` | Let the count settle (up to 7 reads 2s apart), require at least one request, then no new requests for the window |
| `Then the {word} table contains at least {int} row(s) matching {string}` | Wait for at least N matching rows |
| `When I wait for exactly {int} record(s) in {word} matching {string}` | Wait for exactly N matching rows, e.g. after a delete |

### In your own steps

The helpers behind these steps are exported:

```typescript
import { eventually, holdsFor, StopRetrying, waitTimeout } from '@bearingsoftware/component-test-framework'

Then('the export finishes', async function (this: ComponentTestWorld) {
  await eventually(
    async () => {
      const job = await fetchJob()
      if (job.state === 'failed') throw new StopRetrying('export failed') // no point waiting
      assert.equal(job.state, 'done')
    },
    { timeout: waitTimeout(this.config), description: 'waiting for the export' },
  )
})
```

- `eventually(check, { timeout, interval?, description? })` retries `check` until it stops throwing, then returns its result. On timeout it throws the last error, prefixed with the description and the time waited.
- `holdsFor(check, { duration, interval?, description? })` fails as soon as `check` throws during the window.
- `waitTimeout(config)` and `serviceWaitTimeout(config)` give the two budgets.
- `countRows(world, table, predicate?)` counts rows and validates the table name. `queryOnce(world, sql)` runs any query. A missing DB client, an unsafe table name or an error in the SQL itself (SQLSTATE class 42 or 22) throws `StopRetrying`, so a wait around it fails at once. Other errors, such as a dropped connection, are retried.
- `isStopRetrying(err)` recognises a `StopRetrying`, even one thrown by another installed copy of this package.
- Errors from a wait are the original error with context added to the message, so an `AssertionError` keeps its actual and expected values.
- `assertPartialMatch(actual, expected, { nullMatchesAnything? })` does the deep partial JSON match the response, service and Valkey steps use.
- `requestPattern(path, filter)` builds a WireMock request pattern.

## Starting the service under test

`registerServiceUnderTest` starts a service (API, worker, test server) before the suite and stops it after, so a harness is the service's configuration and its environment:

```typescript
import { registerServiceUnderTest } from '@bearingsoftware/component-test-framework'

const api = registerServiceUnderTest({
  name: 'api',
  cwd: BACKEND_ROOT,
  cmd: 'go',
  args: ['run', './cmd/api'],
  binaryEnvVar: 'API_BIN',          // run this prebuilt binary instead, when set
  skipEnvVar: 'SKIP_API_SPAWN',     // =1: it's already running, leave it alone
  beforeStart: clearSettings,       // before every start, restarts included
  env: { ...process.env, LISTEN_ADDR: ':18080', DATABASE_URL },
  logFile: path.join(__dirname, '..', '.api.log'),
  readyCheck: { url: 'http://localhost:18080/health' }, // or { probe: async () => boolean }
  healthTimeoutMs: 60_000,
  stopGraceMs: 15_000,              // SIGINT, then SIGKILL after this
})

// Settings read once at start-up: restart with them changed for tagged
// scenarios, and with the original environment afterwards.
api.restartForTag('@actuation-locked', { ACTUATION_DISABLED: 'true' })
```

- **Process group and log.** The service runs in its own process group, so stopping it also stops anything it spawned (`go run` starts a child). Its output goes to `logFile`, which a restart keeps writing to. `appendLog` keeps an earlier run's log too.
- **Unexpected exits.** A service that dies on its own is reported on the console with its exit code.
- **Environment.** `env` is read when `registerServiceUnderTest` is called, at module load, not when the service starts.
- **Order.** Services start in the order they're registered. Register a dependency, such as a test server the API calls, first. Cucumber still runs later `BeforeAll` hooks when an earlier one fails, so a failed dependency can be followed by a slow failure of the service that needed it.
- **Stopping.** All registered services are stopped together, in parallel, after the suite. A stop waits for the service and anything it spawned to exit, then sends SIGKILL to the group after `stopGraceMs`.
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
  pages: { login: LoginPage, dashboard: DashboardPage },  // no registry hook needed
  wiremockBaseline: ['wiremock/login'],                   // stubs every scenario needs
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

| Hook | When |
|---|---|
| `afterReset` | After the per-scenario reset (world state, WireMock reset and baseline stubs, Redis flush). It runs before the framework's `@ui` hook, so there's no page yet, and before `Before` hooks registered after `registerHooks` |
| `onScenarioFailed` | When a scenario has failed, including an undefined, ambiguous or pending step, before anything is torn down; the page is still open. If it throws, cleanup still runs and the error is reported after it |
| `beforePageClose` | In `@ui` scenarios, just before the framework closes the page. The page is closed even if it throws |
| `cleanup` (option) | After each scenario, after the `cleanupTables` cleanup |

After a scenario the order is: `onScenarioFailed` (if it failed), cleanup, `beforePageClose`, then the page closes.

`wiremockBaseline` directories use WireMock's layout, `<dir>/mappings/*.json`, and need `wiremockUrl`. A missing directory, a baseline without WireMock, and `pages` without `webBaseUrl` are reported when `registerHooks` is called, not in every scenario.

## Testing a single-page app

The `/spa` entry point covers what SPA suites need beyond the UI steps: serving the built app, forwarding its API calls to WireMock, browser-side coverage, failure screenshots, and a few browser helpers.

```typescript
import * as path from 'node:path'
import { registerHooks, loadConfig, registerUiSteps, registerWaitingSteps, type FrameworkOptions } from '@bearingsoftware/component-test-framework/core'
import { registerSpaServer, registerCoverage, saveFailureArtifacts } from '@bearingsoftware/component-test-framework/spa'

const SUITE = path.resolve(__dirname, '..')

// Serves web/dist on WEB_PORT (default 3100): its files, index.html for
// client-side routes, and /api/* forwarded to WireMock with /api removed.
const spa = registerSpaServer({
  distDir: path.resolve(SUITE, '../../dist'),
  apiUrl: process.env.WIREMOCK_URL ?? 'http://localhost:8443',
  runtimeEnv: { VITE_API_BASE_URL: '/api' },   // served as /__env.js: window.__ENV
  buildHint: '(cd web && npm run build:coverage)',
})

const coverage = registerCoverage({ outDir: path.join(SUITE, 'coverage') })

const options: FrameworkOptions = {
  ...loadConfig({ fixturesDir: path.join(SUITE, 'fixtures'), webBaseUrl: spa.baseUrl }),
  pages: { login: LoginPage, dashboard: DashboardPage },
  hooks: {
    onScenarioFailed: saveFailureArtifacts(path.join(SUITE, 'reports')),
    beforePageClose: (world) => (world.page ? coverage.collect(world.page) : undefined),
  },
}
registerHooks(options)
registerUiSteps()
registerWaitingSteps(options)
```

**Server** (`registerSpaServer`, or `startSpaServer` to manage it yourself):

| Option | Default | |
|---|---|---|
| `distDir` | | The build; must contain `index.html` |
| `apiUrl` | | Where API paths go, usually WireMock. A path in it goes in front of every forwarded path |
| `proxyPrefixes` | `['/api']` | Path prefixes to forward; `/api` matches `/api` and `/api/…`, not `/apiary` (a trailing slash makes no difference) |
| `stripPrefix` | `true` | Remove the prefix before forwarding (`/api/v1/x` → `/v1/x`); `false` keeps the full path |
| `runtimeEnv` | | Served as `/__env.js`, `window.__ENV = {…}`, from memory: the build isn't changed |
| `mimeTypes` | | Extra content types, e.g. `.webmanifest` |
| `buildHint` | | Named in the error when the build is missing |
| `portEnvVar`, `defaultPort` | `WEB_PORT`, `3100` | Where the port comes from (`registerSpaServer` only). Under `--parallel`, worker n adds n |

Before starting it checks the build exists; once listening it fetches `/` to prove the app is served.
- **Paths:** paths outside the build are refused.
- **Connections:** if the API drops a connection mid-response, the browser's is dropped too, rather than left waiting. When the browser abandons a request (navigating away from a stream, say), the API request ends too. Stopping the server ends any proxied requests still open.
- **Headers and redirects:** connection-level headers aren't passed on. A redirect from the API to its own address is pointed back through the server.
- **WebSockets:** upgrades aren't proxied; they get a 501.
- **Port:** `registerSpaServer` needs a fixed port, since the base URL is worked out before the server starts. Under Cucumber `--parallel`, each worker runs its own server on the port plus its worker number; see [Running in parallel](#running-in-parallel).

**Coverage** (`registerCoverage`, or `createCoverageCollector`) reads `window.__coverage__` from SPAs built with istanbul instrumentation, such as vite-plugin-istanbul. It waits for the document to load, then for the instrumented bundle to run (`loadTimeoutMs`, `evalTimeoutMs`, 6s each), so a page reloaded just before the scenario ended still counts. After the run it writes `coverage/lcov.info`, `coverage-summary.json`, the HTML report and `.nyc_output/out.json`. Under `--parallel`, each worker saves its own coverage in `.nyc_output/.workers` and rewrites the reports from every worker's, so the last worker to finish leaves the whole run's.
- `onMissingSample: 'throw' | 'warn'`: a page with no coverage fails the scenario (default) or is logged and counted.
- `onNothingCollected: 'skip' | 'throw'`: a run with no coverage at all writes nothing (default) or fails, so a broken build can't report a silent 0%.

It needs `istanbul-lib-coverage`, `istanbul-lib-report` and `istanbul-reports`. `collect` can wait up to `loadTimeoutMs + evalTimeoutMs` (12s by default) inside the framework's `@ui` After hook, so give the suite a step timeout above that, such as `setDefaultTimeout(30_000)`; under Cucumber's 5s default a missing sample shows as a timeout instead of the diagnostic message.

**Browser helpers**
- `saveFailureArtifacts(dir)`: an `onScenarioFailed` hook saving a full-page screenshot and the HTML, named after the scenario.
- `registerRouteBlocks(tag, routes)`: abort or answer requests to third parties in tagged scenarios (`{ url, fulfill? }`).
- `registerWebAuthnTag(tag)`: a virtual WebAuthn authenticator for passkey flows (Chromium).
- `registerAccessibilitySteps({ tags?, disableRules?, failOn? })`: `Then the {word} page should have no serious accessibility violations`, an axe scan failing on serious and critical violations by default. Needs `@axe-core/playwright`.

Register tagged hooks after `registerHooks`, whose `@ui` hook opens the page.

## Running in parallel

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

### Making component suites fast in CI

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

## OpenAPI tooling: the `ctf` command

The package installs a `ctf` command for keeping an operation map in step with the API's OpenAPI spec. It reads OpenAPI 3.0 and 3.1, and Swagger 2, as YAML or JSON. Reading a `.ts` map needs `typescript`, which a suite running on ts-node already has.

**Base path.** Spec paths get the path of the spec's first server URL in front (`servers: [{ url: /api/v1 }]`, or `http://localhost:8080/api/v1`), or Swagger 2's `basePath`, so they match what the suite sends. When a suite sees a different prefix, such as an SPA suite whose server strips `/api`, pass `--base-path`.

### Generating a map

```sh
npx ctf generate-operation-map backend/openapi.yaml --out support/operation-map.ts
```

The map has one entry per operation, named by its `operationId`, or, in a spec without them, by its method and path (`GET /projects/{id}/remediable` is `getProjectsByIdRemediable`). Each entry carries the operation's summary as a comment. It's exported `as const satisfies OperationMap`, with an `OperationName` type, so a mistyped name is a compile error. `--include` and `--exclude` take a regular expression to pick operations by name. In CI, `--check` fails if the file is out of date with the spec.

### Checking a hand-written map

```sh
npx ctf check-operation-map support/operation-map.ts backend/openapi.yaml
```

It fails when:
- **Not in the spec:** a map entry isn't in the spec.
- **Different path:** the spec has the same `operationId` at a different method or path.
- **Different name:** the spec gives the entry's route a different `operationId`.
- **Unreadable entry:** an entry can't be read, such as a spread or a computed path. It's reported rather than skipped.

It finds entries in the map file without running it, so entries a formatter has wrapped over several lines are checked too.

A spec without `operationId`s is matched by method and path instead. A map path may carry a test's concrete values (`/orgs/acme`, `?ecosystem=npm`) where the spec has a parameter, and parameter names needn't agree.

**Complete maps.** `--complete` also fails on spec operations the map leaves out. Use it for a map meant to cover the whole API, and leave it off for a suite that maps only what it uses.

**Several maps at once.** Check several maps, sharing one allowlist:

```sh
npx ctf check-operation-map \
  --complete-pair backend/__component_tests__/api/support/operation-map.ts=backend/openapi/openapi.yaml \
  --pair web/__component_tests__/cucumber/support/operation-map.ts=backend/openapi/openapi.yaml \
  --allowlist scripts/op-map-spec-allowlist.txt
```

**The allowlist.** It lists known gaps, one per line, as an operation name or `METHOD /path`, with `#` comments. An entry that no longer matches a problem fails as stale, so the list only shrinks.

### Auditing which operations features exercise

```sh
npx ctf audit-coverage backend/openapi.yaml --features features --map support/operation-map.ts
```

It prints each spec operation no feature file references, and on stderr, any name a feature uses that is neither a spec operation nor in the map: a typo, or a removed operation.
- **How references are found:** by default, the framework's step wording, "to the `<name>` operation". `--pattern` takes other wordings, each a regular expression with the name in its first group.
- **The map:** `--map` names the operations of a spec without `operationId`s, and adds the map's other names for an operation.
- **Exit code:** it exits 0, as an audit, unless given `--fail-on-gaps`. `--json` prints everything, with each operation's references.

The same functions are exported from `@bearingsoftware/component-test-framework/openapi` for scripts of your own.

## Entry points

The package root works as it always has: it exports everything and registers every built-in step when it's imported. Only the entry points below can be imported: deep paths into `dist/` are no longer reachable. Alongside it are entry points that register nothing on import, so a suite loads and registers only what it uses:

| Entry point | Contents |
|---|---|
| `@bearingsoftware/component-test-framework/core` | World, config, `registerHooks`, services, waiting, requests and login, the parallel-run helpers (`currentWorker`, `workerPort`, `worker…Url`, `prepareWorkerDatabase`), utilities, and `register…Steps()` for each step group |
| `…/wiremock` | `WireMockClient`, `requestPattern`, `registerWiremockSteps`, and the namespacing helpers `namespaceStub`, `namespaceUrlMatcher`, `namespaceId` |
| `…/postgres` | `DbClient`, `countRows`, `queryOnce`, `registerDbSteps`, `registerServiceSteps`, `prepareWorkerDatabase` |
| `…/redis` | `RedisClient`, `registerRedisSteps` |
| `…/playwright` | `BasePage`, `registerUiSteps` |
| `…/spa` | `registerSpaServer`, `registerCoverage`, `saveFailureArtifacts`, route blocks, WebAuthn, accessibility steps |
| `…/preset` | `cucumberPreset()`, a profile for `cucumber.js` |
| `…/openapi` | `loadSpec`, `readOperationMap`, `generateOperationMap`, `checkOperationMaps`, `auditCoverage`: the code behind the `ctf` command |

The step groups are `registerApiSteps`, `registerRawApiSteps`, `registerSseSteps`, `registerResponseSteps`, `registerWiremockSteps`, `registerDbSteps`, `registerRedisSteps`, `registerServiceSteps` and `registerUiSteps`, plus the opt-in `registerWaitingSteps` and `registerRequestSteps`. Calling one twice, or after importing the root, registers nothing more.

The database and Redis drivers (`pg`, `ioredis`) and Playwright load only when they're used, whichever entry point a suite imports. A UI-only suite never loads `pg` or `ioredis`.

### Migrating to the core entry point

Nothing has to change: the root import keeps working. To move a suite over:

1. **Imports.** Import from `/core` (and an adapter for anything stack-specific) instead of the root.
2. **Steps.** Replace the `void apiSteps` style imports with the matching calls:
   ```typescript
   // before
   import { registerHooks, apiSteps, responseSteps, uiSteps } from '@bearingsoftware/component-test-framework'
   void apiSteps; void responseSteps; void uiSteps

   // after
   import { registerHooks, registerApiSteps, registerResponseSteps, registerUiSteps } from '@bearingsoftware/component-test-framework/core'
   registerApiSteps(); registerResponseSteps(); registerUiSteps()
   ```
3. **Hooks that depend on order.** Move `Before`/`After` hooks that rely on running before or after the framework's into `hooks`: page registration into `pages`, coverage collection into `beforePageClose`, failure screenshots into `onScenarioFailed`, and stubs every scenario re-adds into `wiremockBaseline`.
4. **cucumber.js.** Optionally replace it with the preset:
   ```javascript
   const { cucumberPreset } = require('@bearingsoftware/component-test-framework/preset')
   module.exports = { default: cucumberPreset({ tags: 'not @pending' }) }
   ```

TypeScript finds the entry points' types with `"moduleResolution": "node"` as well as `node16`/`bundler`.

## Scenario Lifecycle

Each scenario follows this lifecycle:

1. **Before** -- Reset world state, reset WireMock (if configured), flush Redis (if configured)
2. **Before @ui** -- Launch Chromium browser and page
3. **Steps** -- Execute scenario steps
4. **After @ui** -- Close browser
5. **After** -- Truncate configured database tables

## Exports

```typescript
// Types
OperationEntry, OperationMap, CallRecord, UIStateSnapshot, FrameworkConfig, FrameworkOptions, AuthOptions, RequestFilter

// Support
ComponentTestWorld    // Base Cucumber World class
loadConfig()          // Load config from env vars
requireApiBaseUrl()   // Configured API URL, or a clear error if unset
loadFixture()         // Load a JSON fixture file
listFixtures()        // List all fixtures in a directory
registerHooks()       // Wire up Before/After hooks

// Clients
WireMockClient        // WireMock admin API client
DbClient              // PostgreSQL client (pg)
RedisClient           // Redis client (ioredis)

// Pages
BasePage              // Abstract page object base class

// Services
registerServiceUnderTest(), startService(), stopServices(), spawnServiceUnderTest()

// Requests, values and login
sendOperation(), fillPath(), EMPTY_REQUEST, valueAt()
login(), requestLogin(), adoptTokens(), jwtClaims(), registerLoginTag(), clearLoginCache()
world.remember(), world.recall(), world.uniqueId()

// Waiting
eventually(), holdsFor(), StopRetrying, isStopRetrying(), waitTimeout(), serviceWaitTimeout()
countRows(), queryOnce(), assertSafeTableName(), requireDb()
assertPartialMatch(), requestPattern(), describeRequests()

// Steps (import to register with Cucumber)
apiSteps, responseSteps, wiremockSteps, serviceSteps, uiSteps

// Opt-in steps (registered only when called)
registerWaitingSteps(), registerRequestSteps()
registerApiSteps(), registerRawApiSteps(), registerSseSteps(), registerResponseSteps(),
registerWiremockSteps(), registerDbSteps(), registerRedisSteps(), registerServiceSteps(), registerUiSteps()

// cucumber.js (from /preset)
cucumberPreset()
```

## Publishing

Releases from `main` are handled by release-please + GitHub Actions and go to GitHub Packages (`publishConfig.registry` in `package.json`).

For iterating on the framework before merging, `npm run pub` publishes a snapshot build to the local Verdaccio at `http://localhost:4873`:

```bash
# one-time, per machine
npm adduser --registry http://localhost:4873

# on any non-main branch
npm run pub
```

The wrapper mutates `package.json` to a snapshot version like `0.1.0-snapshot.<branch-slug>.<utc-timestamp>.<sha7>`, publishes to Verdaccio with dist-tag `snapshot`, and restores `package.json` afterwards. If the publish aborts and leaves `package.json.orig` on disk, run `npm run publish:restore` to recover.

Consumers opt in by adding a project-level `.npmrc`:

```
@bearingsoftware:registry=http://localhost:4873
```

then `npm install @bearingsoftware/component-test-framework@snapshot` for the latest snapshot, or pin to an exact snapshot version for reproducibility.
