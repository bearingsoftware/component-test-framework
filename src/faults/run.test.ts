import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { runFaults, selectChanged, withArgs } from './run'
import { parseAllowlist, readAllowlistAtBase } from './allowlist'
import { boundForEvidence, LIST_CAP, SCENARIO_CAP, type TestStrength } from './report'
import { collectEvidence } from '../openapi/evidence'
import { main } from '../cli'

const tmp: string[] = []
const mkdtemp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-faults-test-'))
  tmp.push(d)
  return d
}
afterAll(() => tmp.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

interface FakeScenario {
  name: string
  line: number
  steps?: string
  hits: string[]
  /** Faults the scenario notices, as `stub=fault` text; 'baseline' means it fails with no fault. */
  fails: string[]
}

/** A stand-in for `cucumber-js`: writes the JSON and hits files a real run would. */
function fakeSuite(scenarios: FakeScenario[], log: string[] = []) {
  return (command: string, env: NodeJS.ProcessEnv) => {
    const json = /'json:([^']+)'/.exec(command)?.[1] as string
    const lines = [...command.matchAll(/'(features\/a\.feature:\d+)'/g)].map((m) => m[1])
    log.push(`${env.CTF_FAULT ?? ''}|${lines.join(',')}`)
    const ran = lines.length
      ? scenarios.filter((s) => lines.includes(`features/a.feature:${s.line}`))
      : scenarios
    const fault = env.CTF_FAULT
    const features = [
      {
        uri: 'features/a.feature',
        elements: ran.map((s) => ({
          type: 'scenario',
          name: s.name,
          line: s.line,
          steps: [
            {
              name: s.steps ?? 'a step',
              result: {
                status: s.fails.includes(fault ? fault : 'baseline') ? 'failed' : 'passed',
              },
            },
          ],
        })),
      },
    ]
    fs.writeFileSync(json, JSON.stringify(features))
    if (env.CTF_FAULT_HITS) {
      fs.writeFileSync(
        env.CTF_FAULT_HITS,
        ran
          .map((s) => JSON.stringify({ uri: 'features/a.feature', name: s.name, stubs: s.hits }))
          .join('\n') + '\n',
      )
    }
    return 0
  }
}

const suite: FakeScenario[] = [
  {
    name: 'strict',
    line: 3,
    hits: ['GET /p/x'],
    fails: ['GET /p/x=status500', 'GET /p/*=status500'],
  },
  { name: 'lax', line: 6, hits: ['GET /p/x', 'GET /q'], fails: [] },
  { name: 'broken', line: 9, hits: ['GET /p/x'], fails: ['baseline', 'GET /p/x=status500'] },
]

