# Steps

API, response and service call tracking steps, then the request, value, login and waiting helpers. Steps for [WireMock](wiremock.md), [Valkey / Redis](redis.md) and the [UI](ui-playwright.md) have their own pages.

## API Steps

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

## Response Assertion Steps

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

## Service Call Tracking Steps

Generic steps for calling services and counting invocations. Call counts are tracked in the Cucumber world and persist across steps within a scenario.

| Step | Description |
|---|---|
| `When the service {word} is called with the request {word} it returns the response {word}` | Call service, compare response with fixture |
| `Then the request to the service {word} with request {word} was called {int} time(s)` | Assert call count |
| `Then the total calls to the service {word} should be {int}` | Assert total calls to a service |
| `When I wait for a new record in {word} matching {string}` | Poll DB until a matching row appears |
| `When I wait for {int} record(s) in {word} matching {string}` | Poll DB until at least N matching rows exist |
| `When the WireMock scenario {string} is moved to state {string} and a new row appears in {word} matching {string}` | Count matching rows, move the scenario, then poll until there's one more. Needs WireMock and the database |
| `Then the {word} table contains {int} row(s) matching {string}` | Wait until exactly N rows match |
| `Then the {word} table is empty` | Wait until the table is empty |

The two `I wait for` steps and the scenario-move step poll for `serviceWaitTimeout` (30s by default, as they always have). Table names must be plain SQL identifiers, such as `jobs`, not `schema.jobs`. Predicates are inserted into the SQL as written, so they must come from your own feature files. A query error fails the step at once rather than being retried.

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
import { sendOperation } from '@bearingsoftware/component-test-framework/core'

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
import { registerHooks, registerWaitingSteps, loadConfig } from '@bearingsoftware/component-test-framework/core'

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
import { eventually, holdsFor, StopRetrying, waitTimeout } from '@bearingsoftware/component-test-framework/core'

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
