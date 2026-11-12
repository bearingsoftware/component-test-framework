import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { loadSpec } from './spec'
import { generateStubs, checkStubs } from './stubs'
import { main } from '../cli'

const pets = path.join(__dirname, '__fixtures__', 'stubs', 'pets.yaml')
const specHash = createHash('sha256').update(fs.readFileSync(pets)).digest('hex')

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-stubs-'))

function stub(operation: string, request: object, response: object, metadata: object = {}) {
  return {
    metadata: { generatedBy: 'ctf stubs', operation, specHash, ...metadata },
    request,
    response,
  }
}

function writeMappings(files: Record<string, object | string>): string {
  const dir = tmpDir()
  fs.mkdirSync(path.join(dir, 'mappings'))
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(dir, 'mappings', name),
      typeof content === 'string' ? content : JSON.stringify(content),
    )
  }
  return dir
}

const json = { 'Content-Type': 'application/json' }

describe('generateStubs', () => {
  it('writes the lowest 2xx of each operation, from its example, and lists what it skipped', () => {
    const { mappings, skipped } = generateStubs(pets)
    const meta = (operation: string) => ({ generatedBy: 'ctf stubs', operation, specHash })
    expect(mappings).toEqual([
      {
        file: 'mappings/listPets.json',
        mapping: {
          name: 'listPets',
          priority: 7,
          metadata: meta('listPets'),
          request: { method: 'GET', urlPathTemplate: '/api/pets' },
          response: {
            status: 200,
            headers: json,
            jsonBody: [
              { id: 1, name: 'Rex', tag: 'dog' },
              { id: 2, name: 'Tom', tag: null },
            ],
          },
        },
      },
      {
        file: 'mappings/createPet.json',
        mapping: {
          name: 'createPet',
          priority: 7,
          metadata: meta('createPet'),
          request: { method: 'POST', urlPathTemplate: '/api/pets' },
          response: { status: 201, headers: json, jsonBody: { id: 3, name: 'Kit' } },
        },
      },
      {
        file: 'mappings/getPet.json',
        mapping: {
          name: 'getPet',
          priority: 7,
          metadata: meta('getPet'),
          request: { method: 'GET', urlPathTemplate: '/api/pets/{petId}' },
          response: { status: 200, headers: json, jsonBody: { id: 7, name: 'Fido' } },
        },
      },
      {
        file: 'mappings/deletePet.json',
        mapping: {
          name: 'deletePet',
          priority: 7,
          metadata: meta('deletePet'),
          request: { method: 'DELETE', urlPathTemplate: '/api/pets/{petId}' },
          response: { status: 204 },
        },
      },
      {
        file: 'mappings/getTree.json',
        mapping: {
          name: 'getTree',
          priority: 7,
          metadata: meta('getTree'),
          request: { method: 'GET', urlPathTemplate: '/api/tree' },
          response: {
            status: 200,
            headers: json,
            jsonBody: { value: 'root', children: [{ value: 'leaf' }] },
          },
        },
      },
      {
        file: 'mappings/getMine.json',
        mapping: {
          name: 'getMine',
          // Three fixed segments, one more than /pets/{petId}, so it is tried first.
          priority: 6,
          metadata: meta('getMine'),
          request: { method: 'GET', urlPathTemplate: '/api/pets/mine' },
          response: { status: 200, headers: json, jsonBody: { id: 99, name: 'Mine' } },
        },
      },
      {
        file: 'mappings/getFlag.json',
        mapping: {
          name: 'getFlag',
          priority: 7,
          metadata: meta('getFlag'),
          request: { method: 'GET', urlPathTemplate: '/api/flag' },
          response: { status: 200, headers: json, jsonBody: false },
        },
      },
      {
        file: 'mappings/getNothing.json',
        mapping: {
          name: 'getNothing',
          priority: 7,
          metadata: meta('getNothing'),
          request: { method: 'GET', urlPathTemplate: '/api/nothing' },
          // WireMock serves a jsonBody of null as an empty body.
          response: { status: 200, headers: json, body: 'null' },
        },
      },
    ])
    expect(skipped).toEqual([
      { operation: 'listToys 200', reason: 'no example for the application/json response' },
    ])
  })

  it('with allStatuses, adds each documented status at a lower priority, and skips default', () => {
    const { mappings, skipped } = generateStubs(pets, { allStatuses: true })
    expect(mappings.map((m) => m.file)).toEqual([
      'mappings/listPets.json',
      'mappings/createPet.json',
      'mappings/createPet-400.json',
      'mappings/getPet.json',
      'mappings/getPet-404.json',
      'mappings/deletePet.json',
      'mappings/getTree.json',
      'mappings/getMine.json',
      'mappings/getFlag.json',
      'mappings/getNothing.json',
    ])
    expect(mappings.find((m) => m.file === 'mappings/getPet-404.json')?.mapping).toEqual({
      name: 'getPet 404',
      priority: 10,
      metadata: { generatedBy: 'ctf stubs', operation: 'getPet', specHash },
      request: { method: 'GET', urlPathTemplate: '/api/pets/{petId}' },
      response: { status: 404, headers: json, jsonBody: { message: 'no such pet' } },
    })
    expect(
      mappings
        .filter((m) => (m.mapping as { priority: number }).priority === 10)
        .map((m) => (m.mapping as { name: string }).name),
    ).toEqual(['createPet 400', 'getPet 404'])
    expect(skipped.map((s) => s.operation)).toEqual(['getPet default', 'listToys 200'])
  })

  it('takes the base path from the spec, or from basePath, and filters by name', () => {
    expect(generateStubs(pets, { basePath: '/v2', include: /^getPet$/ }).mappings).toHaveLength(1)
    expect(
      (
        generateStubs(pets, { basePath: '/v2', include: /^getPet$/ }).mappings[0].mapping as {
          request: object
        }
      ).request,
    ).toEqual({ method: 'GET', urlPathTemplate: '/v2/pets/{petId}' })
    const names = generateStubs(pets, { exclude: /^(get|delete)/ }).mappings.map((m) => m.file)
    expect(names).toEqual(['mappings/listPets.json', 'mappings/createPet.json'])
  })

  it('skips an operation with no 2xx, and an example that is not a string for a non-JSON body', () => {
    const dir = tmpDir()
    const spec = path.join(dir, 'x.yaml')
    fs.writeFileSync(
      spec,
      `openapi: 3.0.3
paths:
  /a: { get: { operationId: a, responses: { '500': { description: x } } } }
  /b:
    get:
      operationId: b
      responses:
        '200':
          description: x
          content: { text/plain: { example: 3 } }
  /c:
    get:
      operationId: c
      responses:
        '200':
          description: x
          content: { text/plain: { example: hello } }
`,
    )
    const { mappings, skipped } = generateStubs(spec)
    expect(skipped).toEqual([
      { operation: 'a', reason: 'no 2xx response is documented' },
      { operation: 'b 200', reason: "the example for text/plain isn't a string" },
    ])
    expect((mappings[0].mapping as { response: object }).response).toEqual({
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    })
  })

  it('stubs a null example as the text null, and a false one as false', () => {
    const find = (name: string) =>
      generateStubs(pets).mappings.find((m) => m.file === `mappings/${name}.json`)?.mapping as {
        response: object
      }
    expect(find('getNothing').response).toEqual({ status: 200, headers: json, body: 'null' })
    expect(find('getFlag').response).toEqual({ status: 200, headers: json, jsonBody: false })
  })

  it('gives a path with more fixed segments a lower priority number, all under 10', () => {
    const priorities = Object.fromEntries(
      generateStubs(pets).mappings.map((m) => [
        m.file,
        (m.mapping as { priority: number }).priority,
      ]),
    )
    expect(priorities['mappings/getMine.json']).toBeLessThan(priorities['mappings/getPet.json'])
    expect(Math.max(...Object.values(priorities))).toBeLessThan(10)
  })

  it('warns, and still writes the stub, when an example does not fit its schema', () => {
    const dir = tmpDir()
    const spec = path.join(dir, 'bad.yaml')
    fs.writeFileSync(
      spec,
      `openapi: 3.0.3
paths:
  /a:
    get:
      operationId: a
      responses:
        '200':
          description: x
          content: { application/json: { schema: { type: object, required: [id] }, example: {} } }
`,
    )
    const { mappings, warnings } = generateStubs(spec)
    expect(mappings).toHaveLength(1)
    expect(warnings).toEqual([
      {
        operation: 'a 200',
        reason: "the example doesn't fit its schema, at /id: missing required property 'id'",
      },
    ])
    expect(generateStubs(pets).warnings).toEqual([])
  })

  it('fails when two operations would be written to the same file', () => {
    const dir = tmpDir()
    const spec = path.join(dir, 'clash.yaml')
    const op = (id: string) =>
      `{ get: { operationId: ${id}, responses: { '200': { description: x } } } }`
    fs.writeFileSync(spec, `openapi: 3.0.3\npaths:\n  /a: ${op("'a/b'")}\n  /b: ${op("'a_b'")}\n`)
    expect(() => generateStubs(spec)).toThrow(
      "operations 'a/b' and 'a_b' would both be written to mappings/a_b.json",
    )
  })

  it("leaves loadSpec's result as it was", () => {
    expect(loadSpec(pets)[0]).toEqual({
      operationId: 'listPets',
      method: 'GET',
      path: '/api/pets',
      route: '/pets',
      summary: undefined,
    })
  })
})

