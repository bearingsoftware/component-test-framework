# Testing a single-page app

The `/spa` entry point covers what SPA suites need beyond the UI steps: serving the built app, forwarding its API calls to WireMock, browser-side coverage, failure screenshots, and a few browser helpers.

```typescript
import * as path from 'node:path'
import { registerHooks, loadConfig, registerUiSteps, registerWaitingSteps, type FrameworkOptions } from '@bearingsoftware/component-test-framework/core'
import { registerSpaServer, registerCoverage, saveFailureArtifacts } from '@bearingsoftware/component-test-framework/spa'

const SUITE = path.resolve(__dirname, '..')

// Serves web/dist on WEB_PORT (default 3100): its files, index.html for
// client-side routes, a 404 for a missing asset, and /api/* forwarded to
// WireMock with /api removed.
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
- **Port:** `registerSpaServer` needs a fixed port, since the base URL is worked out before the server starts. Under Cucumber `--parallel`, each worker runs its own server on the port plus its worker number; see [Running in parallel](parallel.md#running-in-parallel).

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
