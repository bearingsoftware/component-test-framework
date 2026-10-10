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
| `waitTimeout` | _(see [Waiting](#waiting))_ | How long waiting steps poll before failing, in ms |

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

The two `I wait for` steps keep their 30s default unless `waitTimeout` or `defaultStepTimeout` is set. Table names must be plain SQL identifiers. Predicates are inserted into the SQL as written, so they must come from your own feature files.

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

## Waiting

Services, workers and SPAs settle asynchronously, so assertions on them wait rather than check once. Each one polls until its condition holds, and passes as soon as it does. A page or table that's already right is no slower.

**How long steps wait.** In order of precedence:

1. `waitTimeout`, if set.
2. 1s less than `defaultStepTimeout`, so the step reports what it was waiting for before Cucumber's own timeout fires.
3. Otherwise, 4s (just under Cucumber's 5s default). The DB `I wait for` steps keep their historical 30s.

If your suite calls `setDefaultTimeout` itself, set `waitTimeout` too, a little below it.

**Counts that can only grow fail early.** `was called {int} time(s)` fails straight away if WireMock has already received more requests than expected.

### Opt-in waiting steps

Several suites wrote their own waiting steps. The framework now provides them, with the same wording, but registers them only when you call `registerWaitingSteps()`. If they were registered automatically, a suite that still has its own copy would get two matching definitions, and Cucumber fails any step that matches both. Delete your copies, then:

```typescript
import { registerHooks, registerWaitingSteps, loadConfig } from '@bearingsoftware/component-test-framework'

const options = { ...loadConfig(), operationMap, waitTimeout: 10_000 }
registerHooks(options)
registerWaitingSteps(options)
```

Each step waits up to `waitTimeout` and gets a Cucumber timeout 1s longer. Steps that watch a window you set in the feature file (`over {int} seconds`, `for {int} seconds`) have no Cucumber timeout; their own waits bound them.

| Step | Description |
|---|---|
| `Then the {word} page should eventually be displayed` | Wait for the URL to contain the page's path |
| `Then the URL should contain {string}` | Wait for the URL to contain a fragment |
| `Then I should eventually see {word} on the {word} page` | Wait for an element to be visible |
| `Then I should eventually not see {word} on the {word} page` | Wait for an element to be hidden or removed |
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
| `Then the {word} API receives no further {word} requests to {string} for {int} seconds` | Once the count stops moving (at least one request must have arrived), no new requests for the window |
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
- `countRows(world, table, predicate?)` counts rows and validates the table name.
- `assertPartialMatch(actual, expected, { nullMatchesAnything? })` does the deep partial JSON match the response, service and Valkey steps use.
- `requestPattern(path, filter)` builds a WireMock request pattern.

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
OperationEntry, OperationMap, CallRecord, UIStateSnapshot, FrameworkConfig, FrameworkOptions, RequestFilter

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

// Waiting
eventually(), holdsFor(), StopRetrying, waitTimeout()
countRows(), assertSafeTableName(), requireDb()
assertPartialMatch(), requestPattern(), describeRequests()

// Steps (import to register with Cucumber)
apiSteps, responseSteps, wiremockSteps, serviceSteps, uiSteps

// Opt-in steps (registered only when called)
registerWaitingSteps()
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
