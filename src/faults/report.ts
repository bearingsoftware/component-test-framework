import type { Fault } from './inject'

export interface TestStrength {
  version: 1
  faultsInjected: number
  noticed: number
  survived: { stub: string; fault: Fault; scenarios: string[] }[]
  tolerated: { stub: string; fault: Fault }[]
  baselineFailing: string[]
  /** Suite executions, the baseline included. */
  runs: number
  /** Pairs left unrun by --max-runs. */
  notRun: number
  durationMs: number
}

export function renderMarkdown(r: TestStrength): string {
  const lines = [
    '# Test strength (advisory)',
    '',
    `${r.noticed} of ${r.faultsInjected} injected faults were noticed by a failing scenario; ` +
      `${r.survived.length} survived. ${r.runs} suite runs, ${(r.durationMs / 1000).toFixed(1)}s.`,
    '',
  ]
  if (r.survived.length > 0) {
    lines.push('## Survived', '', 'No scenario that hit the stub failed.', '')
    for (const s of r.survived) {
      lines.push(
        `- \`${s.stub}\` with \`${s.fault}\`: ${s.scenarios.map((n) => `"${n}"`).join(', ')}`,
      )
    }
    lines.push('')
  }
  if (r.tolerated.length > 0) {
    lines.push('## Tolerated (allowlist, not run)', '')
    for (const t of r.tolerated) lines.push(`- \`${t.stub}\` with \`${t.fault}\``)
    lines.push('')
  }
  if (r.baselineFailing.length > 0) {
    lines.push('## Failing at baseline (left out)', '')
    for (const n of r.baselineFailing) lines.push(`- "${n}"`)
    lines.push('')
  }
  if (r.notRun > 0) lines.push(`${r.notRun} pair(s) not run: raise --max-runs.`, '')
  lines.push("Advisory: this ran the pull request's own code and tests, so it never gates.", '')
  return lines.join('\n')
}

export const LIST_CAP = 200
export const SCENARIO_CAP = 50

/** A test-strength file bounded for embedding in evidence.json. */
export function boundForEvidence(r: TestStrength): TestStrength & { truncated: boolean } {
  const truncated =
    r.survived.length > LIST_CAP ||
    r.tolerated.length > LIST_CAP ||
    r.baselineFailing.length > LIST_CAP ||
    r.survived.some((s) => s.scenarios.length > SCENARIO_CAP)
  const survived = r.survived
    .slice(0, LIST_CAP)
    .map((s) => ({ ...s, scenarios: s.scenarios.slice(0, SCENARIO_CAP) }))
  return {
    ...r,
    survived,
    tolerated: r.tolerated.slice(0, LIST_CAP),
    baselineFailing: r.baselineFailing.slice(0, LIST_CAP),
    truncated,
  }
}
