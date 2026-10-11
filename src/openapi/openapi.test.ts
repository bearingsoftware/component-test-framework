import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadSpec, findOperation } from './spec'
import { readOperationMap } from './map-file'
import { generateOperationMap, namedOperations, operationName } from './generate'
import { checkOperationMaps } from './check'
import { auditCoverage, findFeatureFiles } from './audit'
import { main } from '../cli'

const fixtures = path.join(__dirname, '__fixtures__')
const shop = path.join(fixtures, 'shop.yaml')
const unnamed = path.join(fixtures, 'unnamed.json')
const map = path.join(fixtures, 'map.ts')

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-openapi-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  return file
}

describe('loadSpec', () => {
  it("reads every operation, with the server URL's path as the base, and follows path $refs", () => {
    expect(loadSpec(shop).map((op) => `${op.operationId} ${op.method} ${op.path}`)).toEqual([
      'listOrders GET /api/v1/orders',
      'createOrder POST /api/v1/orders',
      'getOrder GET /api/v1/orders/{orderId}',
      'cancelOrder DELETE /api/v1/orders/{orderId}',
      'listMyOrders GET /api/v1/orders/mine',
      'health GET /api/v1/health',
      'listThings GET /api/v1/things',
    ])
  })

  it("reads Swagger 2's basePath, and takes a base path given instead", () => {
    expect(loadSpec(unnamed)[0]).toMatchObject({
      path: '/v2/projects/{id}/remediable',
      route: '/projects/{id}/remediable',
    })
    expect(loadSpec(shop, { basePath: '' })[0].path).toBe('/orders')
  })

  it('takes a relative server URL as the base path', () => {
    const spec = tmpFile(
      'rel.yaml',
      'openapi: 3.1.0\nservers: [{ url: /api/v1/ }]\npaths: { /x: { get: {} } }\n',
    )
    expect(loadSpec(spec)[0].path).toBe('/api/v1/x')
  })
})

describe('findOperation', () => {
  const ops = loadSpec(shop)
  it('matches spec parameters to any value, ignores query strings, and prefers the most specific path', () => {
    expect(findOperation(ops, 'GET', '/api/v1/orders/o-1?expand=lines')?.operationId).toBe(
      'getOrder',
    )
    expect(findOperation(ops, 'get', '/api/v1/orders/{id}')?.operationId).toBe('getOrder')
    expect(findOperation(ops, 'GET', '/api/v1/orders/mine')?.operationId).toBe('listMyOrders')
    // A trailing slash is a different path, as it is to most routers.
    expect(findOperation(ops, 'GET', '/api/v1/orders/')).toBeUndefined()
    expect(findOperation(ops, 'PUT', '/api/v1/orders/o-1')).toBeUndefined()
    expect(findOperation(ops, 'GET', '/api/v1/orders/o-1/lines')).toBeUndefined()
  })
})

describe('readOperationMap', () => {
  it('reads wrapped, commented and quoted entries without running the file', () => {
    expect(readOperationMap(map)).toEqual({
      entries: [
        { key: 'listOrders', method: 'GET', path: '/api/v1/orders', line: 5 },
        { key: 'createOrder', method: 'POST', path: '/api/v1/orders', line: 7 },
        { key: 'getOrder', method: 'GET', path: '/api/v1/orders/o-123?expand=lines', line: 12 },
        { key: 'listMyOrders', method: 'GET', path: '/api/v1/orders/mine', line: 13 },
      ],
      unreadable: [],
    })
  })

  it("reports entries it can't read rather than skipping them", () => {
    const file = tmpFile(
      'map.ts',
      `const base = { a: { method: 'GET', path: '/a' } }
export const operationMap: OperationMap = {
  ...base,
  b: { method: 'GET', path: PATH },
}`,
    )
    expect(readOperationMap(file).unreadable.map((u) => `${u.line} ${u.reason}`)).toEqual([
      '3 not a plain property (a spread or a method)',
      '4 method or path is not a string literal',
    ])
  })

  it('reads a JSON map, and names a missing export', () => {
    expect(
      readOperationMap(tmpFile('m.json', '{"a":{"method":"get","path":"/a"}}')).entries,
    ).toEqual([{ key: 'a', method: 'GET', path: '/a', line: 0 }])
    expect(() => readOperationMap(map, 'apiMap')).toThrow(
      /no top-level object literal named apiMap/,
    )
  })
})

