import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { readCucumberJson, readHits, scenarioKey, type ScenarioResult } from './cucumber'
import { isTolerated, type Tolerated } from './allowlist'
import { FAULTS, selectorMatches, type Fault } from './inject'
import { renderMarkdown, type TestStrength } from './report'

export interface FaultsOptions {
  /** The command that runs the suite. `{args}` in it is replaced by the extra Cucumber arguments; without one they are appended. */
  run: string
  /** An evidence.json: only stubs hit by its added or changed scenarios, or scenarios naming its changed operations. */
  scenarios?: string
  /** Stub selectors (exact, or a trailing `*` for a prefix) to inject, instead of every stub the baseline hit. */
  stubs?: string[]
  faults?: Fault[]
  allowlist?: Tolerated[]
  out: string
  maxRuns?: number
  /** Runs a shell command with extra environment; returns its exit status. */
  exec?: (command: string, env: NodeJS.ProcessEnv) => number | null
}

export class FaultsError extends Error {}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

function defaultExec(command: string, env: NodeJS.ProcessEnv): number | null {
  return spawnSync(command, { shell: true, stdio: 'inherit', env: { ...process.env, ...env } })
    .status
}

export function withArgs(command: string, args: string[]): string {
  const text = args.map(shellQuote).join(' ')
  return command.includes('{args}') ? command.replace('{args}', text) : `${command} ${text}`
}

interface Evidence {
  scenarios?: {
    added?: { file: string; name: string }[]
    changed?: { file: string; name: string }[]
  }
  operations?: { changedInSpec?: string[] }
}

const sameFile = (uri: string, file: string) => {
  const a = uri.split(path.sep).join('/')
  const b = file.split(path.sep).join('/')
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/** The scenarios an evidence.json says changed: added or changed, or whose steps name a changed operation. */
export function selectChanged(results: ScenarioResult[], evidence: Evidence): ScenarioResult[] {
  const touched = [...(evidence.scenarios?.added ?? []), ...(evidence.scenarios?.changed ?? [])]
  const ops = evidence.operations?.changedInSpec ?? []
  const opWord = (op: string) =>
    new RegExp(`(?<![\\w])${op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`)
  const opRes = ops.map(opWord)
  return results.filter(
    (r) =>
      touched.some((t) => t.name === r.name && sameFile(r.uri, t.file)) ||
      opRes.some((re) => re.test(r.steps)),
  )
}

export function runFaults(options: FaultsOptions): TestStrength {
  const started = Date.now()
  const exec = options.exec ?? defaultExec
  const faults = options.faults ?? [...FAULTS]
  const allowlist = options.allowlist ?? []
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-faults-'))
  fs.mkdirSync(options.out, { recursive: true })
  for (const f of ['test-strength.json', 'test-strength.md']) {
    fs.rmSync(path.join(options.out, f), { force: true })
  }
  let runs = 0
  try {
    const hitsFile = path.join(work, 'hits.jsonl')
    const baselineJson = path.join(work, 'baseline.json')
    runs++
    exec(withArgs(options.run, ['--format', `json:${baselineJson}`]), {
      CTF_FAULT_HITS: hitsFile,
      CTF_FAULT: '',
    })
    if (!fs.existsSync(baselineJson)) {
      throw new FaultsError(
        `the baseline run wrote no Cucumber JSON report: is "${options.run}" a command that runs ` +
          `Cucumber and takes --format json:<file>? Put {args} where its arguments go if they don't go last.`,
      )
    }
    const baseline = readCucumberJson(baselineJson)
    const hits = readHits(hitsFile)
    const baselineFailing = baseline.filter((s) => !s.passed)
    const passing = baseline.filter((s) => s.passed)
    const hitsOf = (s: ScenarioResult) => hits.get(scenarioKey(s)) ?? new Set<string>()

    let selected = passing
    if (options.scenarios) {
      const evidence = JSON.parse(fs.readFileSync(options.scenarios, 'utf-8')) as Evidence
      selected = selectChanged(passing, evidence)
    }
    const selectors = options.stubs ?? [...new Set(selected.flatMap((s) => [...hitsOf(s)]))].sort()
    const inScope = (selector: string) =>
      options.stubs && !options.scenarios
        ? true
        : selected.some((s) => [...hitsOf(s)].some((k) => selectorMatches(selector, k)))
    const pairs = selectors
      .filter(inScope)
      .flatMap((stub) => faults.map((fault) => ({ stub, fault })))

    const tolerated: TestStrength['tolerated'] = []
    const todo: { stub: string; fault: Fault; targets: ScenarioResult[] }[] = []
    for (const { stub, fault } of pairs) {
      const targets = passing.filter((s) => [...hitsOf(s)].some((k) => selectorMatches(stub, k)))
      if (targets.length === 0) continue
      if (isTolerated(allowlist, stub, fault)) tolerated.push({ stub, fault })
      else todo.push({ stub, fault, targets })
    }
    const max = options.maxRuns ?? Infinity
    const toRun = todo.slice(0, max)

    let noticed = 0
    const survived: TestStrength['survived'] = []
    toRun.forEach(({ stub, fault, targets }, i) => {
      const json = path.join(work, `fault-${i}.json`)
      runs++
      const status = exec(
        withArgs(options.run, [
          '--format',
          `json:${json}`,
          ...targets.map((t) => `${t.uri}:${t.line}`),
        ]),
        { CTF_FAULT: `${stub}=${fault}`, CTF_FAULT_HITS: '' },
      )
      const ran = fs.existsSync(json) ? readCucumberJson(json) : undefined
      const failed = ran ? ran.some((s) => !s.passed) : status !== 0
      if (failed) noticed++
      else survived.push({ stub, fault, scenarios: [...new Set(targets.map((t) => t.name))] })
    })

    const result: TestStrength = {
      version: 1,
      faultsInjected: toRun.length,
      noticed,
      survived,
      tolerated,
      baselineFailing: baselineFailing.map((s) => s.name),
      runs,
      notRun: todo.length - toRun.length,
      durationMs: Date.now() - started,
    }
    fs.writeFileSync(
      path.join(options.out, 'test-strength.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    )
    fs.writeFileSync(path.join(options.out, 'test-strength.md'), renderMarkdown(result))
    return result
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
