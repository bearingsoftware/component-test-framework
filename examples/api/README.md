# examples/api

A small notes service (`service/notes.js`) that saves a note in Postgres once a moderation service approves it. In the suite WireMock plays the moderation service.

- `support/setup.js` starts the service with `registerServiceUnderTest`, wires `registerHooks`, and registers only the step groups the features use.
- `features/notes.feature` stubs the moderation API, calls the service through an operation, and checks the response, the table and the WireMock call count.

Run it from the repository root with WireMock and Postgres up (the images are in `.github/workflows/ci.yml`):

```sh
npm run examples:test
```

It reads `WIREMOCK_URL`, `DATABASE_URL` and `EXAMPLE_API_PORT`. The support code is JavaScript so it runs with no TypeScript setup; for the TypeScript version of a suite, use `ctf init` ([docs](../../docs/openapi-cli.md#scaffolding-a-suite-ctf-init)).

`openapi.yaml` describes the service; `ctf evidence --base origin/main --spec examples/api/openapi.yaml --features examples/api/features --out evidence` ([docs](../../docs/evidence.md)) computes its test evidence.
