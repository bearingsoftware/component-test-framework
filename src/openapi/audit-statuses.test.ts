import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { auditCoverage, findFeatureFiles } from './audit'
import { parseFeature } from './gherkin'
import { loadSpecDetail } from './spec'
import { main } from '../cli'

const fixtures = path.join(__dirname, '__fixtures__')
const dir = path.join(fixtures, 'audit-statuses')
const spec = path.join(dir, 'api.yaml')
const rel = (file: string) => path.relative(process.cwd(), file)

function tmpFeature(text: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-gherkin-')), 'x.feature')
  fs.writeFileSync(file, text)
  return file
}

function audit(featureFiles: string[], statusPatterns?: RegExp[]) {
  return auditCoverage({
    operations: loadSpecDetail(spec).operations,
    featureFiles,
    statusPatterns,
  })
}

const named = (result: ReturnType<typeof audit>, name: string) =>
  result.operations.find((op) => op.name === name)!

describe('parseFeature', () => {
  it('expands Outline rows, resolving placeholders in every step', () => {
    const scenarios = parseFeature(
      [
        'Feature: f',
        '  Scenario Template: t <n>',
        '    When I go to the <op> operation',
        '    Then the response status should be <status>',
        '    Examples:',
        '      | op | status | n |',
        '      | a  | 201    | 1 |',
        '      | b  | 404    | 2 |',
        '    Scenarios:',
        '      | op | status | n |',
        '      | c  | 500    | 3 |',
      ].join('\n'),
    )
    expect(scenarios.map((s) => [s.name, ...s.steps.map((x) => x.text)])).toEqual([
      ['t 1', 'I go to the a operation', 'the response status should be 201'],
      ['t 2', 'I go to the b operation', 'the response status should be 404'],
      ['t 3', 'I go to the c operation', 'the response status should be 500'],
    ])
  })

  it('puts the Feature Background, then the Rule Background, before each scenario', () => {
    const scenarios = parseFeature(
      [
        'Feature: f',
        '  Background:',
        '    Given feature step',
        '  Scenario: before rules',
        '    When own step',
        '  Rule: r',
        '    Background:',
        '      Given rule step',
        '    Example: in rule',
        '      When rule scenario step',
        '  Rule: s',
        '    Scenario: other rule',
        '      When other',
      ].join('\n'),
    )
    expect(scenarios.map((s) => s.steps.map((x) => x.text))).toEqual([
      ['feature step', 'own step'],
      ['feature step', 'rule step', 'rule scenario step'],
      ['feature step', 'other'],
    ])
  })

  it('ignores doc strings, tables, comments, tags and descriptions, and keeps step lines', () => {
    const scenarios = parseFeature(
      [
        '@tag',
        'Feature: f',
        '  Then described, not a step',
        '  Scenario: s',
        '    # Given commented',
        '    Given real',
        '      """',
        '      Then fake in doc string',
        '      # still in the doc string',
        '      """',
        '    And other',
        '      | Then | fake in table |',
        '      ```',
        '      When fake in backticks',
        '      ```',
        '    * star',
      ].join('\n'),
    )
    expect(scenarios).toHaveLength(1)
    expect(scenarios[0].steps).toEqual([
      { text: 'real', line: 6 },
      { text: 'other', line: 11 },
      { text: 'star', line: 16 },
    ])
  })
})

