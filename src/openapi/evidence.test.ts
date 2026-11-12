import { describe, it, expect, vi, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { collectEvidence } from './evidence'
import { main } from '../cli'

type Files = Record<string, string>

function spec(ops: Record<string, { id: string; statuses: string[] }> = {}, extra = ''): string {
  const paths = Object.entries(ops)
    .map(
      ([route, { id, statuses }]) =>
        `  ${route}:\n    get:\n      operationId: ${id}\n      responses:\n` +
        statuses.map((s) => `        '${s}': { description: d }\n`).join('') +
        extra,
    )
    .join('')
  return `openapi: 3.0.3\ninfo: { title: T, version: '1' }\npaths:\n${paths || '  {}\n'}`.replace(
    'paths:\n  {}',
    'paths: {}',
  )
}

function feature(scenarios: [string, string[]][]): string {
  return (
    'Feature: F\n' +
    scenarios
      .map(([name, steps]) => `\n  Scenario: ${name}\n${steps.map((s) => `    ${s}\n`).join('')}`)
      .join('')
  )
}

const call = (op: string, status?: string) => [
  `When I send the request r to the ${op} operation`,
  ...(status ? [`Then the response status should be ${status}`] : []),
]

const made: string[] = []
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true })
})

function repo(before: Files, after: Files): { dir: string; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-evidence-test-'))
  const run = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      stdio: 'pipe',
    })
  made.push(dir)
  run('init', '-q', '-b', 'main')
  const write = (files: Files) => {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
      fs.writeFileSync(path.join(dir, name), content)
    }
  }
  write(before)
  run('add', '-A')
  run('commit', '-q', '-m', 'base', '--allow-empty')
  write(after)
  run('add', '-A')
  run('commit', '-q', '-m', 'head', '--allow-empty')
  return { dir, out: path.join(dir, 'ev-out') }
}

function evidence(
  before: Files,
  after: Files,
  extra: Partial<Parameters<typeof collectEvidence>[0]> = {},
) {
  const { dir, out } = repo(before, after)
  const result = collectEvidence({
    base: 'HEAD~1',
    head: 'HEAD',
    specs: ['api.yaml'],
    features: ['features'],
    out,
    cwd: dir,
    ...extra,
  })
  const text = (f: string) => fs.readFileSync(path.join(out, f), 'utf-8')
  const files = {
    base: text('coverage-base.txt'),
    head: text('coverage-head.txt'),
    apiBreak: text('api-break.txt'),
  }
  // What risk-gate's parser accepts: trimmed, numeric, true/false.
  for (const n of [files.base, files.head]) expect(Number.isFinite(parseFloat(n.trim()))).toBe(true)
  expect(['true', 'false']).toContain(files.apiBreak.trim())
  expect(JSON.parse(text('evidence.json'))).toEqual(JSON.parse(JSON.stringify(result)))
  return { result, files, dir }
}

const ONE = { '/a': { id: 'getA', statuses: ['200', '404'] } }

