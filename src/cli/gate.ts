// `ctf gate`: fail unless a Cucumber run's last summary line meets a floor.
// Guards against a suite that finds no features and exits 0.

export type CucumberCounts = Record<string, number>

export type CucumberSummary = { total: number; counts: CucumberCounts }

export type GateResult = { passed: number; skipped: number; problems: string[] }

// Cucumber colours its summary on a terminal; the log may carry the codes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
// Cucumber prints a bare "0 scenarios" when no feature matched; no parentheses.
const SUMMARY = /^(\d+) scenarios?(?: \((.+)\))?$/
const COUNT = /^(\d+) (\w+)$/
const BLOCKING = ['failed', 'ambiguous', 'undefined', 'pending'] as const

export function parseCucumberSummary(output: string): CucumberSummary | undefined {
  let last: CucumberSummary | undefined
  for (const raw of output.split('\n')) {
    const m = SUMMARY.exec(raw.replace(ANSI, '').trimEnd())
    if (!m) continue
    const total = Number(m[1])
    if (m[2] === undefined) {
      if (total === 0) last = { total, counts: {} }
      continue
    }
    const counts: CucumberCounts = {}
    let valid = true
    for (const part of m[2].split(', ')) {
      const c = COUNT.exec(part)
      if (!c) {
        valid = false
        break
      }
      counts[c[2]] = Number(c[1])
    }
    if (valid) last = { total, counts }
  }
  return last
}

export function checkGate(counts: CucumberCounts, min: number): GateResult {
  const passed = counts.passed ?? 0
  const problems: string[] = []
  if (passed < min) problems.push(`expected at least ${min} passed, got ${passed}`)
  for (const status of BLOCKING) {
    const n = counts[status] ?? 0
    if (n > 0) problems.push(`${n} ${status}`)
  }
  return { passed, skipped: counts.skipped ?? 0, problems }
}