describe('runFaults', () => {
  it('runs the baseline, then each stub and fault against only the scenarios that hit it', () => {
    const out = mkdtemp()
    const log: string[] = []
    const r = runFaults({
      run: 'cucumber-js',
      faults: ['status500'],
      out,
      exec: fakeSuite(suite, log),
    })
    expect(log).toEqual([
      '|',
      'GET /p/x=status500|features/a.feature:3,features/a.feature:6',
      'GET /q=status500|features/a.feature:6',
    ])
    expect(r).toMatchObject({
      version: 1,
      faultsInjected: 2,
      noticed: 1,
      survived: [{ stub: 'GET /q', fault: 'status500', scenarios: ['lax'] }],
      baselineFailing: ['broken'],
      runs: 3,
      tolerated: [],
    })
  })

  it('does not count a scenario failing at baseline as noticing a fault', () => {
    const only: FakeScenario[] = [
      { name: 'broken', line: 9, hits: ['GET /p/x'], fails: ['baseline', 'GET /p/x=status500'] },
    ]
    const r = runFaults({ run: 'c', faults: ['status500'], out: mkdtemp(), exec: fakeSuite(only) })
    expect(r.faultsInjected).toBe(0)
    expect(r.noticed).toBe(0)
    expect(r.baselineFailing).toEqual(['broken'])
  })

  it('injects the --stubs selectors, a prefix reaching every stub under it', () => {
    const r = runFaults({
      run: 'c',
      stubs: ['GET /p/*'],
      faults: ['status500', 'emptyBody'],
      out: mkdtemp(),
      exec: fakeSuite(suite),
    })
    expect(r.faultsInjected).toBe(2)
    expect(r.noticed).toBe(1)
    expect(r.survived).toEqual([
      { stub: 'GET /p/*', fault: 'emptyBody', scenarios: ['strict', 'lax'] },
    ])
  })

  it('skips tolerated pairs and lists them', () => {
    const log: string[] = []
    const r = runFaults({
      run: 'c',
      faults: ['status500'],
      allowlist: parseAllowlist('GET /q status500'),
      out: mkdtemp(),
      exec: fakeSuite(suite, log),
    })
    expect(r.tolerated).toEqual([{ stub: 'GET /q', fault: 'status500' }])
    expect(r.faultsInjected).toBe(1)
    expect(log).toHaveLength(2)
  })

  it('stops at --max-runs and says how many pairs it left', () => {
    const r = runFaults({
      run: 'c',
      maxRuns: 1,
      out: mkdtemp(),
      exec: fakeSuite(suite),
    })
    expect(r.faultsInjected).toBe(1)
    expect(r.notRun).toBe(5)
  })

  it('takes only stubs hit by changed scenarios, but runs every scenario hitting them', () => {
    const ev = path.join(mkdtemp(), 'evidence.json')
    fs.writeFileSync(
      ev,
      JSON.stringify({
        scenarios: { added: [{ file: 'features/a.feature', name: 'lax' }], changed: [] },
      }),
    )
    const log: string[] = []
    const r = runFaults({
      run: 'c',
      faults: ['status500'],
      scenarios: ev,
      out: mkdtemp(),
      exec: fakeSuite(suite, log),
    })
    expect(log.slice(1)).toEqual([
      'GET /p/x=status500|features/a.feature:3,features/a.feature:6',
      'GET /q=status500|features/a.feature:6',
    ])
    expect(r.faultsInjected).toBe(2)
  })

  it('injects nothing when no scenario or operation changed', () => {
    const ev = path.join(mkdtemp(), 'evidence.json')
    fs.writeFileSync(
      ev,
      JSON.stringify({ scenarios: { added: [], changed: [] }, operations: { changedInSpec: [] } }),
    )
    const r = runFaults({ run: 'c', scenarios: ev, out: mkdtemp(), exec: fakeSuite(suite) })
    expect(r).toMatchObject({ faultsInjected: 0, runs: 1 })
  })

  it('writes test-strength.json and a readable test-strength.md', () => {
    const out = mkdtemp()
    runFaults({ run: 'c', faults: ['status500'], out, exec: fakeSuite(suite) })
    const json = JSON.parse(fs.readFileSync(path.join(out, 'test-strength.json'), 'utf-8'))
    expect(Object.keys(json).sort()).toEqual(
      [
        'baselineFailing',
        'durationMs',
        'faultsInjected',
        'noticed',
        'notRun',
        'runs',
        'survived',
        'tolerated',
        'version',
      ].sort(),
    )
    const md = fs.readFileSync(path.join(out, 'test-strength.md'), 'utf-8')
    expect(md).toContain('1 of 2 injected faults were noticed')
    expect(md).toContain('`GET /q` with `status500`')
    expect(md).toContain('Failing at baseline')
  })

  it('throws when the baseline writes no Cucumber JSON', () => {
    expect(() => runFaults({ run: 'nope', out: mkdtemp(), exec: () => 127 })).toThrow(
      /wrote no Cucumber JSON report/,
    )
  })
})

describe('withArgs and selectChanged', () => {
  it('appends, or fills {args}', () => {
    expect(withArgs('npx cucumber-js', ['--format', 'json:/t/a b'])).toBe(
      "npx cucumber-js '--format' 'json:/t/a b'",
    )
    expect(withArgs('run {args} --x', ['a'])).toBe("run 'a' --x")
  })

  it('selects added, changed, and operation-naming scenarios', () => {
    const r = (name: string, steps = '') => ({
      uri: 'f/a.feature',
      name,
      line: 1,
      steps,
      passed: true,
    })
    const all = [
      r('added'),
      r('changed'),
      r('names', 'When I call getThing now'),
      r('other', 'getThings'),
    ]
    const picked = selectChanged(all, {
      scenarios: {
        added: [{ file: 'f/a.feature', name: 'added' }],
        changed: [{ file: 'f/a.feature', name: 'changed' }],
      },
      operations: { changedInSpec: ['getThing'] },
    })
    expect(picked.map((s) => s.name)).toEqual(['added', 'changed', 'names'])
  })
})

function gitRepo(): string {
  const dir = mkdtemp()
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      stdio: 'pipe',
    })
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'tolerated.txt'), '# base\nGET /q status500\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  fs.writeFileSync(path.join(dir, 'tolerated.txt'), 'GET /q status500\nGET /evil emptyBody\n')
  return dir
}

