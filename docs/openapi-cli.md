# OpenAPI tooling: the `ctf` command

The package installs a `ctf` command for keeping an operation map in step with the API's OpenAPI spec. It reads OpenAPI 3.0 and 3.1, and Swagger 2, as YAML or JSON. Reading a `.ts` map needs `typescript`, which a suite running on ts-node already has.

**Base path.** Spec paths get the path of the spec's first server URL in front, so they match what the suite sends: `servers: [{ url: /api/v1 }]` or `http://localhost:8080/api/v1` gives `/api/v1`, with server variables' defaults filled in. Swagger 2 uses its `basePath`. Servers set on a single path or operation aren't used. When a suite sees a different prefix, such as an SPA suite whose server strips `/api`, pass `--base-path`.

**Exit status.** It's 0 when all is well and 1 when a check finds problems. It's 2 when the command can't run: a usage mistake, or a missing or unparseable file.

## Generating a map

```sh
npx ctf generate-operation-map backend/openapi.yaml --out support/operation-map.ts
```

The map has one entry per operation, named by its `operationId`, or, in a spec without them, by its method and path (`GET /projects/{id}/remediable` is `getProjectsByIdRemediable`). Each entry carries the operation's summary as a comment. It's exported `as const satisfies OperationMap`, with an `OperationName` type, so a mistyped name is a compile error. Options:
- `--include` and `--exclude` take a regular expression to pick operations by name.
- `--export-name` renames the exported constant.
- `--import-from` changes where `OperationMap` is imported from.
- `--check` fails in CI if the file is out of date with the spec. The header names the spec relative to the file, so the check passes wherever the command runs.

## Checking a hand-written map

```sh
npx ctf check-operation-map support/operation-map.ts backend/openapi.yaml
```

It fails when:
- **Not in the spec:** a map entry isn't in the spec.
- **Different path:** the spec has the same `operationId` at a different method or path.
- **Different name:** the spec gives the entry's route a different `operationId`.
- **Unreadable entry:** an entry can't be read, such as a spread or a computed path. It's reported rather than skipped.

It finds entries in the map file without running it, so entries a formatter has wrapped over several lines are checked too.
- **The form it reads:** the map must be a top-level `const operationMap = { … }`, exported or not, optionally `as const` or `satisfies OperationMap`. `--export-name` reads another name. `export default { … }` and `module.exports` aren't read.
- **Syntax and duplicates:** a file that doesn't parse fails. A duplicate key is reported, since only its last entry counts at runtime.

An entry is checked against the operation its request would actually reach, so `getOrg: GET /orgs/me` fails when the spec also has `/orgs/me`.

A spec without `operationId`s is matched by method and path instead.
- **Test values:** a map path may carry a test's concrete values (`/orgs/acme`, `/files/report.json`, `?ecosystem=npm`) where the spec has a parameter.
- **Parameter names:** these needn't agree.
- **Trailing slashes:** a trailing slash makes a different path, as it does to most routers.

**Complete maps.** `--complete` also fails on spec operations the map leaves out. Use it for a map meant to cover the whole API, and leave it off for a suite that maps only what it uses.

**Several maps at once.** Check several maps, sharing one allowlist. A third `=` part gives a pair its own base path:

```sh
npx ctf check-operation-map \
  --complete-pair backend/__component_tests__/api/support/operation-map.ts=backend/openapi/openapi.yaml \
  --pair web/__component_tests__/cucumber/support/operation-map.ts=backend/openapi/openapi.yaml=/v1 \
  --allowlist scripts/op-map-spec-allowlist.txt
```

**The allowlist.** It lists known gaps, one per line, as an operation name or `METHOD /path`, with `#` comments. An entry that no longer matches a problem fails as stale, so the list only shrinks.

## Auditing which operations features exercise

```sh
npx ctf audit-coverage backend/openapi.yaml --features features --map support/operation-map.ts
```

It prints each spec operation no feature file references, and on stderr, any name a feature uses that is neither a spec operation nor in the map: a typo, or a removed operation.
- **How references are found:** by default, the framework's step wording, "to the `<name>` operation". `--pattern` takes other wordings, each a regular expression with the name in its first group.
- **The map:** `--map` names the operations of a spec without `operationId`s, and adds the map's other names for an operation.
- **Several specs:** pass more than one spec to audit their operations together.
- **Exit code:** it exits 0, as an audit, unless given `--fail-on-gaps`. `--json` prints everything, with each operation's references.

The same functions are exported from `@bearingsoftware/component-test-framework/openapi` for scripts of your own.

## Scaffolding a suite: `ctf init`

```sh
npx ctf init [dir] [--with wiremock,postgres,redis,mailpit,spa] [--force]
```

Writes a starter suite into `dir` (default `.`): `cucumber.js` (from `cucumberPreset()`), `support/setup.ts` (`/core` and the adapters' `register…Steps()` calls), `support/operation-map.ts`, `features/example.feature` (one scenario that passes against the compose file), `docker-compose.yml` with only the chosen services, `.env.example` and a `tsconfig.json` (CommonJS output, which ts-node needs on a current Node). `--with` defaults to `wiremock`; `spa` also adds WireMock, and a `web/` page and page object for the SPA server to serve. It refuses to overwrite an existing file, naming it, unless you pass `--force`. Every compose service has a healthcheck, so `--wait` returns once they're ready. The generated `cucumber.js` loads `.env` when it exists, and `.env.example` holds the compose ports (`WIREMOCK_PORT`, ...) beside the URLs built from them. `ctf init` prints the install command for the pieces you chose, adding `@playwright/test` and `npx playwright install chromium` for `spa`. Then:

```sh
docker compose up -d --wait
npx cucumber-js
```

The images are the ones this repository's CI uses: `wiremock/wiremock:3.13.2`, `postgres:17-alpine`, `redis:7-alpine` and `axllent/mailpit:v1.33`. The generated suite needs `@cucumber/cucumber`, `typescript` 5 (ts-node does not run on TypeScript 7), `ts-node` and `@types/node` installed. The exit status is 0, or 2 for a usage mistake or a file it won't overwrite.
