# Test evidence: `ctf evidence`

```sh
npx ctf evidence --base origin/main --spec openapi.yaml --features features --out evidence
```

It writes the facts about a change that [risk-gate](https://github.com/bearingsoftware/risk-gate) scores: how well the feature files assert the spec's documented response statuses before and after, and whether the spec's change breaks clients.

**What it is:** everything is computed statically from files. The base side is read with `git archive <base>`, unpacked to a temporary directory, so no pull-request code is ever executed and the job needs no write token. It reuses [`audit-coverage --statuses`](openapi-cli.md#response-statuses) and [`api-diff`](openapi-cli.md#detecting-breaking-changes-ctf-api-diff).

**What it isn't:** a gate. It exits 0 once the files are written, and has no exit 1; 2 means it couldn't run. It holds no run-time data: retries and flake history need runs, so `evidence.json` lists them under `notComputed` and invents no values.

## Options

| Option | |
|---|---|
| `--base <git-ref>` | Required. The ref to compare against. It must be fetched: with `actions/checkout`, use `fetch-depth: 0`. An unknown ref exits 2 naming it. |
| `--head <git-ref>` | Default: the working tree. |
| `--spec <path>` | Required, repeatable. Each spec is computed on its own, then aggregated. A spec missing at base counts as empty (a new API); one missing at head exits 2. |
| `--features <dir\|file>` | Required, repeatable. Missing at base counts as no features (a new suite). |
| `--map <file>` | The suite's operation map, as for `audit-coverage`. |
| `--base-path`, `--pattern`, `--status-pattern` | As for `audit-coverage` and `api-diff`. |
| `--allowlist <file>` | An `api-diff` allowlist, read from the head. Allowlisted breaks don't count. |
| `--out <dir>` | Required. Where the files go. |

Paths are relative to the working directory, inside a git repository.

## Files

- `coverage-base.txt`, `coverage-head.txt`: the status coverage percent, the number only, two decimals, no `%` (`82.35`). It is asserted (operation, documented status) pairs divided by all documented pairs, times 100. `default` is excluded from both sides. A range such as `2XX` is one pair, met by any asserted status in it. With no documented pairs the file holds `100.00`.
- `api-break.txt`: `true` or `false`. `true` when `diffSpecs(base, head)` finds a breaking change that the allowlist doesn't suppress, in any spec. A spec new at head contributes nothing.
- `evidence.json`: the details, below.

None of the three text files ends in a newline; each parses with `strconv.ParseFloat` or a `true`/`false` comparison after trimming.

### `evidence.json`

| Field | Meaning |
|---|---|
| `version` | `1`. |
| `base`, `head` | The base commit sha, and the head sha or `worktree`. |
| `generatedBy` | `ctf evidence <package version>`. |
| `specs` | One entry per `--spec`: `path`, `presentAtBase`, `coverage` (`base` and `head` as two-decimal strings, `pairs` with `asserted` and `total` for each) and `apiBreak`. |
| `coverage.base`, `.head` | The aggregate percents as numbers. Specs are weighted by their documented pairs. |
| `coverage.delta` | `head - base`. |
| `coverage.noDocumentedStatuses` | `true` when the base or the head has no documented pairs, so its percent is the `100.00` default, not a measurement. `coverage.pairs` has the counts. |
| `apiDiff.breaking`, `.nonBreaking` | The `api-diff` findings (`rule`, `operation`, `location`, `detail`) over all specs; `breaking` excludes allowlisted ones. |
| `apiDiff.suppressed` | How many breaking findings the allowlist suppressed. |
| `scenarios.added`, `.removed`, `.changed` | `{file, name}` for scenarios in the features. A scenario is its file and name; an Outline is one scenario however many rows. `changed` means the same file and name with different step text. |
| `statusGaps.head` | Documented statuses no scenario asserts at head. |
| `statusGaps.new`, `.closed` | `{operation, method, path, status}` gaps present at head but not base, and the reverse. |
| `operations.changedInSpec` | Operations (`METHOD /path`) that any `api-diff` finding touches, breaking or not. |
| `operations.changedWithoutScenario` | Those whose scenarios are the same at base and head: the spec moved and no scenario naming the operation was added, removed or changed. |
| `unasserted` | `{operation, references}`: operation references at head with no status asserted after them, as `file:line`. |
| `notComputed` | `["retries", "flakeHistory"]`. |

## risk-gate

| risk-gate option | File |
|---|---|
| `--coverage-base <file>` | `coverage-base.txt` |
| `--coverage-head <file>` | `coverage-head.txt` |
| `--api-break <true\|false>` | the contents of `api-break.txt` |

## In CI

The job uploads the `--out` directory as an artifact named **`ctf-evidence`**; risk-gate (FINCH-549) downloads it by that name.

```yaml
evidence:
  runs-on: ubuntu-latest
  permissions:
    contents: read
  steps:
    - uses: actions/checkout@v5
      with:
        fetch-depth: 0
    - uses: actions/setup-node@v6
      with:
        node-version: "24"
        cache: npm
    - run: npm ci --ignore-scripts
    - run: npx ctf evidence --base origin/${{ github.base_ref }} --spec openapi.yaml --features features --out evidence
    - uses: actions/upload-artifact@v4
      with:
        name: ctf-evidence
        path: evidence
```

`fetch-depth: 0` fetches the base branch so `origin/<base>` resolves. The job runs no code from the pull request beyond `npm ci --ignore-scripts`, and needs no write token.

`collectEvidence` is exported from `@bearingsoftware/component-test-framework/openapi`.
