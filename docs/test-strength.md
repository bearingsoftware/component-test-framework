# Test strength: `ctf faults`

```sh
npx ctf faults --run "npx cucumber-js --config cucumber.js" --out strength
```

It answers one question about a suite: if a stubbed dependency misbehaves, does any scenario that uses it fail? It breaks one WireMock stub at a time, re-runs the scenarios that hit it, and lists the stub and fault pairs nothing noticed.

**What it isn't:** a gate. It runs the pull request's own code and tests, so a pull request can delete a scenario or change the runner. Treat `test-strength.json` as evidence for a reviewer, never as a merge condition. It exits 0 once the report is written, even with survivors; 2 means it couldn't run (for example, the baseline command wrote no Cucumber JSON). It runs in CI, not in the static [`ctf evidence`](evidence.md) step, which must never execute pull-request code.

## Faults

| Fault             | The stub's response becomes                                |
| ----------------- | ---------------------------------------------------------- |
| `status500`       | status 500 with the JSON body `{"error":"injected fault"}` |
| `emptyBody`       | the same status and headers, an empty body                 |
| `connectionReset` | WireMock's `CONNECTION_RESET_BY_PEER`                      |

Delays and removed fields are not in v1: a useful delay depends on the service's own client timeout, which the framework can't know.

## How a fault is injected

`WireMockClient` rewrites a stub as it registers it, so every route is covered (`addStub`, `importStubs`, `register`, `loadMappingsFromDir`) and no feature file changes. `CTF_FAULT` picks the stub:

```sh
CTF_FAULT='GET /pricing/prices/*=status500' npx cucumber-js
```

A stub's key is its method and the first of `url`, `urlPath`, `urlPathTemplate`, `urlPathPattern` and `urlPattern` that its request has (`ANY` when it names no method). A selector is the same text, matching exactly, or as a prefix when it ends in `*`. The method is case-insensitive.

GraphQL stubs share one URL, so they are selected by operation: `CTF_FAULT='GRAPHQL /v1/graphql/ account=status500'` is the endpoint and the operation name the stub matches by `operationName` (what `graphql.endpoint().query('account')` builds). Other stubs on that URL are untouched.

A `CTF_FAULT` that isn't `<selector>=<fault>` throws when the client is created, naming the valid forms. With `CTF_FAULT` unset, the mappings posted to WireMock are the same as without this feature.

## What `ctf faults` does

1. **Baseline.** Runs `--run` once with `--format json:<file>` and `CTF_FAULT_HITS` set. The WireMock adapter records, after each scenario, which stubs WireMock actually served (from its request journal, so a stub registered but never requested isn't a hit). Scenarios that fail here are listed as `baselineFailing` and left out: a failing scenario can't notice anything.
2. **Selection.** With `--scenarios evidence.json`, only stubs hit by scenarios `ctf evidence` lists as added or changed, or whose steps name a changed operation. Without it, every stub the baseline hit, up to `--max-runs`.
3. **Per (stub, fault).** Re-runs only the passing scenarios that hit the stub, as `file:line` paths added to the command, with `CTF_FAULT` set. If any of them fails, the fault was noticed; if none does, it survived.

`--run` must be a command that runs Cucumber and accepts its arguments at the end. If they belong elsewhere, put `{args}` there. `--stubs "GET /pricing/prices/*,GRAPHQL /v1/graphql/ account"` injects those selectors instead of every stub found; a prefix covers every stub under it as one pair.

## Output

`test-strength.json`:

```json
{
  "version": 1,
  "faultsInjected": 3,
  "noticed": 2,
  "survived": [{ "stub": "GET /pricing/prices/*", "fault": "status500", "scenarios": ["..."] }],
  "tolerated": [],
  "baselineFailing": [],
  "runs": 4,
  "notRun": 0,
  "durationMs": 61000
}
```

`noticed / faultsInjected` is the headline; `survived` is the useful part. `runs` counts suite executions, the baseline included; `notRun` is the pairs `--max-runs` left out. `test-strength.md` is the same for a reader.

Pass it to `ctf evidence --test-strength strength/test-strength.json` to embed it as `testStrength` in `evidence.json`, bounded to 200 entries per list and 50 scenarios per survivor, with `truncated: true` when it cut anything. It feeds none of the coverage or api-break files.

## The allowlist

A service that retries a 500 and succeeds is correct, but the fault survives. List what the suite should absorb, one `METHOD path fault` per line (`GRAPHQL endpoint operation fault` for GraphQL; `#` starts a comment):

```
GET /pricing/prices/* status500   # the client retries
```

`--allowlist origin/main:test-strength-tolerated.txt` reads the file from that ref with `git show`, never the working tree, so a pull request can't excuse its own survivors. A file absent at the ref means none. Tolerated pairs aren't run; they're listed under `tolerated`.

## Cost

One faulted run per (stub, fault) pair, each over only the scenarios hitting the stub. On a pull request, scope with `--scenarios` so a change touching no scenario or operation injects nothing. Run the full pass on a schedule. Flaky scenarios are not detected: a scenario that fails at random will look like a noticed fault.

## GitHub Actions

```yaml
test-strength:
  runs-on: ubuntu-latest
  # Advisory: never a required check.
  continue-on-error: true
  steps:
    - uses: actions/checkout@v5
      with:
        fetch-depth: 0
    - uses: actions/setup-node@v6
      with:
        node-version: '24'
        cache: npm
    - run: npm ci --ignore-scripts
    # ...start WireMock and the other services, as for the suite itself...
    - run: >
        npx ctf evidence --base origin/${{ github.base_ref }} --spec openapi.yaml
        --features features --out evidence
    - run: >
        npx ctf faults --run "npx cucumber-js" --scenarios evidence/evidence.json
        --allowlist origin/${{ github.base_ref }}:test-strength-tolerated.txt --out strength
    - run: >
        npx ctf evidence --base origin/${{ github.base_ref }} --spec openapi.yaml
        --features features --test-strength strength/test-strength.json --out evidence
    - run: cat strength/test-strength.md >> "$GITHUB_STEP_SUMMARY"
    - uses: actions/upload-artifact@v4
      with:
        name: test-strength
        path: |
          strength
          evidence
```