describe('allowlist', () => {
  it('parses lines, comments and GraphQL stubs; rejects bad lines', () => {
    expect(parseAllowlist('# c\n\nget /a status500 # why\nGRAPHQL /g op emptyBody\n')).toEqual([
      { stub: 'GET /a', fault: 'status500' },
      { stub: 'GRAPHQL /g op', fault: 'emptyBody' },
    ])
    expect(() => parseAllowlist('GET /a slow')).toThrow(':1:')
    expect(() => parseAllowlist('status500')).toThrow(':1:')
  })

  it('is read from the base ref, never the working tree', () => {
    const dir = gitRepo()
    expect(readAllowlistAtBase('HEAD:tolerated.txt', dir)).toEqual([
      { stub: 'GET /q', fault: 'status500' },
    ])
  })

  it('is empty when absent at the base, and errors on an unknown ref or bad form', () => {
    const dir = gitRepo()
    expect(readAllowlistAtBase('HEAD:missing.txt', dir)).toEqual([])
    expect(() => readAllowlistAtBase('nope:tolerated.txt', dir)).toThrow(/isn't a commit/)
    expect(() => readAllowlistAtBase('tolerated.txt', dir)).toThrow(/<base-ref>:<path>/)
  })
})

describe('boundForEvidence', () => {
  const base: TestStrength = {
    version: 1,
    faultsInjected: 1000,
    noticed: 0,
    survived: [],
    tolerated: [],
    baselineFailing: [],
    runs: 1,
    notRun: 0,
    durationMs: 1,
  }
  it('leaves a small report whole and untruncated', () => {
    expect(boundForEvidence(base)).toEqual({ ...base, truncated: false })
  })
  it('caps the survivors, their scenarios and the other lists, and says so', () => {
    const survived = Array.from({ length: LIST_CAP + 5 }, (_, i) => ({
      stub: `GET /s${i}`,
      fault: 'status500' as const,
      scenarios: Array.from({ length: SCENARIO_CAP + 3 }, (_, j) => `n${j}`),
    }))
    const bounded = boundForEvidence({ ...base, survived })
    expect(bounded.survived).toHaveLength(LIST_CAP)
    expect(bounded.survived[0].scenarios).toHaveLength(SCENARIO_CAP)
    expect(bounded.truncated).toBe(true)
    expect(
      boundForEvidence({ ...base, baselineFailing: Array(LIST_CAP + 1).fill('x') }).truncated,
    ).toBe(true)
  })
})

describe('ctf evidence --test-strength', () => {
  function evidenceRepo() {
    const dir = mkdtemp()
    const git = (...a: string[]) =>
      execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
        stdio: 'pipe',
      })
    git('init', '-q', '-b', 'main')
    fs.writeFileSync(
      path.join(dir, 'api.yaml'),
      "openapi: 3.0.3\ninfo: { title: T, version: '1' }\npaths: {}\n",
    )
    fs.mkdirSync(path.join(dir, 'features'))
    fs.writeFileSync(
      path.join(dir, 'features/a.feature'),
      'Feature: F\n\n  Scenario: a\n    Given x\n',
    )
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    git('commit', '-q', '-m', 'head', '--allow-empty')
    return dir
  }
  const opts = (dir: string) => ({
    base: 'HEAD~1',
    head: 'HEAD',
    specs: ['api.yaml'],
    features: ['features'],
    cwd: dir,
  })

  it('embeds the report and changes nothing else, nor the coverage files', () => {
    const dir = evidenceRepo()
    const ts = path.join(dir, 'ts.json')
    const report: TestStrength = {
      version: 1,
      faultsInjected: 2,
      noticed: 1,
      survived: [{ stub: 'GET /a', fault: 'status500', scenarios: ['a'] }],
      tolerated: [],
      baselineFailing: [],
      runs: 3,
      notRun: 0,
      durationMs: 5,
    }
    fs.writeFileSync(ts, JSON.stringify(report))
    const without = collectEvidence({ ...opts(dir), out: path.join(dir, 'o1') })
    const withTs = collectEvidence({ ...opts(dir), out: path.join(dir, 'o2'), testStrength: ts })
    expect(withTs.testStrength).toEqual({ ...report, truncated: false })
    const { testStrength: _t, ...rest } = withTs as typeof withTs & { testStrength: unknown }
    expect(rest).toEqual(without)
    expect(JSON.stringify(without)).not.toContain('testStrength')
    expect(Object.keys(without)).toEqual(Object.keys(rest))
    for (const f of ['coverage-base.txt', 'coverage-head.txt', 'api-break.txt']) {
      expect(fs.readFileSync(path.join(dir, 'o2', f), 'utf-8')).toBe(
        fs.readFileSync(path.join(dir, 'o1', f), 'utf-8'),
      )
    }
  })

  it('rejects a file that is not a test-strength report', () => {
    const dir = evidenceRepo()
    const bad = path.join(dir, 'bad.json')
    fs.writeFileSync(bad, '{"version":2}')
    expect(() =>
      collectEvidence({ ...opts(dir), out: path.join(dir, 'o'), testStrength: bad }),
    ).toThrow(/isn't a ctf faults/)
  })
})

describe('ctf faults command', () => {
  it('exits 2 for missing options, unknown faults and an unusable baseline', () => {
    const quiet = (args: string[]) => main(args)
    expect(quiet(['faults'])).toBe(2)
    expect(quiet(['faults', '--run', 'x'])).toBe(2)
    expect(quiet(['faults', '--run', 'x', '--out', mkdtemp(), '--faults', 'slow'])).toBe(2)
    expect(quiet(['faults', '--run', 'exit 1', '--out', mkdtemp()])).toBe(2)
  })
})