describe('generateOperationMap', () => {
  it('names an operation without an operationId from its method and path', () => {
    expect(operationName('GET', '/projects/{id}/remediable')).toBe('getProjectsByIdRemediable')
    expect(operationName('POST', '/2fa/codes')).toBe('post2faCodes')
    expect(operationName('GET', '/library/look-up_v2')).toBe('getLibraryLookUpV2')
  })

  it('keeps generated names distinct from operationIds and each other', () => {
    const names = namedOperations([
      { operationId: 'getA', method: 'GET', path: '/x', route: '/x' },
      { method: 'GET', path: '/a', route: '/a' },
      { method: 'GET', path: '/a/', route: '/a/' },
    ]).map((op) => op.name)
    expect(names).toEqual(['getA', 'getA2', 'getA3'])
  })

  it('writes a typed map, with summaries as comments, that checks clean against its spec', () => {
    const output = generateOperationMap(loadSpec(shop), { specLabel: 'shop.yaml' })
    expect(output).toContain(
      "  /** List orders *\\/ safely */\n  listOrders: { method: 'GET', path: '/api/v1/orders' },",
    )
    expect(output).toContain('} as const satisfies OperationMap')
    expect(output).toContain('export type OperationName = keyof typeof operationMap')
    const file = tmpFile('operation-map.ts', output)
    expect(checkOperationMaps([{ map: file, spec: shop, complete: true }]).problems).toEqual([])
  })

  it('filters by name, and generates names for a spec without operationIds', () => {
    const output = generateOperationMap(loadSpec(unnamed), {
      specLabel: 'unnamed.json',
      exclude: /^post/,
    })
    expect(output.match(/^ {2}\w+:/gm)).toEqual(['  getProjectsByIdRemediable:', '  getProjects:'])
    const file = tmpFile(
      'operation-map.ts',
      generateOperationMap(loadSpec(unnamed), { specLabel: 'x' }),
    )
    expect(checkOperationMaps([{ map: file, spec: unnamed, complete: true }]).problems).toEqual([])
  })
})

describe('checkOperationMaps', () => {
  const problems = (source: string, options: { complete?: boolean; allowlist?: string[] } = {}) =>
    checkOperationMaps(
      [
        {
          map: tmpFile('map.ts', `export const operationMap = {\n${source}\n}`),
          spec: shop,
          complete: options.complete,
        },
      ],
      {
        allowlist: options.allowlist,
      },
    )

  it('accepts a map that agrees with its spec, including concrete values and query strings', () => {
    expect(checkOperationMaps([{ map, spec: shop }])).toEqual({
      problems: [],
      allowlisted: [],
      stale: [],
    })
  })

  it('reports an entry missing from the spec, one whose path drifted, and one the spec names differently', () => {
    const result = problems(`  gone: { method: 'GET', path: '/api/v1/gone' },
  getOrder: { method: 'GET', path: '/api/v1/order/{id}' },
  cancel: { method: 'DELETE', path: '/api/v1/orders/{id}' },`)
    expect(
      result.problems.map((p) => `${p.where.split(':').pop()} ${p.message.replace(shop, 'spec')}`),
    ).toEqual([
      "2 'gone' (GET /api/v1/gone) is not in spec",
      "3 'getOrder' is GET /api/v1/order/{id} in the map but GET /api/v1/orders/{orderId} in spec",
      "4 'cancel' (DELETE /api/v1/orders/{id}) is called 'cancelOrder' in spec",
    ])
  })

  it('with complete, reports spec operations the map leaves out', () => {
    const result = checkOperationMaps([{ map, spec: shop, complete: true }])
    expect(result.problems.map((p) => p.key)).toEqual(['cancelOrder', 'health', 'listThings'])
  })

  it('leaves out allowlisted problems, and reports allowlist entries that match nothing', () => {
    const result = checkOperationMaps([{ map, spec: shop, complete: true }], {
      allowlist: ['health', 'listThings', 'cancelOrder', 'removedLongAgo'],
    })
    expect(result.problems).toEqual([])
    expect(result.allowlisted.map((p) => p.key)).toEqual(['cancelOrder', 'health', 'listThings'])
    expect(result.stale).toEqual(['removedLongAgo'])
  })

  it('matches a spec without operationIds by method and path, and allowlists by "METHOD /path"', () => {
    const file = tmpFile(
      'map.ts',
      "export const operationMap = {\n  remediable: { method: 'GET', path: '/v2/projects/web/remediable' },\n}",
    )
    const result = checkOperationMaps([{ map: file, spec: unnamed, complete: true }], {
      allowlist: ['GET /v2/projects', 'POST /v2/projects/{id}/remediable'],
    })
    expect(result.problems.map((p) => p.key)).toEqual(['POST /v2/2fa/codes'])
    expect(result.allowlisted).toHaveLength(2)
  })
})

