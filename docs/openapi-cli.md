# OpenAPI tooling: the `ctf` command

The package installs a `ctf` command for keeping an operation map, and WireMock stubs, in step with the API's OpenAPI spec. It reads OpenAPI 3.0 and 3.1, and Swagger 2, as YAML or JSON. Reading a `.ts` map needs `typescript`, which a suite running on ts-node already has.

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

## Stubs from the spec: `ctf stubs`

Mocks drift when the API they stand for changes. `ctf stubs` keeps them in step with the spec, in two halves.

```sh
npx ctf stubs vendor/openapi.yaml --out wiremock/vendor
npx ctf stubs --check vendor/openapi.yaml wiremock/vendor --allowlist stubs-allowlist.txt
```

**Generating.** It writes one [WireMock](wiremock.md) mapping per operation to `<dir>/mappings/<name>.json`, where `<name>` is the operation's name as in the map above. That is WireMock's own layout, so `the {word} API is stubbed from {word}` and `wiremockBaseline` load the directory as it is.
- **Matching:** the method, and `urlPathTemplate` with the spec's path (`/api/pets/{petId}`), base path included. It matches any value in a path parameter and nothing across a `/`. `--base-path` overrides the base path. A path with more fixed segments gets a lower `priority` number (6 for `/api/pets/mine`, 7 for `/api/pets/{petId}`), so it wins over a parameter path whatever the load order. They run from 9 down to 6 (three fixed segments or more), so a stub you or a scenario add at WireMock's default of 5 wins over a generated one. Error stubs are 10.
- **Response:** the lowest documented 2xx, with the example the spec gives. The first of these is used: the response's `example`, the first of its `examples` (its `value`), the schema's `example`. A response documented as `2XX` only is stubbed as a 200. A response with no body, such as a 204, gets a stub with no body. A `null` example is written as `body: "null"`, as WireMock serves a `jsonBody` of null as an empty body. `Content-Type` is the media type the example is under: `application/json`, else another JSON type, else the first one.
- **Examples are checked:** an example that doesn't fit its own schema is written all the same, with a warning on stderr.
- **No invented data:** an operation whose example is missing is skipped and listed on stderr with the reason. So is one with no 2xx.
- **`--all-statuses`:** also writes `<name>-<status>.json` for every other documented status, with `priority: 10` so they never shadow the 2xx. Load one with a step or the stub builder when a scenario needs the error. `default` and `4XX`-style statuses have no one code to match, so they are skipped.
- **`--include` and `--exclude`:** a regular expression to pick operations by name.
- **File names:** characters other than letters, digits, `.`, `_` and `-` in an operation name become `_`. When that makes two operations share a file, it fails and names both.
- **Existing files:** it never overwrites a file without `--force`; the error names them.
- **Metadata:** each mapping carries `metadata: { generatedBy: "ctf stubs", operation, specHash }`, where `specHash` is the SHA-256 of the spec file, so a check can tell generated stubs from hand-written ones.

**Checking.** It reads every `.json` file in `<dir>/mappings`, generated or hand-written, and fails when a mapping:
- goes to no spec operation, by its method and its `url`, `urlPath` or `urlPathTemplate`;
- answers with a status the operation doesn't document (`default`, and `2XX`-style ranges, document what they cover);
- has a JSON body (`jsonBody`, or a `body` that parses) that doesn't fit the response's schema. Each finding names the JSON pointer of the failing value.

A `urlPathPattern` or `urlPattern` is a regular expression, which can't be matched to a path template. It is tried against each operation's path with sample values in the parameters (a `urlPattern`, which WireMock matches against the path and query, also with sample queries), and when that doesn't leave operations at exactly one path, it is reported as unresolved rather than guessed. A mapping with `ANY` or no method is valid when its URL resolves to operations at one path: its status must be documented by one of them, and its body fit the response of every one that documents that status; one with no schema for it limits nothing. Faults, proxied responses, `bodyFileName` bodies and bodies of a stub that names the `response-template` transformer aren't body-checked; a `{{` without the transformer is checked as text. For a WireMock run with `--global-response-templating`, pass `--templated` (`templated: true` in `checkStubs`) to skip every body that has a `{{`. A generated stub whose `specHash` differs from the spec is a warning to regenerate, not a failure, and its content is checked all the same.

