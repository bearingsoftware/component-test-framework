import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { gate, main } from '../cli'
import { checkGate, parseCucumberSummary, type CucumberSummary } from './gate'

const allPass = `Feature: a

  Scenario: one
    Given a step

  Scenario: two
    Given a step

2 scenarios (2 passed)
4 steps (4 passed)
`

const belowFloor = `1 scenario (1 passed)
`

const ambiguous = `3 scenarios (1 ambiguous, 2 passed)
`

const undefinedStep = `2 scenarios (1 undefined, 1 passed)
`

const multipleSummaries = `1 scenario (1 failed)

rerunning
1 scenario (1 passed)
`

const rerunOutput = `rerun output
1 scenario (1 failed)
rerun:
2 scenarios (2 passed)
`

const withSkipped = `4 scenarios (3 passed, 1 skipped)
`

const pending = `2 scenarios (1 pending, 1 passed)
`

const colored = `\x1b[32m2 scenarios\x1b[39m (\x1b[32m2 passed\x1b[39m)\r\n`

const noSummary = `Feature: a

  Scenario: one
    Given a step
`

const stepsOnly = `  Given a step
  When another step

4 steps (4 passed)
`

const zeroScenarios = `0 scenarios
`

const bareNonZero = `3 scenarios
`

const interleavedService = `1 scenario (1 failed)
service: listening on :9999
GET /orders 500
2 scenarios (2 passed)
service: stopped
`

const serviceLineLooksLikeSummary = `2 scenarios (2 passed)
[svc] 9 scenarios (9 failed)
`

const parseCases: Array<{ name: string; output: string; want?: CucumberSummary }> = [
  { name: 'all passed', output: allPass, want: { total: 2, counts: { passed: 2 } } },
  {
    name: 'below floor is still parsed',
    output: belowFloor,
    want: { total: 1, counts: { passed: 1 } },
  },
  {
    name: 'ambiguous',
    output: ambiguous,
    want: { total: 3, counts: { ambiguous: 1, passed: 2 } },
  },
  {
    name: 'undefined',
    output: undefinedStep,
    want: { total: 2, counts: { undefined: 1, passed: 1 } },
  },
  {
    name: 'uses the last summary',
    output: multipleSummaries,
    want: { total: 1, counts: { passed: 1 } },
  },
  { name: 'rerun output', output: rerunOutput, want: { total: 2, counts: { passed: 2 } } },
  {
    name: 'skipped',
    output: withSkipped,
    want: { total: 4, counts: { passed: 3, skipped: 1 } },
  },
  { name: 'pending', output: pending, want: { total: 2, counts: { pending: 1, passed: 1 } } },
  { name: 'ANSI colours and CRLF', output: colored, want: { total: 2, counts: { passed: 2 } } },
  { name: 'bare 0 scenarios', output: zeroScenarios, want: { total: 0, counts: {} } },
  { name: 'bare non-zero count is not a summary', output: bareNonZero, want: undefined },
  { name: 'steps only, no scenario summary', output: stepsOnly, want: undefined },
  { name: 'no summary', output: noSummary, want: undefined },
  {
    name: 'service stdout between summary lines',
    output: interleavedService,
    want: { total: 2, counts: { passed: 2 } },
  },
  {
    name: 'service line with a summary shape is ignored',
    output: serviceLineLooksLikeSummary,
    want: { total: 2, counts: { passed: 2 } },
  },
]

describe('parseCucumberSummary', () => {
  it.each(parseCases)('$name', ({ output, want }) => {
    expect(parseCucumberSummary(output)).toEqual(want)
  })
})

const checkCases: Array<{ name: string; output: string; min: number; ok: boolean }> = [
  { name: 'all passed at the floor', output: allPass, min: 2, ok: true },
  { name: 'zero floor passes', output: allPass, min: 0, ok: true },
  { name: 'below floor', output: belowFloor, min: 2, ok: false },
  { name: 'ambiguous fails', output: ambiguous, min: 1, ok: false },
  { name: 'undefined fails', output: undefinedStep, min: 1, ok: false },
  { name: 'pending fails', output: pending, min: 1, ok: false },
  { name: 'skipped is allowed', output: withSkipped, min: 3, ok: true },
  { name: 'rerun summary is the last one', output: rerunOutput, min: 2, ok: true },
]

describe('checkGate', () => {
  it.each(checkCases)('$name', ({ output, min, ok }) => {
    const summary = parseCucumberSummary(output)
    expect(summary).toBeDefined()
    expect(checkGate(summary!.counts, min).problems.length === 0).toBe(ok)
  })

  it('reports skipped without failing', () => {
    expect(checkGate({ passed: 3, skipped: 1 }, 3)).toEqual({
      passed: 3,
      skipped: 1,
      problems: [],
    })
  })
})

describe('ctf gate', () => {
  let dir: string
  let out: ReturnType<typeof vi.spyOn>
  let err: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-gate-'))
    out = vi.spyOn(console, 'log').mockImplementation(() => {})
    err = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    out.mockRestore()
    err.mockRestore()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const log = (name: string, text: string) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, text)
    return file
  }

  it.each([
    { name: 'passes at the floor', output: allPass, min: '2', code: 0 },
    { name: 'fails below the floor', output: belowFloor, min: '2', code: 1 },
    { name: 'fails on ambiguous', output: ambiguous, min: '1', code: 1 },
    { name: 'exits 2 with no summary', output: noSummary, min: '1', code: 2 },
    { name: 'exits 2 when cucumber ran 0 scenarios', output: zeroScenarios, min: '0', code: 2 },
    { name: 'exits 2 on a non-numeric floor', output: allPass, min: 'two', code: 2 },
    { name: 'exits 2 on an empty floor', output: allPass, min: '', code: 2 },
    { name: 'exits 2 on a blank floor', output: allPass, min: '   ', code: 2 },
    { name: 'exits 2 on a negative floor', output: allPass, min: '-1', code: 2 },
  ])('$name', ({ output, min, code }) => {
    expect(main(['gate', '--min', min, '--log', log('run.log', output)])).toBe(code)
  })

  it('names the zero-scenario run apart from a missing summary', () => {
    main(['gate', '--min', '1', '--log', log('zero.log', zeroScenarios)])
    expect(err).toHaveBeenCalledWith(expect.stringContaining('cucumber ran 0 scenarios'))
    main(['gate', '--min', '1', '--log', log('none.log', noSummary)])
    expect(err).toHaveBeenCalledWith(expect.stringContaining('no cucumber scenario summary'))
  })

  it('prints the gate line with the suite name and skipped count', () => {
    const file = log('run.log', withSkipped)
    expect(main(['gate', '--min', '3', '--log', file, '--suite', 'api'])).toBe(0)
    expect(out).toHaveBeenCalledWith('gate api: 3/3 passed, 1 skipped')
  })

  it('reads stdin for --log -', () => {
    expect(gate(['--min', '2', '--log', '-'], () => allPass)).toBe(0)
    expect(out).toHaveBeenCalledWith('gate cucumber: 2/2 passed')
    expect(gate(['--min', '2', '--log', '-'], () => belowFloor)).toBe(1)
  })

  it('needs --min and --log', () => {
    expect(main(['gate', '--log', log('run.log', allPass)])).toBe(2)
    expect(main(['gate', '--min', '1'])).toBe(2)
  })
})
