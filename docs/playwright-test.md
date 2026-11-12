# Playwright Test fixtures

A suite written for `@playwright/test`, rather than Cucumber, can use the same SPA server, WireMock client, logins and coverage through fixtures. `defineFixtures` returns a `test` to use in place of Playwright's. Nothing in the `/playwright-test` entry point loads Cucumber.

```ts
// fixtures.ts
import * as path from 'path'
import { defineFixtures } from '@bearingsoftware/component-test-framework/playwright-test'
export { expect } from '@playwright/test'

export const test = defineFixtures({
  spa: { distDir: path.join(__dirname, '../dist'), proxyPrefixes: ['/api'] },
  wiremock: { url: process.env.WIREMOCK_URL ?? 'http://localhost:8443' },
  stubsDir: path.join(__dirname, 'stubs'),
  auth: { loginPath: '/api/auth/login' },
  coverage: { outDir: path.join(__dirname, 'coverage') },
})
```

```ts
// orders.spec.ts
import { test, expect } from './fixtures'

test('the dashboard shows the latest order', async ({ page, stubs, auth }) => {
  await stubs.load('login.json', 'orders')
  await auth.login('owner@example.com', 'Sup3rSecret!')
  await auth.storeInLocalStorage(page, 'session')
  await page.goto('/dashboard')
  await expect(page.getByText('Order #1042')).toBeVisible()
})
```

| Fixture | Scope | What it is |
|---|---|---|
| `spaServer` | worker | The built SPA, served with API paths forwarded to WireMock. One per Playwright worker, on a free port, or on `basePort` plus the worker's `parallelIndex`. `baseURL` is its URL, so `page.goto('/')` opens the app. `spa` can be a function of the worker, to give each worker its own `runtimeEnv`. |
| `wiremock` | worker | A `WireMockClient`. Each worker has its own path prefix, `/__worker-<parallelIndex>`, on the shared WireMock, as with Cucumber's `workerIsolation.wiremock`. It's reset before every test (and when the worker starts), after which `baseline` stub directories are loaded again; `resetEachTest: false` resets only when the worker starts. `isolate: false` turns the prefix off. |
| `wiremockUrl` | worker | The URL a service under test should call WireMock at: the root URL plus the worker's prefix. |
| `stubs` | test | `load(...names)` loads stub files (`login.json`) or directories laid out as `<name>/mappings/*.json` from `stubsDir`; `add(mapping)` registers one. |
| `auth` | test | `login(username, password)` sends the login request that `auth` describes (`loginPath`, `loginBody`, `tokenPath` and so on, as for Cucumber) and keeps the tokens. It goes to `auth.apiBaseUrl`, or else through the SPA server, as the SPA's own login would. Also `headers()`, `claims()`, `sign()` for forged tokens, and `storeInLocalStorage(page, key)`. |
| `coverage` | worker | With `coverage` set, each test's page has its `window.__coverage__` collected before it closes, and every worker's coverage is merged into one report, as `registerCoverage` does. |

A fixture whose option is missing throws when a test uses it, so a suite sets only what it needs. The example suite in `tests/playwright-test` runs with two workers in CI (`npm run test:playwright-test`).

**Adopting it in an existing e2e suite.** health-web's and secure-repo's e2e suites run on `@playwright/test` and serve the SPA, stub its API and log in with code of their own. To adopt the fixtures:
- Replace the suite's `webServer` or hand-written static server with the `spa` option.
- Point stubs at WireMock: its JSON stubs load with `stubs.load`, and stubs written with `page.route` can stay, or move to WireMock to get request counts.
- Replace login helpers with `auth.login` and `storeInLocalStorage`.
- Import `test` from the suite's fixtures file instead of `@playwright/test`.

The suites can move one spec file at a time, since the fixtures only start what a test uses.
