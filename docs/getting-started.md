# Getting started

A consuming project provides its own feature files, fixtures, operation map, and page objects. Typical structure:

```
my-project/
  test/component/
    package.json              # depends on @bearingsoftware/component-test-framework
    cucumber.js               # Cucumber profiles
    support/
      setup.ts                # registerHooks + register…Steps() calls
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

## support/setup.ts

This is the entry point that wires the framework into your project:

```typescript
import {
  registerHooks,
  loadConfig,
  registerApiSteps,
  registerResponseSteps,
  registerServiceSteps,
  registerUiSteps,
} from '@bearingsoftware/component-test-framework/core'
import { registerWiremockSteps } from '@bearingsoftware/component-test-framework/wiremock'
import { operationMap } from './operation-map'

// Each call registers a group of steps with Cucumber. Register only what the suite uses.
registerApiSteps()
registerResponseSteps()
registerWiremockSteps()
registerServiceSteps()
registerUiSteps()

registerHooks({
  ...loadConfig(),
  operationMap,
  cleanupTables: ['users', 'integrations', 'readings'],
})
```

## support/operation-map.ts

Maps each OpenAPI `operationId` from your spec to its HTTP method and path:

```typescript
import type { OperationMap } from '@bearingsoftware/component-test-framework/core'

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

## cucumber.js

Configure Cucumber profiles to run subsets of tests (or start from `cucumberPreset()`, see [Entry points](entry-points.md)):

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

Starting from scratch? `ctf init` writes these files for you: see [OpenAPI tooling and ctf init](openapi-cli.md#scaffolding-a-suite-ctf-init).