describe('auditCoverage', () => {
  it('lists operations no feature references, ignoring comments, and names unknown references', () => {
    const result = auditCoverage({
      operations: loadSpec(shop),
      featureFiles: findFeatureFiles([fixtures]),
    })
    expect(result.gaps.map((op) => op.name)).toEqual([
      'listOrders',
      'cancelOrder',
      'listMyOrders',
      'health',
      'listThings',
    ])
    expect(result.operations.find((op) => op.name === 'createOrder')?.references).toEqual([
      `${path.join(fixtures, 'features', 'orders.feature')}:3`,
    ])
    expect(result.unknown).toEqual([
      { name: 'listOrdres', where: `${path.join(fixtures, 'features', 'orders.feature')}:6` },
    ])
  })

  it('names unnamed operations from the map, and takes other wordings', () => {
    const feature = tmpFile('a.feature', 'When I call remediable\nAnd I call projectsList\n')
    const result = auditCoverage({
      operations: loadSpec(unnamed),
      map: [
        { key: 'remediable', method: 'GET', path: '/v2/projects/web/remediable', line: 1 },
        { key: 'projectsList', method: 'GET', path: '/v2/projects', line: 2 },
      ],
      featureFiles: [feature],
      patterns: [/I call (\w+)/],
    })
    expect(result.gaps.map((op) => `${op.name ?? '-'} ${op.method} ${op.path}`)).toEqual([
      '- POST /v2/projects/{id}/remediable',
      '- POST /v2/2fa/codes',
    ])
  })
})

describe('ctf CLI', () => {
  const quiet = <T>(fn: () => T): T => {
    const log = console.log
    const error = console.error
    console.log = () => {}
    console.error = () => {}
    try {
      return fn()
    } finally {
      console.log = log
      console.error = error
    }
  }

  it('generates a map, then --check passes until the spec changes', () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-cli-')), 'operation-map.ts')
    expect(quiet(() => main(['generate-operation-map', shop, '--out', out]))).toBe(0)
    expect(quiet(() => main(['generate-operation-map', shop, '--out', out, '--check']))).toBe(0)
    fs.appendFileSync(out, '// edited\n')
    expect(quiet(() => main(['generate-operation-map', shop, '--out', out, '--check']))).toBe(1)
  })

  it('exits 1 on drift, 0 when clean, and 2 on a usage mistake', () => {
    expect(quiet(() => main(['check-operation-map', map, shop]))).toBe(0)
    expect(quiet(() => main(['check-operation-map', map, shop, '--complete']))).toBe(1)
    expect(quiet(() => main(['check-operation-map', '--pair', `${map}=${shop}`]))).toBe(0)
    expect(quiet(() => main(['check-operation-map', '--pair', 'no-equals-sign']))).toBe(2)
    expect(quiet(() => main(['check-operation-map', '--nonsense']))).toBe(2)
    expect(quiet(() => main(['frobnicate']))).toBe(2)
  })

  it('audits, failing only when asked to', () => {
    const args = ['audit-coverage', shop, '--features', fixtures]
    expect(quiet(() => main(args))).toBe(0)
    expect(quiet(() => main([...args, '--fail-on-gaps']))).toBe(1)
    expect(quiet(() => main(['audit-coverage', shop]))).toBe(2)
  })
})

