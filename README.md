# Component Test Framework (TypeScript)

A reusable Cucumber-based component test framework for testing deployed services as isolated building blocks. Provides generic Gherkin step definitions for API testing (driven by OpenAPI operation IDs), UI testing (Playwright + Page Object Model), and worker/background service testing.

Services under test run against real infrastructure (PostgreSQL, Redis) while external API dependencies are mocked with WireMock.

## Installation

```bash
npm install --save-dev @bearingsoftware/component-test-framework @cucumber/cucumber typescript ts-node @types/node
```

Playwright (`@playwright/test`) is optional -- only needed if you use the `@ui` tagged features. It is loaded when the first `@ui` scenario starts, so suites without UI scenarios don't need it installed to run. The published type declarations still reference Playwright's types, so type-checking with `skipLibCheck: false` needs it installed.

## Quick start

With Docker running, in an empty directory with a `package.json` and the packages above installed:

```bash
npx ctf init                # writes cucumber.js, support/, features/, docker-compose.yml, .env.example
docker compose up -d        # WireMock, on port 8443
npx cucumber-js
```

`ctf init` takes `--with wiremock,postgres,redis,mailpit,spa` to add services (the default is `wiremock`) and `--force` to overwrite files. The scenario it writes stubs an endpoint on WireMock, calls it through an operation in `support/operation-map.ts`, and checks the response:

```gherkin
Scenario: A stubbed endpoint answers
  Given the example API at "/hello" returns HTTP 200
  When I send the request _empty to the hello operation
  Then the response status should be 200
  And the example API at "/hello" was called 1 time
```

`support/setup.ts` wires the framework in, with `/core` and one `register…Steps()` call per group of steps the suite uses:

```typescript
import { loadConfig, registerHooks, registerApiSteps, registerResponseSteps } from '@bearingsoftware/component-test-framework/core'
import { registerWiremockSteps } from '@bearingsoftware/component-test-framework/wiremock'
import { operationMap } from './operation-map'

registerApiSteps()
registerResponseSteps()
registerWiremockSteps()
registerHooks({ ...loadConfig(), operationMap })
```

Point `API_BASE_URL` at your own service, add its operations to the map, and replace the example. Copy `.env.example` to `.env` or export its variables to change ports and URLs.

## Where next

- [Getting started](docs/getting-started.md): project layout, `support/setup.ts`, the operation map and `cucumber.js`
- [Configuration](docs/configuration.md): environment variables, options only available in code, fixtures
- [Steps](docs/steps.md): API, response and service call tracking steps; requests, values and login; waiting
- [WireMock](docs/wiremock.md): stubbing, call counts and stateful scenarios
- [Postgres](docs/postgres.md): the database client, cleanup and the table steps
- [Valkey / Redis](docs/redis.md): key and pub/sub steps
- [UI steps (Playwright)](docs/ui-playwright.md): `@ui` scenarios and page objects
- [Testing a single-page app](docs/spa.md): the SPA server, coverage and browser helpers
- [Playwright Test fixtures](docs/playwright-test.md): the same pieces as Playwright Test fixtures
- [Email: Mailpit](docs/mailpit.md): email steps
- [Running in parallel](docs/parallel.md): worker isolation, and making suites fast in CI
- [OpenAPI tooling and `ctf init`](docs/openapi-cli.md): the `ctf` command
- [Lifecycle](docs/lifecycle.md): starting the service under test, lifecycle hooks and the scenario lifecycle
- [Entry points and exports](docs/entry-points.md): the package's entry points and moving to `/core`
- [Adapters](docs/adapters.md)
- [Publishing](docs/publishing.md)

The [docs index](docs/README.md) lists the same pages.

## Examples

[`examples/`](examples/README.md) holds three small runnable suites: [`api`](examples/api/README.md) (a service, WireMock and Postgres), [`worker`](examples/worker/README.md) (a worker, Postgres and Redis) and [`spa`](examples/spa/README.md) (a static SPA, the SPA server and WireMock). Run them with `npm run examples:test`.
