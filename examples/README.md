# Examples

Three small suites to copy from. Each is written in the `/core` style: `registerHooks`, plus one `register…Steps()` call for every group of steps the features use, and the stack-specific pieces from the adapter entry points. They load the package from the built `dist`, as `tests/smoke` does, and run serially.

| Suite | What it tests | Needs |
|---|---|---|
| [`api`](api/README.md) | A small HTTP service that calls a moderation API and saves to Postgres | WireMock, Postgres |
| [`worker`](worker/README.md) | A worker that takes jobs from a Redis channel and writes a row | Postgres, Redis |
| [`spa`](spa/README.md) | A static page that calls an API, served by the SPA server | WireMock, Chromium |

`npm run examples:test` builds the package and runs the three suites, which read `WIREMOCK_URL`, `DATABASE_URL`, `REDIS_URL`, `WEB_PORT`, `EXAMPLE_API_PORT` and `EXAMPLE_WORKER_PORT` (the containers in `.github/workflows/ci.yml` serve them). It then checks the scaffold the way a consumer gets it: it packs the package, installs the tarball with `@cucumber/cucumber`, `ts-node`, `typescript@5`, `@types/node` and `@playwright/test` from the npm registry into a temporary project, runs `ctf init` for each service, starts the generated `docker-compose.yml` on free ports with `docker compose up -d --wait`, and runs the generated feature under ts-node with type-checking. That part needs Docker and network access, and takes about 30 seconds. `EXAMPLES_COMPOSE_PROJECT` names its compose project. The script isn't part of `npm test`, because it needs those services.

For a new suite, start with `ctf init` ([docs](../docs/openapi-cli.md#scaffolding-a-suite-ctf-init)).