describe('checkStubs', () => {
  it('accepts what it generated, and hand-written stubs that fit', () => {
    const dir = tmpDir()
    for (const { file, mapping } of generateStubs(pets, { allStatuses: true }).mappings) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      fs.writeFileSync(path.join(dir, file), JSON.stringify(mapping))
    }
    fs.writeFileSync(
      path.join(dir, 'mappings', 'mine.json'),
      JSON.stringify({
        request: { method: 'GET', urlPath: '/api/pets/9' },
        // `default` documents any status.
        response: { status: 503, jsonBody: { anything: true } },
      }),
    )
    expect(checkStubs(pets, dir)).toEqual({
      problems: [],
      warnings: [],
      allowlisted: [],
      stale: [],
    })
  })

  it('reports each kind of drift', () => {
    const dir = writeMappings({
      'gone.json': { request: { method: 'GET', url: '/api/nope' }, response: { status: 200 } },
      'status.json': {
        request: { method: 'DELETE', urlPathTemplate: '/api/pets/{id}' },
        response: { status: 200 },
      },
      'body.json': {
        request: { method: 'GET', urlPath: '/api/pets/1' },
        response: { status: 200, jsonBody: { id: 'x', name: 'a', extra: 1 } },
      },
      'string-body.json': {
        request: { method: 'GET', url: '/api/pets/1?x=1' },
        response: { status: 200, body: '{"id":1}' },
      },
      'ambiguous.json': {
        request: { method: 'GET', urlPathPattern: '/api/pets/.*' },
        response: { status: 200 },
      },
      'no-matcher.json': { request: { method: 'GET' }, response: { status: 200 } },
      'wrong-method.json': {
        request: { method: 'PUT', urlPath: '/api/pets' },
        response: { status: 200 },
      },
    })
    const { problems, warnings } = checkStubs(pets, dir)
    expect(warnings).toEqual([])
    expect(problems.map((p) => [p.key, p.message])).toEqual([
      [
        'ambiguous.json',
        'unresolved: GET urlPathPattern /api/pets/.* matches 3 operations at different paths',
      ],
      [
        'body.json',
        "the 200 response of GET /api/pets/{petId} has a body that doesn't fit its schema, at /id: expected integer, got string",
      ],
      [
        'body.json',
        "the 200 response of GET /api/pets/{petId} has a body that doesn't fit its schema, at /extra: additional property 'extra' is not allowed",
      ],
      ['gone.json', 'GET /api/nope matches no operation in the spec'],
      ['no-matcher.json', 'unresolved: the request has no URL matcher'],
      ['status.json', "DELETE /api/pets/{petId} doesn't document a 200 response"],
      [
        'string-body.json',
        "the 200 response of GET /api/pets/{petId} has a body that doesn't fit its schema, at /name: missing required property 'name'",
      ],
      ['wrong-method.json', 'PUT /api/pets matches no operation in the spec'],
    ])
    expect(problems[0].where).toBe(path.join(dir, 'mappings', 'ambiguous.json'))
  })

  it('resolves a pattern that fits one operation, and a method of ANY', () => {
    const dir = writeMappings({
      'pattern.json': {
        request: { method: 'GET', urlPathPattern: '/api/pets/[0-9]+' },
        response: { status: 200, jsonBody: { id: 1 } },
      },
      'any.json': {
        request: { urlPath: '/api/tree' },
        response: { status: 200, jsonBody: { value: 'a', children: [{ value: 3 }] } },
      },
    })
    const { problems } = checkStubs(pets, dir)
    expect(problems.map((p) => [p.key, p.message])).toEqual([
      [
        'any.json',
        "the 200 response of GET /api/tree has a body that doesn't fit its schema, at /children/0/value: expected string, got integer",
      ],
      [
        'pattern.json',
        "the 200 response of GET /api/pets/{petId} has a body that doesn't fit its schema, at /name: missing required property 'name'",
      ],
    ])
  })

  it('only warns about a generated stub from another version of the spec, and still checks it', () => {
    const dir = writeMappings({
      'old.json': stub(
        'getPet',
        { method: 'GET', urlPathTemplate: '/api/pets/{petId}' },
        { status: 200, jsonBody: { id: 1, name: 'a' } },
        { specHash: 'old' },
      ),
      'old-broken.json': stub(
        'getPet',
        { method: 'GET', urlPathTemplate: '/api/pets/{petId}' },
        { status: 200, jsonBody: { id: 1 } },
        { specHash: 'old' },
      ),
    })
    const { problems, warnings } = checkStubs(pets, dir)
    expect(warnings.map((w) => [w.key, w.message])).toEqual([
      [
        'old-broken.json',
        `was generated from another version of ${pets}: regenerate it with ctf stubs`,
      ],
      ['old.json', `was generated from another version of ${pets}: regenerate it with ctf stubs`],
    ])
    expect(problems.map((p) => p.key)).toEqual(['old-broken.json'])
  })

  it('reads a multi-mapping file, and reports a file that is not JSON', () => {
    const dir = writeMappings({
      'many.json': {
        mappings: [
          { request: { method: 'GET', url: '/api/tree' }, response: { status: 200 } },
          { request: { method: 'GET', url: '/api/nope' }, response: { status: 200 } },
        ],
      },
      'bad.json': '{',
    })
    const { problems } = checkStubs(pets, dir)
    expect(problems.map((p) => p.key)).toEqual(['bad.json', 'many.json'])
    expect(problems[0].message).toMatch(/^isn't valid JSON: /)
    expect(problems[1].message).toBe('GET /api/nope matches no operation in the spec')
  })

  it('does not check a fault, a proxy, or a body that goes through response templating', () => {
    const dir = writeMappings({
      // Each has a status the spec doesn't document, which would be a finding if it were checked.
      'fault.json': {
        request: { method: 'GET', url: '/api/tree' },
        response: { fault: 'RESET', status: 418 },
      },
      'proxy.json': {
        request: { method: 'GET', url: '/api/tree' },
        response: { proxyBaseUrl: 'http://x', status: 418 },
      },
      'template.json': {
        request: { method: 'GET', url: '/api/pets/1' },
        response: {
          status: 200,
          transformers: ['response-template'],
          jsonBody: { id: '{{randomInt}}', name: 'a' },
        },
      },
    })
    expect(checkStubs(pets, dir).problems).toEqual([])
    // Without the transformer, `{{` is just text, and the body is checked.
    const plain = writeMappings({
      'plain.json': {
        request: { method: 'GET', url: '/api/pets/1' },
        response: { status: 200, jsonBody: { id: '{{randomInt}}', name: 'a' } },
      },
    })
    expect(checkStubs(pets, plain).problems).toHaveLength(1)
  })

  it('takes a 2XX range as documenting the statuses it covers', () => {
    const dir = tmpDir()
    const spec = path.join(dir, 'range.yaml')
    fs.writeFileSync(
      spec,
      `openapi: 3.0.3
paths:
  /a:
    get:
      operationId: a
      responses:
        '2XX':
          description: ok
          content: { application/json: { schema: { type: object, required: [x] }, example: { x: 1 } } }
`,
    )
    const mappings = writeMappings({
      'ok.json': {
        request: { method: 'GET', url: '/a' },
        response: { status: 201, jsonBody: { x: 1 } },
      },
      'bad-body.json': {
        request: { method: 'GET', url: '/a' },
        response: { status: 201, jsonBody: {} },
      },
      'bad-status.json': {
        request: { method: 'GET', url: '/a' },
        response: { status: 500, jsonBody: {} },
      },
    })
    expect(checkStubs(spec, mappings).problems.map((p) => [p.key, p.message])).toEqual([
      [
        'bad-body.json',
        "the 201 response of GET /a has a body that doesn't fit its schema, at /x: missing required property 'x'",
      ],
      ['bad-status.json', "GET /a doesn't document a 500 response"],
    ])
    // With nothing more exact, the range is stubbed as a 200.
    const { mappings: made, skipped } = generateStubs(spec)
    expect(skipped).toEqual([])
    expect((made[0].mapping as { response: { status: number } }).response.status).toBe(200)
  })

  it('checks a pattern on `urlPattern` against the path and a query', () => {
    const dir = writeMappings({
      'query.json': {
        request: { method: 'GET', urlPattern: '/api/tree\\?a=1' },
        response: { status: 200, jsonBody: { value: 'a' } },
      },
      'bare.json': {
        request: { method: 'GET', urlPattern: '/api/tree' },
        response: { status: 200, jsonBody: { value: 1 } },
      },
      'any-query.json': {
        request: { method: 'GET', urlPattern: '/api/tree(\\?.*)?' },
        response: { status: 418 },
      },
    })
    expect(checkStubs(pets, dir).problems.map((p) => [p.key, p.message.slice(0, 40)])).toEqual([
      ['any-query.json', "GET /api/tree doesn't document a 418 res"],
      ['bare.json', 'the 200 response of GET /api/tree has a '],
    ])
  })

  it('takes a method of ANY, or none, when the operations share a path', () => {
    const dir = tmpDir()
    const spec = path.join(dir, 'any.yaml')
    fs.writeFileSync(
      spec,
      `openapi: 3.0.3
paths:
  /pets:
    get:
      operationId: list
      responses:
        '200':
          description: ok
          content: { application/json: { schema: { type: array }, example: [] } }
    post:
      operationId: create
      responses:
        '201':
          description: ok
          content: { application/json: { schema: { type: object }, example: {} } }
  /pets/{id}:
    get:
      operationId: one
      responses: { '200': { description: ok } }
  /pets/mine:
    post:
      operationId: mine
      responses: { '200': { description: ok } }
`,
    )
    const mappings = writeMappings({
      // A list is accepted by GET; a 201 object by POST.
      'list.json': { request: { url: '/pets' }, response: { status: 200, jsonBody: [] } },
      'created.json': {
        request: { method: 'ANY', url: '/pets' },
        response: { status: 201, jsonBody: {} },
      },
      'neither-status.json': { request: { url: '/pets' }, response: { status: 404 } },
      'neither-body.json': { request: { url: '/pets' }, response: { status: 200, jsonBody: {} } },
      // GET /pets/mine isn't an operation, but POST /pets/mine and GET /pets/{id} are: two paths.
      'split.json': { request: { url: '/pets/mine' }, response: { status: 200 } },
    })
    expect(checkStubs(spec, mappings).problems.map((p) => [p.key, p.message])).toEqual([
      [
        'neither-body.json',
        "the 200 response of GET /pets has a body that doesn't fit its schema, at (the body): expected array, got object",
      ],
      ['neither-status.json', "GET|POST /pets doesn't document a 404 response"],
      ['split.json', 'unresolved: ANY /pets/mine matches 2 operations at different paths'],
    ])
  })

  it('takes an allowlist by file name, and reports an entry that matches nothing as stale', () => {
    const dir = writeMappings({
      'gone.json': { request: { method: 'GET', url: '/api/nope' }, response: { status: 200 } },
      'status.json': {
        request: { method: 'DELETE', url: '/api/pets/1' },
        response: { status: 200 },
      },
    })
    const result = checkStubs(pets, dir, { allowlist: ['gone.json', 'fixed.json'] })
    expect(result.problems.map((p) => p.key)).toEqual(['status.json'])
    expect(result.allowlisted.map((p) => p.key)).toEqual(['gone.json'])
    expect(result.stale).toEqual(['fixed.json'])
  })

  it('throws when there is no mappings directory', () => {
    expect(() => checkStubs(pets, tmpDir())).toThrow(/mappings doesn't exist/)
  })
})

describe('ctf stubs', () => {
  function run(args: string[]): { code: number; out: string; err: string } {
    const [log, error] = [console.log, console.error]
    const out: string[] = []
    const err: string[] = []
    console.log = (...a: unknown[]) => void out.push(a.join(' '))
    console.error = (...a: unknown[]) => void err.push(a.join(' '))
    try {
      return { code: main(args), out: out.join('\n'), err: err.join('\n') }
    } finally {
      console.log = log
      console.error = error
    }
  }

  it('writes the mappings, refuses to overwrite them, and replaces them with --force', () => {
    const dir = tmpDir()
    const first = run(['stubs', pets, '--out', dir])
    expect(first.code).toBe(0)
    expect(first.out).toContain(path.join(dir, 'mappings', 'getPet.json'))
    expect(first.err).toContain('skipped listToys 200: no example')
    expect(fs.readdirSync(path.join(dir, 'mappings')).sort()).toEqual([
      'createPet.json',
      'deletePet.json',
      'getFlag.json',
      'getMine.json',
      'getNothing.json',
      'getPet.json',
      'getTree.json',
      'listPets.json',
    ])

    fs.writeFileSync(path.join(dir, 'mappings', 'getPet.json'), 'mine')
    const again = run(['stubs', pets, '--out', dir])
    expect(again.code).toBe(2)
    expect(again.err).toContain(path.join(dir, 'mappings', 'getPet.json'))
    expect(again.err).toContain('--force')
    expect(fs.readFileSync(path.join(dir, 'mappings', 'getPet.json'), 'utf-8')).toBe('mine')

    expect(run(['stubs', pets, '--out', dir, '--force']).code).toBe(0)
    expect(fs.readFileSync(path.join(dir, 'mappings', 'getPet.json'), 'utf-8')).toContain(
      '"getPet"',
    )
  })

  it('takes --all-statuses, --include and --exclude', () => {
    const dir = tmpDir()
    expect(
      run([
        'stubs',
        pets,
        '--out',
        dir,
        '--all-statuses',
        '--include',
        '^getP',
        '--exclude',
        'Tree',
      ]).code,
    ).toBe(0)
    expect(fs.readdirSync(path.join(dir, 'mappings')).sort()).toEqual([
      'getPet-404.json',
      'getPet.json',
    ])
  })

  it('--check exits 0 when the stubs agree, 1 on drift or a stale allowlist entry, 2 when it cannot run', () => {
    const dir = tmpDir()
    run(['stubs', pets, '--out', dir])
    expect(run(['stubs', '--check', pets, dir])).toMatchObject({
      code: 0,
      out: 'stubs and spec agree',
    })

    fs.writeFileSync(
      path.join(dir, 'mappings', 'extra.json'),
      JSON.stringify({ request: { method: 'GET', url: '/api/nope' }, response: { status: 200 } }),
    )
    const drift = run(['stubs', '--check', pets, dir])
    expect(drift.code).toBe(1)
    expect(drift.err).toContain('GET /api/nope matches no operation')
    expect(drift.err).toContain('1 problem(s)')

    const allow = path.join(tmpDir(), 'allow.txt')
    fs.writeFileSync(allow, 'extra.json # known\n')
    expect(run(['stubs', '--check', pets, dir, '--allowlist', allow])).toMatchObject({
      code: 0,
      out: 'stubs and spec agree (1 allowlisted)',
    })
    fs.writeFileSync(allow, 'extra.json\nold.json\n')
    const stale = run(['stubs', '--check', pets, dir, '--allowlist', allow])
    expect(stale.code).toBe(1)
    expect(stale.err).toContain("'old.json' no longer matches any problem; remove it")

    expect(run(['stubs', '--check', pets, path.join(dir, 'nowhere')]).code).toBe(2)
    expect(run(['stubs', '--check', pets]).code).toBe(2)
    expect(run(['stubs', pets]).code).toBe(2)
    expect(run(['stubs', pets, '--out', dir, '--allowlist', allow]).code).toBe(2)
  })

  it('--check --json prints the result, and warns without failing', () => {
    const dir = tmpDir()
    run(['stubs', pets, '--out', dir])
    const file = path.join(dir, 'mappings', 'getPet.json')
    const mapping = JSON.parse(fs.readFileSync(file, 'utf-8'))
    mapping.metadata.specHash = 'old'
    fs.writeFileSync(file, JSON.stringify(mapping))

    const plain = run(['stubs', '--check', pets, dir])
    expect(plain.code).toBe(0)
    expect(plain.err).toContain('warning: was generated from another version')

    const result = run(['stubs', '--check', pets, dir, '--json'])
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.out)
    expect(parsed.problems).toEqual([])
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0].key).toBe('getPet.json')
  })
})
