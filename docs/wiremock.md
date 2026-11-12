# WireMock

Manage external API stubs during scenarios.

| Step | Description |
|---|---|
| `Given the {word} API is stubbed from {word}` | Load WireMock mappings from a fixture directory |
| `Given the {word} API returns HTTP {int}` | Override all routes for a provider with a status code |
| `Given the {word} API at {string} returns HTTP {int}` | Override a specific path |
| `Given the {word} API at {string} returns the response {word}` | Override a path with a fixture body |
| `Then the {word} API at {string} was called {int} time(s)` | Wait until a specific path has been called exactly N times |
| `Then the {word} API was called {int} time(s)` | Wait until a provider has been called exactly N times in total |
| `When the WireMock scenario {string} is moved to state {string}` | Move a stateful scenario, so the stubs requiring that state answer |
| `Then the WireMock scenario {string} is in state {string}` | Wait until a scenario is in a state |

`the {word} API is stubbed from {word}` sends every mapping in the directory to WireMock in a single `/__admin/mappings/import` call. Mapping files can hold one mapping or WireMock's multi-mapping form, `{ "mappings": [...] }`. Stub precedence is the same as registering each mapping in turn: for equal priorities, the last file wins. Tested against WireMock 3.13.2.

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

## Scenarios

A WireMock [scenario](https://wiremock.org/docs/stateful-behaviour/) is a set of stubs sharing a `scenarioName`, each answering only in its `requiredScenarioState`. Stubs move it on by themselves with `newScenarioState`. A test can also move it, to make a vendor recover mid-scenario without loading other stubs:

```gherkin
Scenario: The worker recovers when the vendor does
  Given the sunsynk API is stubbed from sunsynk-recover
  Then the worker_errors table contains 1 row matching "provider = 'sunsynk'"
  When the WireMock scenario "sunsynk-outage" is moved to state "recovered"
  And I wait for a new record in readings matching "provider = 'sunsynk'"
```

A background poll that started before the move can still write a row afterwards, under the old state. To be sure the row came after the move, use `the WireMock scenario {string} is moved to state {string} and a new row appears in {word} matching {string}`, one of the service steps. It counts the matching rows before moving the scenario, then waits for one more.

From code, `this.wiremock` has `getScenarios()`, `getScenarioState(name)`, `setScenarioState(name, state)` and `resetScenarios()`. Moving a scenario to a state none of its stubs mention fails, and the error lists the states it has. Every scenario is back in `Started` after the per-scenario reset, because the reset removes the stubs.

WireMock 3 reads the name in `/__admin/scenarios/{name}/state` without decoding it, so it can only move a scenario whose name needs no encoding in a URL: letters, digits and `-._~!$&'()*+,;=:@`, with no spaces. Under worker isolation the framework stores each worker's scenario under an encoded name, such as `~2F__worker-2:sunsynk-outage`. That keeps the workers' scenarios apart, and any name works there. Steps and client calls take the name the stubs give.