describe('collectEvidence', () => {
  it('treats a new spec and new features as empty at base', () => {
    const { result, files } = evidence(
      {},
      {
        'api.yaml': spec(ONE),
        'features/a.feature': feature([['a', call('getA', '200')]]),
      },
    )
    expect(files).toEqual({ base: '50.00', head: '50.00', apiBreak: 'false' })
    expect(result.coverage.noDocumentedStatuses).toBe(false)
    expect(result.coverage.delta).toBe(0)
    expect(result.specs).toMatchObject([{ presentAtBase: false }])
    expect(result.scenarios.added).toEqual([{ file: 'features/a.feature', name: 'a' }])
    expect(result.statusGaps.new).toEqual([
      { operation: 'getA', method: 'GET', path: '/a', status: '404' },
    ])
  })

  it('reports a removed operation as an api break', () => {
    const { files, result } = evidence(
      { 'api.yaml': spec({ ...ONE, '/b': { id: 'getB', statuses: ['200'] } }) },
      { 'api.yaml': spec(ONE) },
    )
    expect(files.apiBreak).toBe('true')
    expect(result.apiDiff.breaking.map((f) => f.rule)).toEqual(['operation-removed'])
    expect(result.operations.changedInSpec).toEqual(['GET /b'])
  })

  it('lists a gap an added scenario closes, and raises coverage', () => {
    const { files, result } = evidence(
      {
        'api.yaml': spec(ONE),
        'features/a.feature': feature([['ok', call('getA', '200')]]),
      },
      {
        'api.yaml': spec(ONE),
        'features/a.feature': feature([
          ['ok', call('getA', '200')],
          ['missing', call('getA', '404')],
        ]),
      },
    )
    expect(files).toEqual({ base: '50.00', head: '100.00', apiBreak: 'false' })
    expect(result.statusGaps.closed).toEqual([
      { operation: 'getA', method: 'GET', path: '/a', status: '404' },
    ])
    expect(result.statusGaps.new).toEqual([])
    expect(result.statusGaps.head).toBe(0)
    expect(result.scenarios.added).toEqual([{ file: 'features/a.feature', name: 'missing' }])
  })

  it('treats a scenario with different steps as changed, not added', () => {
    const { result } = evidence(
      {
        'api.yaml': spec(ONE),
        'features/a.feature': feature([['ok', call('getA', '200')]]),
      },
      {
        'api.yaml': spec(ONE),
        'features/a.feature': feature([['ok', call('getA', '404')]]),
      },
    )
    expect(result.scenarios).toMatchObject({
      added: [],
      removed: [],
      changed: [{ file: 'features/a.feature', name: 'ok', tagsChanged: false }],
    })
  })

  it('counts an Outline as one scenario', () => {
    const outline =
      'Feature: F\n  Scenario Outline: status <s>\n    When I send the request r to the getA operation\n' +
      '    Then the response status should be <s>\n    Examples:\n      | s |\n      | 200 |\n      | 404 |\n'
    const { result, files } = evidence(
      { 'api.yaml': spec(ONE) },
      { 'api.yaml': spec(ONE), 'features/a.feature': outline },
    )
    expect(result.scenarios.added).toEqual([{ file: 'features/a.feature', name: 'status <s>' }])
    expect(files.head).toBe('100.00')
  })

  it('flags a spec change no scenario follows, and not one that has', () => {
    const wider = {
      '/a': { id: 'getA', statuses: ['200', '404', '500'] },
      '/b': { id: 'getB', statuses: ['200'] },
    }
    const feats = { 'features/a.feature': feature([['a', call('getA', '200')]]) }
    const without = evidence(
      { 'api.yaml': spec({ ...ONE, '/b': wider['/b'] }), ...feats },
      { 'api.yaml': spec(wider), ...feats },
    )
    expect(without.result.operations).toEqual({
      changedInSpec: ['GET /a'],
      changedWithoutScenario: ['GET /a'],
    })
    const withScenario = evidence(
      { 'api.yaml': spec({ ...ONE, '/b': wider['/b'] }), ...feats },
      {
        'api.yaml': spec(wider),
        'features/a.feature': feature([
          ['a', call('getA', '200')],
          ['a500', call('getA', '500')],
        ]),
      },
    )
    expect(withScenario.result.operations.changedWithoutScenario).toEqual([])
  })

  it('aggregates several specs weighted by documented statuses', () => {
    const { result, files } = evidence(
      {},
      {
        'a.yaml': spec({ '/a': { id: 'getA', statuses: ['200', '404', '500'] } }),
        'b.yaml': spec({ '/b': { id: 'getB', statuses: ['200'] } }),
        'features/x.feature': feature([
          ['a', call('getA', '200')],
          ['b', call('getB', '200')],
        ]),
      },
      { specs: ['a.yaml', 'b.yaml'] },
    )
    expect(files.head).toBe('50.00')
    expect(result.coverage.pairs.head).toEqual({ asserted: 2, total: 4 })
    expect(result.specs).toHaveLength(2)
  })

  it('exits 2 naming a base ref that does not exist', () => {
    const { dir, out } = repo({}, { 'api.yaml': spec(ONE) })
    const cwd = process.cwd()
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: string) => void errors.push(m))
    process.chdir(dir)
    try {
      expect(
        main([
          'evidence',
          '--base',
          'origin/nope',
          '--spec',
          'api.yaml',
          '--features',
          'features',
          '--out',
          out,
        ]),
      ).toBe(2)
    } finally {
      process.chdir(cwd)
      spy.mockRestore()
    }
    expect(errors.join('\n')).toMatch(/origin\/nope.*fetch-depth: 0/s)
    expect(fs.existsSync(out)).toBe(false)
  })

  it('writes 100.00 and says so when no statuses are documented', () => {
    const { result, files } = evidence({ 'api.yaml': spec({}) }, { 'api.yaml': spec({}) })
    expect(files).toEqual({ base: '100.00', head: '100.00', apiBreak: 'false' })
    expect(result.coverage.noDocumentedStatuses).toBe(true)
  })

  it('excludes default and counts a 2XX range once', () => {
    const { files, result } = evidence(
      {},
      {
        'api.yaml': spec({ '/a': { id: 'getA', statuses: ['2XX', 'default', '404'] } }),
        'features/a.feature': feature([['a', call('getA', '201')]]),
      },
    )
    expect(files.head).toBe('50.00')
    expect(result.coverage.pairs.head).toEqual({ asserted: 1, total: 2 })
  })

  it('does not count an allowlisted break', () => {
    const { files, result } = evidence(
      {
        'api.yaml': spec({ ...ONE, '/b': { id: 'getB', statuses: ['200'] } }),
        'allow.txt': 'GET /b\n',
      },
      { 'api.yaml': spec(ONE), 'allow.txt': 'GET /b\n' },
      { allowlist: 'allow.txt' },
    )
    expect(files.apiBreak).toBe('false')
    expect(result.apiDiff.suppressed).toBe(1)
    expect(result.apiDiff.breaking).toEqual([])
  })

  it('ignores an allowlist entry the change adds for its own break', () => {
    const { files, result } = evidence(
      { 'api.yaml': spec({ ...ONE, '/b': { id: 'getB', statuses: ['200'] } }) },
      { 'api.yaml': spec(ONE), 'allow.txt': 'GET /b\n' },
      { allowlist: 'allow.txt' },
    )
    expect(files.apiBreak).toBe('true')
    expect(result.apiDiff.suppressed).toBe(0)
    expect(result.apiDiff.allowlist).toMatchObject({
      source: 'base',
      entries: [],
      headDiffers: true,
    })
  })

  it('reads the base spec despite export-ignore, and a file over 1 MB', () => {
    const padding = `${'# padding\n'.repeat(150_000)}`
    const feats = { 'features/a.feature': padding + feature([['a', call('getA', '200')]]) }
    expect(padding.length).toBeGreaterThan(1 << 20)
    const { files, result } = evidence(
      { 'api.yaml': spec(ONE), '.gitattributes': 'api.yaml export-ignore\n', ...feats },
      { 'api.yaml': spec(ONE), '.gitattributes': 'api.yaml export-ignore\n', ...feats },
    )
    expect(files.base).toBe('50.00')
    expect(result.specs).toMatchObject([{ presentAtBase: true }])
    expect(result.scenarios.changed).toEqual([])
  })

  it('removes earlier output, so a run that cannot run leaves none', () => {
    const { dir, out } = repo({}, { 'api.yaml': spec(ONE) })
    fs.mkdirSync(out)
    for (const f of ['coverage-base.txt', 'coverage-head.txt', 'api-break.txt', 'evidence.json']) {
      fs.writeFileSync(path.join(out, f), 'stale')
    }
    expect(() =>
      collectEvidence({ base: 'nope', specs: ['api.yaml'], features: ['features'], out, cwd: dir }),
    ).toThrow(/nope/)
    expect(fs.readdirSync(out)).toEqual([])
  })

  it('leaves no temporary directory behind, on success or failure', () => {
    const { dir, out } = repo({}, { 'api.yaml': spec(ONE) })
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-evidence-scratch-'))
    made.push(scratch)
    const before = process.env.TMPDIR
    process.env.TMPDIR = scratch
    try {
      const options = { base: 'HEAD~1', head: 'HEAD', features: ['features'], out, cwd: dir }
      collectEvidence({ ...options, specs: ['api.yaml'] })
      expect(fs.readdirSync(scratch)).toEqual([])
      expect(() => collectEvidence({ ...options, specs: ['missing.yaml'] })).toThrow(/missing.yaml/)
      expect(fs.readdirSync(scratch)).toEqual([])
    } finally {
      if (before === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = before
    }
  })

  it('does not count scenarios tagged @skip, and records them', () => {
    const feats = (tag: string) =>
      `Feature: F\n\n  ${tag}\n  Scenario: s\n    ${call('getA', '404').join('\n    ')}\n\n  Scenario: ok\n    ${call('getA', '200').join('\n    ')}\n`
    const { files, result } = evidence(
      { 'api.yaml': spec(ONE), 'features/a.feature': feats('@smoke') },
      { 'api.yaml': spec(ONE), 'features/a.feature': feats('@skip') },
    )
    expect(files).toEqual({ base: '100.00', head: '50.00', apiBreak: 'false' })
    expect(result.scenarios.excluded).toEqual({
      tags: ['@skip', '@pending', '@wip'],
      head: [{ file: 'features/a.feature', name: 's' }],
    })
    expect(result.scenarios.changed).toEqual([
      { file: 'features/a.feature', name: 's', tagsChanged: true },
    ])
    const custom = evidence(
      { 'api.yaml': spec(ONE), 'features/a.feature': feats('@smoke') },
      { 'api.yaml': spec(ONE), 'features/a.feature': feats('@SMOKE') },
      { excludeTags: ['@smoke'] },
    )
    expect(custom.files.head).toBe('50.00')
    expect(custom.result.scenarios.excluded.tags).toEqual(['@skip', '@pending', '@wip', '@smoke'])
    const only = evidence(
      { 'api.yaml': spec(ONE), 'features/a.feature': feats('@smoke') },
      { 'api.yaml': spec(ONE), 'features/a.feature': feats('@skip') },
      { excludeTags: ['@smoke'], noDefaultExclusions: true },
    )
    expect(only.files.head).toBe('100.00')
    expect(only.result.scenarios.excluded.tags).toEqual(['@smoke'])
  })

  it('lists documented statuses the head no longer documents', () => {
    const { result } = evidence(
      { 'api.yaml': spec({ '/a': { id: 'getA', statuses: ['200', '404', 'default'] } }) },
      { 'api.yaml': spec({ '/a': { id: 'getA', statuses: ['200'] } }) },
    )
    expect(result.statusesRemoved).toEqual([{ method: 'GET', path: '/a', status: '404' }])
  })

  it('finds scenarios that use a map alias', () => {
    const noId = (statuses: string[]) =>
      `openapi: 3.0.3\ninfo: { title: T, version: '1' }\npaths:\n  /a:\n    get:\n      responses:\n${statuses.map((s) => `        '${s}': { description: d }\n`).join('')}`
    const map = JSON.stringify({ fetchA: { method: 'GET', path: '/a' } })
    const feat = (extra: string[][]) =>
      feature([
        ['a', call('fetchA', '200')],
        ...extra.map((s, i): [string, string[]] => [`x${i}`, s]),
      ])
    const base = { 'api.yaml': noId(['200']), 'map.json': map, 'features/a.feature': feat([]) }
    const without = evidence(
      base,
      { ...base, 'api.yaml': noId(['200', '500']) },
      { map: 'map.json' },
    )
    expect(without.result.operations.changedWithoutScenario).toEqual(['GET /a'])
    const withScenario = evidence(
      base,
      {
        ...base,
        'api.yaml': noId(['200', '500']),
        'features/a.feature': feat([call('fetchA', '500')]),
      },
      { map: 'map.json' },
    )
    expect(withScenario.result.operations.changedInSpec).toEqual(['GET /a'])
    expect(withScenario.result.operations.changedWithoutScenario).toEqual([])
  })

  it('marks an Outline changed when only an Examples row changes', () => {
    const outline = (rows: string) =>
      `Feature: F\n  Scenario Outline: status\n    When I send the request r to the getA operation\n    Then the response status should be <s>\n    Examples:\n      | s |\n${rows}`
    const { result } = evidence(
      { 'api.yaml': spec(ONE), 'features/a.feature': outline('      | 200 |\n') },
      { 'api.yaml': spec(ONE), 'features/a.feature': outline('      | 200 |\n      | 404 |\n') },
    )
    expect(result.scenarios.changed).toEqual([
      { file: 'features/a.feature', name: 'status', tagsChanged: false },
    ])
  })

  it('honours tags on an Examples block, row by row', () => {
    const wide = { '/a': { id: 'getA', statuses: ['200', '404', '500'] } }
    const outline = (skip404: boolean, skip500: boolean) =>
      'Feature: F\n  Scenario Outline: status\n    When I send the request r to the getA operation\n' +
      '    Then the response status should be <s>\n\n' +
      '    Examples:\n      | s |\n      | 200 |\n\n' +
      `    ${skip404 ? '@skip' : '@keep'}\n    Examples:\n      | s |\n      | 404 |\n\n` +
      `    ${skip500 ? '@skip' : '@keep'}\n    Examples:\n      | s |\n      | 500 |\n`
    const { files, result } = evidence(
      { 'api.yaml': spec(wide), 'features/a.feature': outline(false, false) },
      { 'api.yaml': spec(wide), 'features/a.feature': outline(true, false) },
    )
    expect(files).toEqual({ base: '100.00', head: '66.67', apiBreak: 'false' })
    expect(result.scenarios.excluded.head).toEqual([])
    const all = evidence(
      { 'api.yaml': spec(wide) },
      {
        'api.yaml': spec(wide),
        'features/a.feature': outline(true, true).replace(
          'Examples:\n      | s |\n      | 200 |',
          '@skip\n    Examples:\n      | s |\n      | 200 |',
        ),
      },
    )
    expect(all.files.head).toBe('0.00')
    expect(all.result.scenarios.excluded.head).toEqual([
      { file: 'features/a.feature', name: 'status' },
    ])
  })

  it('exits 2 naming a file whose object is missing', () => {
    const { dir, out } = repo(
      { 'api.yaml': spec(ONE), 'features/a.feature': feature([['a', call('getA', '200')]]) },
      { 'api.yaml': spec(ONE), 'features/a.feature': feature([['b', call('getA', '404')]]) },
    )
    const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD~1:features/a.feature'], {
      encoding: 'utf-8',
    }).trim()
    fs.rmSync(path.join(dir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)))
    expect(() =>
      collectEvidence({
        base: 'HEAD~1',
        head: 'HEAD',
        specs: ['api.yaml'],
        features: ['features'],
        out,
        cwd: dir,
      }),
    ).toThrow(/features\/a\.feature.*missing/)
  })
})