describe('auditCoverage statuses (COMPONENT-27)', () => {
  const result = audit(findFeatureFiles([dir]))
  const at = (file: string, line: number) => `${path.join(dir, file)}:${line}`

  it('pairs each reference with the first status before the next reference', () => {
    const get = named(result, 'getWidget')
    expect(get.statuses).toEqual([
      {
        status: '200',
        references: [
          `${at('multi.feature', 5)} -> ${at('multi.feature', 6)}`,
          `${at('rules.feature', 22)} -> ${at('rules.feature', 26)}`,
        ],
      },
      {
        status: '404',
        references: [`${at('rules.feature', 13)} -> ${at('rules.feature', 19)}`],
      },
    ])
  })

  it('leaves a reference unasserted when the next reference or the end comes first, and ignores a status before any reference', () => {
    expect(named(result, 'createWidget').unassertedReferences).toEqual([at('multi.feature', 4)])
    const del = named(result, 'deleteWidget')
    expect(del.statuses).toEqual([])
    expect(del.unassertedReferences).toEqual([at('multi.feature', 10), at('multi.feature', 15)])
  })

  it('applies a second status to nothing', () => {
    expect(named(result, 'getWidget').statuses.map((s) => s.status)).not.toContain('500')
  })

  it('applies Background and Rule Background steps to every scenario, and not across Rules', () => {
    expect(named(result, 'ping').statuses.map((s) => s.status)).toEqual(['200'])
    expect(named(result, 'listWidgets').statuses.map((s) => s.status)).toEqual(['200'])
    expect(named(result, 'updateWidget').statuses.map((s) => s.status)).toEqual(['200'])
  })

  it('expands Outline rows, including a status placeholder, per row', () => {
    expect(
      named(result, 'createWidget').statuses.map((s) => [s.status, s.references.length]),
    ).toEqual([
      ['201', 1],
      ['400', 1],
      ['422', 1],
    ])
    expect(named(result, 'createWidget').statuses[1].references).toEqual([
      `${at('background.feature', 17)} -> ${at('background.feature', 18)}`,
    ])
  })

  it('does not scan doc strings or tables as steps', () => {
    // The doc string's fake 200, its fake deleteWidget, and the table's fake 500.
    expect(named(result, 'deleteWidget').references).toHaveLength(3)
    expect(named(result, 'getWidget').statuses.map((s) => s.status)).toEqual(['200', '404'])
    expect(named(result, 'deleteWidget').unassertedReferences).toHaveLength(2)
  })

  it('reports documented statuses nothing asserts: default is never one, a range is met by any match', () => {
    expect(result.statusGaps).toEqual([
      { operation: 'getWidget', method: 'GET', path: '/widgets/{id}', status: '500' },
      { operation: 'updateWidget', method: 'PUT', path: '/widgets/{id}', status: '4XX' },
      { operation: 'deleteWidget', method: 'DELETE', path: '/widgets/{id}', status: '204' },
      { operation: 'deleteWidget', method: 'DELETE', path: '/widgets/{id}', status: '404' },
    ])
  })

  it('takes --status-pattern wordings, the status in group 1', () => {
    const file = tmpFeature(
      [
        'Feature: f',
        '  Scenario: s',
        '    When I send the request a to the updateWidget operation',
        '    Then it answers with HTTP 418',
        '    And the response status should be 200',
      ].join('\n'),
    )
    const custom = audit([file], [/answers with HTTP (\d+)/])
    expect(named(custom, 'updateWidget').statuses.map((s) => s.status)).toEqual(['418'])
    expect(named(custom, 'updateWidget').unassertedReferences).toEqual([])
    expect(
      named(custom, 'updateWidget')
        .statuses.concat(named(audit([file]), 'updateWidget').statuses)
        .map((s) => s.status),
    ).toEqual(['418', '200'])
  })

  it('has no gaps for operations without documented responses', () => {
    const bare = auditCoverage({
      operations: [{ method: 'GET', path: '/x', route: '/x' }],
      featureFiles: [],
    })
    expect(bare.statusGaps).toEqual([])
  })
})

