# Documentation

- [Getting started](getting-started.md): project layout, `support/setup.ts`, the operation map and `cucumber.js`
- [Configuration](configuration.md): environment variables, options only available in code, fixtures
- [Steps](steps.md): API, response and service call tracking steps; requests, values and login; waiting
- [WireMock](wiremock.md): stubbing, the stub builder, GraphQL mocking, call counts and stateful scenarios
- [Postgres](postgres.md): the database client, cleanup and the table steps
- [Valkey / Redis](redis.md): key and pub/sub steps
- [UI steps (Playwright)](ui-playwright.md): `@ui` scenarios and page objects
- [Testing a single-page app](spa.md): the SPA server, coverage and browser helpers
- [Playwright Test fixtures](playwright-test.md): the same pieces as Playwright Test fixtures
- [Email: Mailpit](mailpit.md): email steps
- [Testcontainers](testcontainers.md): start Postgres, Valkey / Redis and WireMock in Docker from `cucumber.mjs`
- [Running in parallel](parallel.md): worker isolation, and making suites fast in CI
- [OpenAPI tooling and `ctf init`](openapi-cli.md): the `ctf` command
- [Test evidence](evidence.md): `ctf evidence`, coverage and api-break files for risk-gate
- [Test strength](test-strength.md): `ctf faults`, advisory fault injection into WireMock stubs
- [Lifecycle](lifecycle.md): starting the service under test, lifecycle hooks and the scenario lifecycle
- [Entry points and exports](entry-points.md): the package's entry points and moving to `/core`
- [Adapters](adapters.md)
- [Publishing](publishing.md)

Runnable suites to copy from are in [`examples/`](../examples/README.md).
