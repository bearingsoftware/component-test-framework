# Entry points and exports

The package root works as it always has: it exports everything and registers every built-in step when it's imported. Only the entry points below can be imported: deep paths into `dist/` are no longer reachable. Alongside it are entry points that register nothing on import, so a suite loads and registers only what it uses:

| Entry point | Contents |
|---|---|
| `@bearingsoftware/component-test-framework/core` | World, config, `registerHooks`, services, waiting, requests and login, the parallel-run helpers (`currentWorker`, `workerPort`, `worker…Url`, `prepareWorkerDatabase`), utilities, and `register…Steps()` for each step group |
| `…/wiremock` | `WireMockClient`, `requestPattern`, `registerWiremockSteps`, and the namespacing helpers `namespaceStub`, `namespaceUrlMatcher`, `namespaceId`, `namespaceScenarioName` |
| `…/postgres` | `DbClient`, `countRows`, `queryOnce`, `registerDbSteps`, `registerServiceSteps`, `prepareWorkerDatabase` |
| `…/redis` | `RedisClient`, `registerRedisSteps` |
| `…/playwright` | `BasePage`, `registerUiSteps` |
| `…/spa` | `registerSpaServer`, `registerCoverage`, `saveFailureArtifacts`, route blocks, WebAuthn, accessibility steps |
| `…/preset` | `cucumberPreset()`, a profile for `cucumber.js` |
| `…/openapi` | `loadSpec`, `readOperationMap`, `generateOperationMap`, `checkOperationMaps`, `auditCoverage`: the code behind the `ctf` command |
| `…/mailpit` | `MailpitClient`, `registerMailpitSteps`, `emailContains`, `emailLinks` |
| `…/playwright-test` | `defineFixtures`: the SPA server, WireMock, stubs, logins and coverage as Playwright Test fixtures. Loads no Cucumber |

The step groups are `registerApiSteps`, `registerRawApiSteps`, `registerSseSteps`, `registerResponseSteps`, `registerWiremockSteps`, `registerDbSteps`, `registerRedisSteps`, `registerServiceSteps` and `registerUiSteps`, plus the opt-in `registerWaitingSteps` and `registerRequestSteps`. Calling one twice, or after importing the root, registers nothing more.

The database and Redis drivers (`pg`, `ioredis`) and Playwright load only when they're used, whichever entry point a suite imports. A UI-only suite never loads `pg` or `ioredis`.

## Migrating to the core entry point

Nothing has to change: the root import keeps working. The `…Steps` module exports it registers steps through (`apiSteps`, `rawApiSteps`, `sseSteps`, `responseSteps`, `dbAssertionSteps`, `wiremockSteps`, `redisSteps`, `serviceSteps`, `uiSteps`) are marked `@deprecated` in favour of the `register…Steps()` functions. To move a suite over:

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

// Steps (import to register with Cucumber). Deprecated: use the register…Steps() functions below
apiSteps, responseSteps, wiremockSteps, serviceSteps, uiSteps

// Opt-in steps (registered only when called)
registerWaitingSteps(), registerRequestSteps()
registerApiSteps(), registerRawApiSteps(), registerSseSteps(), registerResponseSteps(),
registerWiremockSteps(), registerDbSteps(), registerRedisSteps(), registerServiceSteps(), registerUiSteps()

// cucumber.js (from /preset)
cucumberPreset()
```
