# Cucumber gate: `ctf gate`

```sh
npx cucumber-js --config cucumber.js > run.log; npx ctf gate --min 40 --log run.log
```

It fails a CI job unless a Cucumber run shows at least `--min` passed scenarios and nothing failed, ambiguous, undefined or pending. It reads the **last** `N scenarios (...)` summary line in the log, so a rerun's summary replaces the first run's. Skipped scenarios are allowed and printed.

The floor catches a suite that finds no features: Cucumber exits 0 for that, and the gate fails it.

| Option           | Meaning                                                 |
| ---------------- | ------------------------------------------------------- |
| `--min <N>`      | Required. The least number of passed scenarios.         |
| `--log <path>`   | Required. The Cucumber output to read. `-` reads stdin. |
| `--suite <name>` | Shown in the result line (default `cucumber`).          |

Exit codes: 0 when the gate passes, 1 when it fails (the reasons go to stderr), 2 when it couldn't run, such as when the log has no scenario summary or `--min` is not a count.

The parser is exported as `parseCucumberSummary` and `checkGate` from `src/cli/gate.ts` for reuse.