describe('ctf audit-coverage --statuses (COMPONENT-27)', () => {
  function run(args: string[]) {
    const out: string[] = []
    const err: string[] = []
    const [log, error] = [console.log, console.error]
    console.log = (...a: unknown[]) => void out.push(a.join(' '))
    console.error = (...a: unknown[]) => void err.push(a.join(' '))
    let status: number
    try {
      status = main(args)
    } finally {
      console.log = log
      console.error = error
    }
    return { status, stdout: out.join('\n'), stderr: err.join('\n') }
  }
  const base = ['audit-coverage', rel(spec), '--features', rel(dir)]

  it('prints status gaps with --statuses, and fails on them with --fail-on-gaps', () => {
    const plain = run([...base, '--fail-on-gaps'])
    expect(plain.status).toBe(0)
    expect(plain.stdout).toBe('')

    const withStatuses = run([...base, '--statuses'])
    expect(withStatuses.status).toBe(0)
    expect(withStatuses.stdout.split('\n')).toEqual([
      'getWidget\tGET /widgets/{id}\t500',
      'updateWidget\tPUT /widgets/{id}\t4XX',
      'deleteWidget\tDELETE /widgets/{id}\t204',
      'deleteWidget\tDELETE /widgets/{id}\t404',
    ])
    expect(run([...base, '--statuses', '--fail-on-gaps']).status).toBe(1)
  })

  it('honours --status-pattern', () => {
    const file = tmpFeature(
      'Feature: f\n  Scenario: s\n    When I send the request a to the ping operation\n    Then HTTP 200 came back\n',
    )
    const args = ['audit-coverage', rel(spec), '--features', file, '--statuses']
    const missed = run(args)
    expect(missed.stdout).toContain('ping\tGET /ping\t200')
    const found = run([...args, '--status-pattern', 'HTTP (\\d+) came'])
    expect(found.stdout).not.toContain('ping\tGET /ping')
    expect(run([...args, '--status-pattern', '(']).status).toBe(2)
  })

  it('always puts statuses and statusGaps in --json', () => {
    const json = JSON.parse(run([...base, '--json']).stdout)
    expect(json.statusGaps).toHaveLength(4)
    expect(json.operations[0]).toHaveProperty('statuses')
    expect(json.operations[0]).toHaveProperty('unassertedReferences')
  })
})

// Output recorded from the audit-coverage on main, before COMPONENT-27, for
// the existing fixtures. Without --statuses, text output and exit codes are
// the same; --json keeps every key it had, in order, and adds the new ones.
describe('audit-coverage without --statuses is unchanged from main (COMPONENT-27)', () => {
  const recorded = JSON.parse(
    fs.readFileSync(path.join(dir, 'main-output.json'), 'utf-8'),
  ) as Record<string, { args: string[]; status: number; stdout: string; stderr: string }>

  function capture(args: string[]) {
    const out: string[] = []
    const err: string[] = []
    const [log, error] = [console.log, console.error]
    console.log = (...a: unknown[]) => void out.push(a.join(' '))
    console.error = (...a: unknown[]) => void err.push(a.join(' '))
    let status: number
    try {
      status = main(args)
    } finally {
      console.log = log
      console.error = error
    }
    const text = (lines: string[]) => (lines.length ? `${lines.join('\n')}\n` : '')
    return { status, stdout: text(out), stderr: text(err) }
  }

  it.each(Object.keys(recorded).filter((k) => k !== 'json'))('%s', (name) => {
    const { args, status, stdout, stderr } = recorded[name]
    expect(capture(args)).toEqual({ status, stdout, stderr })
  })

  it('json adds keys and changes none', () => {
    const before = JSON.parse(recorded.json.stdout)
    const after = JSON.parse(capture(recorded.json.args).stdout)
    const strip = (op: Record<string, unknown>) => {
      const { statuses: _s, unassertedReferences: _u, ...rest } = op
      return rest
    }
    expect(after.operations.map(strip)).toEqual(before.operations)
    expect(after.gaps.map(strip)).toEqual(before.gaps)
    expect(after.unknown).toEqual(before.unknown)
    expect(Object.keys(after)).toEqual([...Object.keys(before), 'statusGaps'])
    expect(Object.keys(after.operations[0])).toEqual([
      ...Object.keys(before.operations[0]),
      'statuses',
      'unassertedReferences',
    ])
  })
})