describe('review fixes (COMPONENT-12)', () => {
  const spec = (body: string) => tmpFile('spec.yaml', `openapi: 3.0.3\n${body}`)
  const mapFile = (entries: string) =>
    tmpFile('map.ts', `export const operationMap = {\n${entries}\n}\n`)
  const quiet = <T>(fn: () => T): T => {
    const [log, error] = [console.log, console.error]
    console.log = console.error = () => {}
    try {
      return fn()
    } finally {
      console.log = log
      console.error = error
    }
  }

  it('reports an entry named for one operation whose request the spec routes to another', () => {
    const file = spec(
      'paths:\n  /orgs/me: { get: { operationId: getMe } }\n  /orgs/{id}: { get: { operationId: getOrg } }\n',
    )
    const result = checkOperationMaps([
      { map: mapFile("  getOrg: { method: 'GET', path: '/orgs/me' },"), spec: file },
    ])
    expect(result.problems.map((p) => p.message.replace(file, 'spec'))).toEqual([
      "'getOrg' is GET /orgs/me in the map, which spec routes to 'getMe' (GET /orgs/me), not to 'getOrg' (GET /orgs/{id})",
    ])
  })

  it('treats a trailing slash as a different path', () => {
    const file = spec('paths:\n  /x: { get: { operationId: getX } }\n')
    expect(
      checkOperationMaps([{ map: mapFile("  getX: { method: 'GET', path: '/x/' },"), spec: file }])
        .problems,
    ).toHaveLength(1)
  })

  it('takes the base path from server URLs with variables, or relative without a slash', () => {
    const ops = (servers: string) =>
      loadSpec(spec(`servers:\n${servers}\npaths:\n  /a: { get: {} }\n`))[0].path
    expect(
      ops(
        "  - url: '{scheme}://api.example.com/{base}'\n    variables:\n      scheme: { default: https }\n      base: { default: v2 }",
      ),
    ).toBe('/v2/a')
    expect(ops('  - url: api/v1/')).toBe('/api/v1/a')
    expect(ops('  - url: ./')).toBe('/a')
    expect(ops("  - url: 'https://{host}/x'\n    variables:\n      host: { default: h }")).toBe(
      '/x/a',
    )
  })

  it('matches parameters that are part of a segment', () => {
    const ops = loadSpec(
      spec('paths:\n  /files/{name}.json: { get: {} }\n  /v1/{name}:cancel: { post: {} }\n'),
    )
    expect(findOperation(ops, 'GET', '/files/report.json')?.path).toBe('/files/{name}.json')
    expect(findOperation(ops, 'GET', '/files/report.xml')).toBeUndefined()
    expect(findOperation(ops, 'POST', '/v1/job-1:cancel')?.path).toBe('/v1/{name}:cancel')
  })

  it('prefers a literal segment earlier in the path when routes are equally specific', () => {
    const ops = loadSpec(spec('paths:\n  /a/{x}/b: { get: {} }\n  /a/c/{y}: { get: {} }\n'))
    expect(findOperation(ops, 'GET', '/a/c/b')?.path).toBe('/a/c/{y}')
  })

  it('follows $ref chains, keeps YAML merge keys, and names a file that does not parse', () => {
    const file = spec(
      "x-base: &base\n  get: { operationId: merged }\npaths:\n  /m:\n    <<: *base\n  /r: { $ref: '#/x-a' }\nx-a: { $ref: '#/x-b' }\nx-b:\n  get: { operationId: chained }\n",
    )
    expect(loadSpec(file).map((op) => op.operationId)).toEqual(['merged', 'chained'])
    const broken = tmpFile('broken.yaml', 'paths: [unclosed\n')
    expect(() => loadSpec(broken)).toThrow(`${broken} can't be parsed`)
  })

  it("reads only a top-level map, and refuses a file that doesn't parse", () => {
    const nested = tmpFile(
      'm.ts',
      "function f() { const operationMap = { inner: { method: 'GET', path: '/i' } } }\nexport const operationMap = { outer: { method: 'GET', path: '/o' } }\n",
    )
    expect(readOperationMap(nested).entries.map((e) => e.key)).toEqual(['outer'])
    const broken = tmpFile(
      'm.ts',
      "export const operationMap = {\n  a: { method: 'GET', path: '/a' }\n  b: { method: 'GET', path: '/b' },\n}\n",
    )
    expect(() => readOperationMap(broken)).toThrow(/m\.ts:3: ',' expected/)
  })

  it('reports a duplicate key, keeping the entry that wins at runtime', () => {
    const result = readOperationMap(
      mapFile("  a: { method: 'GET', path: '/old' },\n  a: { method: 'GET', path: '/new' },"),
    )
    expect(result.entries).toEqual([{ key: 'a', method: 'GET', path: '/new', line: 3 }])
    expect(result.unreadable).toEqual([
      { key: 'a', line: 2, reason: 'duplicate key: the entry on line 3 replaces it' },
    ])
  })

  it('gives each pair its own base path', () => {
    const file = spec(
      'servers: [{ url: /api/v1 }]\npaths:\n  /auth/login: { post: { operationId: login } }\n',
    )
    const backend = mapFile("  login: { method: 'POST', path: '/api/v1/auth/login' },")
    const web = mapFile("  login: { method: 'POST', path: '/v1/auth/login' },")
    expect(
      checkOperationMaps([
        { map: backend, spec: file },
        { map: web, spec: file, basePath: '/v1' },
      ]).problems,
    ).toEqual([])
    expect(
      quiet(() =>
        main([
          'check-operation-map',
          '--pair',
          `${backend}=${file}`,
          '--pair',
          `${web}=${file}=/v1`,
        ]),
      ),
    ).toBe(0)
  })

  it("writes a header that doesn't depend on where the command ran, and --check accepts CRLF", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-cli-'))
    const out = path.join(dir, 'maps', 'operation-map.ts')
    const cwd = process.cwd()
    try {
      expect(quiet(() => main(['generate-operation-map', shop, '--out', out]))).toBe(0)
      process.chdir(dir)
      expect(
        quiet(() =>
          main(['generate-operation-map', shop, '--out', 'maps/operation-map.ts', '--check']),
        ),
      ).toBe(0)
      fs.writeFileSync(out, fs.readFileSync(out, 'utf-8').replace(/\n/g, '\r\n'))
      expect(quiet(() => main(['generate-operation-map', shop, '--out', out, '--check']))).toBe(0)
    } finally {
      process.chdir(cwd)
    }
    expect(fs.readFileSync(out, 'utf-8').split(/\r?\n/)[0]).toBe(
      `// Generated from ${path.relative(path.dirname(out), shop).split(path.sep).join('/')} by ctf generate-operation-map.`,
    )
  })

  it("doesn't let an operation named __proto__ set the map's prototype", () => {
    const output = generateOperationMap(
      [{ operationId: '__proto__', method: 'GET', path: '/p', route: '/p' }],
      { specLabel: 'x' },
    )
    expect(output).toContain("  ['__proto__']: { method: 'GET', path: '/p' },")
  })

  it('exits 2 when it cannot run, distinct from 1 for problems found', () => {
    expect(quiet(() => main(['check-operation-map', '/no/such/map.ts', shop]))).toBe(2)
    expect(quiet(() => main([]))).toBe(2)
    expect(quiet(() => main(['--help']))).toBe(0)
  })
})
