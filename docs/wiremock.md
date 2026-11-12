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

## Stub builder

For a common mock, build the stub in code rather than writing WireMock JSON. `stub` is exported from `@bearingsoftware/component-test-framework/wiremock`, and `client.register(...)` sends one stub, or several in one import, with worker namespacing applied:

```typescript
import { stub } from '@bearingsoftware/component-test-framework/wiremock'

await this.wiremock.register(
  stub.get('/pricing/prices/WIDGET').willReturn(200, { price: 7 }),
  stub.post('/orders').withJsonBody({ sku: 'WIDGET' }).willReturn(201, { id: 'o1' }, { Location: '/orders/o1' }),
  stub.get('/slow').withQuery({ page: '2' }).withHeader('Authorization', /^Bearer /).withDelay(500).willReturnStatus(503),
  stub.any('/pricing/.*').pathPattern().priority(1).willReturnStatus(500),
  stub.get('/state').inScenario('flow', 'Started', 'Second').willReturn(200, { n: 1 }),
)
```

`.build()` returns the plain mapping, for `addStub` or a mapping file.

Matching rules:

- The path is exact. `pathPattern()` makes it a regular expression that must match the whole path. `any` matches every method.
- `withJsonBody` is a partial match: extra properties in the request are ignored, array order is not.
- `withQuery` and `withHeader` take an exact string or a `RegExp`. A `RegExp` matches where `test` would, anywhere in the value, so `/^Bearer /` matches `Bearer abc`. Only the `i` flag is supported.
- Other query parameters and headers are ignored.
- `withJsonBody` (and GraphQL `withVariables`) also ignore extra trailing items in an array, as WireMock's `ignoreExtraElements` does.
- A `RegExp` becomes a Java regular expression. Syntax Java cannot compile, such as `[^]`, fails when the stub is registered, not when it is built.
- `willReturn(status, json?, headers?)` sets `Content-Type: application/json` when there is a body. `willReturnStatus` sends no body. `willReturnBody(status, text, contentType)` sends text.
- A lower `priority` wins. At equal priority the stub registered last wins.

## GraphQL

`graphql.endpoint(path)` (default `/graphql`) stubs operations on a GraphQL endpoint without hand-written matchers:

```typescript
import { graphql } from '@bearingsoftware/component-test-framework/wiremock'

const octopus = graphql.endpoint('/v1/graphql/')
await this.wiremock.register(
  octopus.mutation('obtainKrakenToken').willReturnData({ obtainKrakenToken: { token: 't' } }),
  octopus.query('account').withVariables({ accountNumber: 'A-1' }).willReturnData({ account: { number: 'A-1' } }),
  octopus.query('account').willReturnErrors([{ message: 'not found', extensions: { code: 'NOT_FOUND' } }]),
  octopus.query('account').willReturn({ data: { account: null }, errors: [{ message: 'partial' }] }),
  octopus.operation('anything').withHttpStatus(500),
)
const calls = await this.wiremock.graphqlRequestCount('/v1/graphql/', 'obtainKrakenToken', { kind: 'mutation' })
```

Matching rules:

- A stub matches a POST to the endpoint path.
- The operation matches by `operationName` or by the name the query text declares, `(query|mutation|subscription) <Name>`. A client that sends no `operationName`, only `mutation obtainKrakenToken($input: ...) {` in `query`, matches. This is how joule-genie's Go client calls Octopus Kraken.
- The name must match whole: `obtainKrakenToken` does not match `obtainKrakenTokenV2`.
- `query` and `mutation` stubs check the keyword where the query text declares one, so a `query` stub does not answer a `mutation` of the same name. `operation` accepts any keyword. A request that gives `operationName` and a shorthand query (`{ x }`) declares none, and matches.
- When a request gives `operationName`, it picks the operation of the document: a stub for another operation of the same document does not match. A persisted query that sends `operationName` with no `query` matches by the name alone.
- `withVariables` is a partial match on `variables`: extra variables are ignored.
- The name is looked for in the query text as text, so a name inside a comment or a string argument can match. Matching by `contains` did the same.
- Responses are HTTP 200 with JSON `{data}`, `{errors}` or both. `withHttpStatus` replaces the status, for a transport failure.
- The last stub registered wins when several match, so register the general stub before the one with variables.
- `graphqlRequestCount(endpoint, name, { kind?, variables? })` counts with the same name rule.

Steps. The endpoint of each service comes from the `graphql` option, `{ endpoints: { octopus: '/v1/graphql/' } }`; a service with no entry uses `/graphql`. The second word is `query`, `mutation` or `operation`:

| Step | Purpose |
|------|---------|
| `Given the {word} GraphQL {word} {word} returns:` | Doc string of the JSON `data` |
| `Given the {word} GraphQL {word} {word} returns the errors:` | Doc string of a JSON array of errors |
| `Given the {word} GraphQL {word} {word} with variables {string} returns:` | The string is inline JSON; doc string is the `data` |
| `Then the {word} GraphQL {word} {word} was called {int} time(s)` | Wait until the operation has been called exactly N times |

```gherkin
Given the octopus GraphQL mutation obtainKrakenToken returns:
  """
  {"obtainKrakenToken": {"token": "t"}}
  """
When I send the request tariff/refresh to the refreshTariff operation
Then the octopus GraphQL mutation obtainKrakenToken was called 1 time
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
