import * as fs from 'fs'

export interface ScenarioResult {
  uri: string
  name: string
  line: number
  /** Step text, for matching changed operations by name. */
  steps: string
  passed: boolean
}

interface JsonStep {
  name?: string
  result?: { status?: string }
}

/** Reads the scenarios of a Cucumber JSON report. A scenario passes when every step and hook did. */
export function readCucumberJson(file: string): ScenarioResult[] {
  const features = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    uri: string
    elements?: {
      type?: string
      name: string
      line: number
      steps?: JsonStep[]
      before?: JsonStep[]
      after?: JsonStep[]
    }[]
  }[]
  return features.flatMap((f) =>
    (f.elements ?? [])
      .filter((e) => e.type !== 'background')
      .map((e) => {
        const all = [...(e.before ?? []), ...(e.steps ?? []), ...(e.after ?? [])]
        return {
          uri: f.uri,
          name: e.name,
          line: e.line,
          steps: (e.steps ?? []).map((s) => s.name ?? '').join('\n'),
          passed: all.every((s) => s.result?.status === 'passed'),
        }
      }),
  )
}

export interface HitLine {
  uri: string
  name: string
  line?: number
  stubs: string[]
}

/** The scenario-by-stub map the WireMock adapter writes, one JSON line per scenario. */
export function readHits(file: string): Map<string, Set<string>> {
  const hits = new Map<string, Set<string>>()
  if (!fs.existsSync(file)) return hits
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    const hit = JSON.parse(line) as HitLine
    const key = scenarioKey(hit)
    const set = hits.get(key) ?? new Set<string>()
    for (const s of hit.stubs) set.add(s)
    hits.set(key, set)
  }
  return hits
}

export const scenarioKey = (s: { uri: string; line?: number }) => `${s.uri}:${s.line}`
