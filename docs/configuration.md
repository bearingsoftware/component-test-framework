# Configuration

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

## Options only available in code

| Option | Default | Description |
|---|---|---|
| `operationMap` | `{}` | Your API's operationId-to-path map |
| `cleanupTables` | _(none)_ | Tables to clear after each scenario, children first |
| `defaultStepTimeout` | _(Cucumber's 5s)_ | Timeout in ms for every step and hook. Leave unset to keep a `setDefaultTimeout` call of your own |
| `waitTimeout` | _(see [Waiting](steps.md#waiting))_ | How long UI and assertion waits poll before failing, in ms |
| `auth` | _(none)_ | How the API issues tokens: `loginPath`, `tokenPath` (default `access_token`), `refreshTokenPath`, `loginMethod`, `loginBody`. See [Requests, values and login](steps.md#requests-values-and-login) |
| `hooks` | _(none)_ | Suite code at fixed points: `afterReset`, `onScenarioFailed`, `beforePageClose`. See [Lifecycle hooks](lifecycle.md#lifecycle-hooks) |
| `pages` | _(none)_ | Page object classes by name, created for every `@ui` scenario. Needs `webBaseUrl` |
| `wiremockBaseline` | _(none)_ | WireMock stub directories, relative to `fixturesDir`, loaded after every reset |
| `cleanup` | _(none)_ | Cleanup after each scenario for what `cleanupTables` doesn't cover |
| `serviceWaitTimeout` | `30000` | How long waits for background work (DB record waits, opt-in WireMock and DB steps) poll, in ms |

## Suites that don't use WireMock or an API

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
