import type { Fault } from './inject'

export interface TestStrength {
  version: 1
  faultsInjected: number
  noticed: number
  survived: { stub: string; fault: Fault; scenarios: string[] }[]
  tolerated: { stub: string; fault: Fault }[]
  /** Pairs whose runs said nothing: no report, no scenarios, or a failure that didn't repeat. */
  inconclusive: { stub: string; fault: Fault; reason: string }[]
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
  if (r.inconclusive.length > 0) {
    lines.push('## Inconclusive (neither noticed nor survived)', '')
    for (const i of r.inconclusive) lines.push(`- \`${i.stub}\` with \`${i.fault}\`: ${i.reason}`)
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

export const STRING_CAP = 200

/** A test-strength file bounded for embedding in evidence.json: list lengths and string lengths. */
export function boundForEvidence(r: TestStrength): TestStrength & { truncated: boolean } {
  let truncated =
    r.survived.length > LIST_CAP ||
    r.tolerated.length > LIST_CAP ||
    r.inconclusive.length > LIST_CAP ||
    r.baselineFailing.length > LIST_CAP ||
    r.survived.some((s) => s.scenarios.length > SCENARIO_CAP)
  const str = (text: string) => {
    if (text.length <= STRING_CAP) return text
    truncated = true
    return `${text.slice(0, STRING_CAP - 1)}…`
  }
  const survived = r.survived.slice(0, LIST_CAP).map((s) => ({
    ...s,
    stub: str(s.stub),
    scenarios: s.scenarios.slice(0, SCENARIO_CAP).map(str),
  }))
  const tolerated = r.tolerated.slice(0, LIST_CAP).map((t) => ({ ...t, stub: str(t.stub) }))
  const inconclusive = r.inconclusive
    .slice(0, LIST_CAP)
    .map((i) => ({ ...i, stub: str(i.stub), reason: str(i.reason) }))
  const baselineFailing = r.baselineFailing.slice(0, LIST_CAP).map(str)
  return { ...r, survived, tolerated, inconclusive, baselineFailing, truncated }
}