The schema check covers the keywords that decide a response's shape: `type` (also as a list, and with `nullable`), `required`, `properties`, `additionalProperties` (false, or a schema), `items`, `enum`, `const`, `allOf`, `oneOf`, `anyOf` and `$ref`, across files, including recursive ones. Formats, patterns and numeric or length limits aren't checked.

`--allowlist` takes the same file as `check-operation-map`, with a mapping's file name (`getPet.json`) per line, and an entry that no longer matches a problem fails as stale. `--json` prints `{ problems, warnings, allowlisted, stale }`. Exit codes are 0, 1 for findings and 2 when it can't run, including when `--out` would overwrite a file.

`generateStubs` and `checkStubs` are exported from `@bearingsoftware/component-test-framework/openapi`.

## Auditing which operations features exercise

```sh
npx ctf audit-coverage backend/openapi.yaml --features features --map support/operation-map.ts
```

It prints each spec operation no feature file references, and on stderr, any name a feature uses that is neither a spec operation nor in the map: a typo, or a removed operation.
- **How references are found:** by default, the framework's step wording, "to the `<name>` operation". `--pattern` takes other wordings, each a regular expression with the name in its first group.
- **The map:** `--map` names the operations of a spec without `operationId`s, and adds the map's other names for an operation.
- **Several specs:** pass more than one spec to audit their operations together.
- **Exit code:** it exits 0, as an audit, unless given `--fail-on-gaps`. `--json` prints everything, with each operation's references.

### Response statuses

`--statuses` also lists the documented response statuses no scenario asserts, as `name`, `METHOD /path` and status, one per line.

```sh
npx ctf audit-coverage backend/openapi.yaml --features features --statuses --fail-on-gaps
```

- **Pairing:** feature files are read as scenarios. Within a scenario, Background steps first, each operation reference is paired with the first `the response status should be <n>` after it and before the next reference. A reference with no such step is "exercised, status unasserted". An Outline's Examples rows are expanded first, so a `<status>` placeholder is read per row; a Rule's Background follows the Feature's; doc strings, data tables, comments and tags are never steps.
- **What counts as a gap:** every status in the operation's `responses`, except `default`. A range such as `2XX` or `4XX` is met by any asserted status in it.
- **`--status-pattern <regex>`:** how your suite asserts a status, the status in group 1 (repeatable; default "the response status should be (\d+)"). `--pattern` still says how operations are named.
- **`--fail-on-gaps`:** with `--statuses`, also exits 1 on a status gap. Without `--statuses`, output and exit codes are what they were.
- **`--json`:** always includes, for each operation, `statuses` (each status with its `reference -> assertion` pairs as `file:line`) and `unassertedReferences`, and `statusGaps` for the result.
- **Later work:** auth roles and omitted required fields are not audited.

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

## Listing the framework's steps: `ctf steps`

```sh
npx ctf steps          # a table
npx ctf steps --json   # { "version": 1, "steps": [...] }
```

Each step has its `keyword` (`Given`, `When`, `Then` or `Step`), its `expression`, the `registeredBy` function and the `entryPoint` that exports it (`core`, `mailpit` or `spa`), and whether it is `optIn`: registered only when your suite calls the function. The list is captured from what the register functions really register, so it can't drift from the steps. Needs `@cucumber/cucumber`, a peer dependency; without it the command exits 2 with a message. `stepCatalogue()` is exported from `@bearingsoftware/component-test-framework/openapi`, with the other tooling, rather than from `core`, which a suite imports and which stays free of tooling.
