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

Playwright is optional -- only needed if you use the `@ui` tagged features.

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
| `Then the {word} API at {string} was called {int} time(s)` | Verify call count for a specific path |
| `Then the {word} API was called {int} time(s)` | Verify total calls to a provider |

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
| `When I wait for a new record in {word} matching {string}` | Poll DB until a matching row appears (30s timeout) |

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
| `Then I should see {word} on the {word} page` | Assert element is visible |
| `Then I should not see {word} on the {word} page` | Assert element is not visible |
| `Then the {word} page should be displayed` | Assert current URL matches page |

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

## Scenario Lifecycle

Each scenario follows this lifecycle:

1. **Before** -- Reset world state, reset WireMock, flush Redis
2. **Before @ui** -- Launch Chromium browser and page
3. **Steps** -- Execute scenario steps
4. **After @ui** -- Close browser
5. **After** -- Truncate configured database tables

## Exports

```typescript
// Types
OperationEntry, OperationMap, CallRecord, UIStateSnapshot, FrameworkConfig

// Support
ComponentTestWorld    // Base Cucumber World class
loadConfig()          // Load config from env vars
loadFixture()         // Load a JSON fixture file
listFixtures()        // List all fixtures in a directory
registerHooks()       // Wire up Before/After hooks

// Clients
WireMockClient        // WireMock admin API client
DbClient              // PostgreSQL client (pg)
RedisClient           // Redis client (ioredis)

// Pages
BasePage              // Abstract page object base class

// Steps (import to register with Cucumber)
apiSteps, responseSteps, wiremockSteps, serviceSteps, uiSteps
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
