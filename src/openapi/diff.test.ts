import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { applyAllowlist, diffSpecs, type Finding } from './diff'
import { main } from '../cli'

const fixtures = path.join(__dirname, '__fixtures__', 'api-diff')
const fixture = (name: string, side: 'base' | 'head') => path.join(fixtures, name, `${side}.yaml`)

const BREAKING_FIXTURES = [
  'operation-removed',
  'response-status-removed',
  'request-param-added-required',
  'request-param-removed',
  'request-body-required-added',
  'request-property-type-changed',
  'response-property-removed',
  'response-property-type-changed',
  'response-enum-added',
  'media-type-removed',
]
const NON_BREAKING_FIXTURES = [
  'operation-added',
  'response-status-added',
  'optional-param-added',
  'response-property-added',
  'request-enum-added',
  'description-changed',
]

const HEADER = "openapi: 3.0.3\ninfo: { title: T, version: '1' }\n"

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-api-diff-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  return file
}

// `paths` is the body of a `paths:` block at two-space indent; `components` is optional.
function spec(paths: string, components = ''): string {
  return `${HEADER}paths:\n${paths}${components ? `components:\n${components}` : ''}`
}

function diffYaml(base: string, head: string) {
  return diffSpecs(tmpFile('base.yaml', base), tmpFile('head.yaml', head))
}

const ruleNames = (findings: Finding[]) => findings.map((f) => f.rule)

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

describe('diffSpecs on the rule fixtures', () => {
  it.each(BREAKING_FIXTURES)('%s is breaking and nothing else', (name) => {
    const diff = diffSpecs(fixture(name, 'base'), fixture(name, 'head'))
    expect(ruleNames(diff.breaking)).toEqual([name])
    expect(diff.nonBreaking).toEqual([])
  })

  it.each(NON_BREAKING_FIXTURES)('%s is non-breaking and nothing else', (name) => {
    const diff = diffSpecs(fixture(name, 'base'), fixture(name, 'head'))
    expect(ruleNames(diff.nonBreaking)).toEqual([name])
    expect(diff.breaking).toEqual([])
  })

  it('reports nothing for identical specs', () => {
    expect(diffSpecs(fixture('no-change', 'base'), fixture('no-change', 'head'))).toEqual({
      breaking: [],
      nonBreaking: [],
    })
  })

  it('stops at a recursive $ref and reports a property removed inside it once', () => {
    const diff = diffSpecs(fixture('recursive', 'base'), fixture('recursive', 'head'))
    expect(diff.breaking).toEqual([
      {
        rule: 'response-property-removed',
        operation: 'GET /trees/{id}',
        location:
          '/paths/~1trees~1{id}/get/responses/200/content/application~1json/schema/properties/label',
        detail: 'label was removed',
      },
    ])
    expect(diff.nonBreaking).toEqual([])
  })
})

const getPets = (responses: string, extra = '') =>
  `  /pets:\n    get:\n${extra}      responses:\n${responses}`
const GET_PETS = (responses: string, extra = '') => spec(getPets(responses, extra))
const OK_200 = "        '200': { description: ok }\n"

describe('diffSpecs direction and type rules', () => {
  const body = (schema: string, required = false) =>
    spec(
      `  /pets:\n    post:\n      requestBody:\n${required ? '        required: true\n' : ''}        content:\n          application/json:\n            schema:\n${schema}      responses:\n        '201': { description: created }\n`,
    )
  const response = (schema: string) =>
    GET_PETS(
      `        '200':\n          description: ok\n          content:\n            application/json:\n              schema:\n${schema}`,
    )

  it.each([
    [
      'request integer widened to number',
      body('              type: integer\n'),
      body('              type: number\n'),
      [],
    ],
    [
      'request number narrowed to integer',
      body('              type: number\n'),
      body('              type: integer\n'),
      ['request-property-type-changed'],
    ],
    [
      'request nullable added',
      body('              type: string\n'),
      body('              type: string\n              nullable: true\n'),
      [],
    ],
    [
      'response integer widened to number',
      response('                type: integer\n'),
      response('                type: number\n'),
      ['response-property-type-changed'],
    ],
    [
      'response number narrowed to integer',
      response('                type: number\n'),
      response('                type: integer\n'),
      [],
    ],
    [
      'response nullable added',
      response('                type: string\n'),
      response('                type: string\n                nullable: true\n'),
      ['response-property-type-changed'],
    ],
    [
      'response oneOf branch removed',
      response('                oneOf: [{ type: string }, { type: integer }]\n'),
      response('                oneOf: [{ type: string }]\n'),
      [],
    ],
    [
      'response oneOf branch added',
      response('                oneOf: [{ type: string }]\n'),
      response('                oneOf: [{ type: string }, { type: boolean }]\n'),
      ['response-property-type-changed'],
    ],
    [
      'request oneOf branch removed',
      body('              oneOf: [{ type: string }, { type: integer }]\n'),
      body('              oneOf: [{ type: string }]\n'),
      ['request-property-type-changed'],
    ],
    [
      'request oneOf branch added',
      body('              oneOf: [{ type: string }]\n'),
      body('              oneOf: [{ type: string }, { type: boolean }]\n'),
      [],
    ],
  ])('%s', (_name, base, head, expected) => {
    expect(ruleNames(diffYaml(base, head).breaking)).toEqual(expected)
  })

  it.each([
    [
      'request enum value removed',
      body('              enum: [a, b]\n'),
      body('              enum: [a]\n'),
      ['request-property-type-changed'],
    ],
    [
      'request enum restricted from unconstrained',
      body('              type: string\n'),
      body('              type: string\n              enum: [a]\n'),
      ['request-property-type-changed'],
    ],
    [
      'request enum value added',
      body('              enum: [a]\n'),
      body('              enum: [a, b]\n'),
      [],
    ],
    [
      'response enum value removed',
      response('                enum: [a, b]\n'),
      response('                enum: [a]\n'),
      [],
    ],
    [
      'response enum no longer limited',
      response('                enum: [a]\n'),
      response('                type: string\n'),
      ['response-enum-added'],
    ],
  ])('%s', (_name, base, head, expected) => {
    expect(ruleNames(diffYaml(base, head).breaking)).toEqual(expected)
  })

  it('merges allOf parts, so a property from a part can be removed', () => {
    const components = `  schemas:\n    Base:\n      type: object\n      required: [id]\n      properties:\n        id: { type: string }\n`
    const withExtra = (extra: boolean) =>
      spec(
        getPets(
          `        '200':\n          description: ok\n          content:\n            application/json:\n              schema:\n                allOf:\n                  - $ref: '#/components/schemas/Base'\n                  - type: object\n                    properties:\n${extra ? '                      extra: { type: string }\n' : '                      other: { type: string }\n'}`,
        ),
        components,
      )
    expect(ruleNames(diffYaml(withExtra(true), withExtra(false)).breaking)).toEqual([
      'response-property-removed',
    ])
  })

  it('makes a required response property optional as a removal', () => {
    const schema = (required: string) =>
      response(
        `                type: object\n${required}                properties:\n                  id: { type: string }\n`,
      )
    expect(
      ruleNames(diffYaml(schema('                required: [id]\n'), schema('')).breaking),
    ).toEqual(['response-property-removed'])
    expect(
      ruleNames(diffYaml(schema(''), schema('                required: [id]\n')).breaking),
    ).toEqual([])
  })

  it('treats an optional request property made required as a required property added', () => {
    const schema = (required: string) =>
      body(
        `              type: object\n${required}              properties:\n                name: { type: string }\n`,
      )
    expect(
      ruleNames(diffYaml(schema(''), schema('              required: [name]\n')).breaking),
    ).toEqual(['request-body-required-added'])
    expect(
      ruleNames(diffYaml(schema('              required: [name]\n'), schema('')).breaking),
    ).toEqual([])
  })

  it('reports a request body that becomes required, and one that is newly optional as nothing', () => {
    const none = spec(
      "  /pets:\n    post:\n      responses:\n        '201': { description: created }\n",
    )
    expect(ruleNames(diffYaml(none, body('              type: object\n', true)).breaking)).toEqual([
      'request-body-required-added',
    ])
    expect(diffYaml(none, body('              type: object\n')).breaking).toEqual([])
    expect(
      diffYaml(body('              type: object\n', true), body('              type: object\n'))
        .breaking,
    ).toEqual([])
  })

  it('reports a request body that is removed', () => {
    const none = spec(
      "  /pets:\n    post:\n      responses:\n        '201': { description: created }\n",
    )
    expect(ruleNames(diffYaml(body('              type: object\n'), none).breaking)).toEqual([
      'request-property-type-changed',
    ])
  })
})

describe('diffSpecs parameter and path rules', () => {
  const pathParam = (name: string, extra = '') =>
    spec(
      `  /pets/{${name}}:\n    get:\n      parameters:\n        - { name: ${name}, in: path, required: true, schema: { type: string } }\n${extra}      responses:\n${OK_200}`,
    )

  it('matches path parameters by position, so a renamed one is the same operation', () => {
    expect(diffYaml(pathParam('id'), pathParam('petId'))).toEqual({ breaking: [], nonBreaking: [] })
  })

  it('does not match an operation whose path has a different fixed segment', () => {
    const other = spec(`  /dogs/{id}:\n    get:\n      responses:\n${OK_200}`)
    expect(ruleNames(diffYaml(pathParam('id'), other).breaking)).toEqual(['operation-removed'])
  })

  it('treats a header name as case-insensitive', () => {
    const header = (name: string) =>
      GET_PETS(
        OK_200,
        `      parameters:\n        - { name: ${name}, in: header, required: true, schema: { type: string } }\n`,
      )
    expect(diffYaml(header('X-Tenant'), header('x-tenant'))).toEqual({
      breaking: [],
      nonBreaking: [],
    })
  })

  it('reports an optional parameter that is made required, and a new required one', () => {
    const optional = GET_PETS(
      OK_200,
      '      parameters:\n        - { name: limit, in: query, schema: { type: integer } }\n',
    )
    const required = GET_PETS(
      OK_200,
      '      parameters:\n        - { name: limit, in: query, required: true, schema: { type: integer } }\n',
    )
    expect(ruleNames(diffYaml(optional, required).breaking)).toEqual([
      'request-param-added-required',
    ])
    expect(ruleNames(diffYaml(required, optional).breaking)).toEqual([])
    expect(ruleNames(diffYaml(GET_PETS(OK_200), required).breaking)).toEqual([
      'request-param-added-required',
    ])
  })

  it('reads a parameter shared by the path item, and an operation parameter overrides it', () => {
    const shared = spec(
      `  /pets:\n    parameters:\n      - { name: limit, in: query, required: true, schema: { type: integer } }\n    get:\n      responses:\n${OK_200}`,
    )
    const overridden = spec(
      `  /pets:\n    parameters:\n      - { name: limit, in: query, required: true, schema: { type: integer } }\n    get:\n      parameters:\n        - { name: limit, in: query, schema: { type: integer } }\n      responses:\n${OK_200}`,
    )
    expect(diffYaml(shared, shared).breaking).toEqual([])
    expect(diffYaml(shared, overridden).breaking).toEqual([])
  })

  it('reports a documented 2xx status covered by default or 2XX, and not one with neither', () => {
    const withStatus = (status: string) => GET_PETS(`        '${status}': { description: ok }\n`)
    expect(ruleNames(diffYaml(withStatus('200'), withStatus('default')).breaking)).toEqual([])
    expect(ruleNames(diffYaml(withStatus('200'), withStatus('2XX')).breaking)).toEqual([])
    expect(ruleNames(diffYaml(withStatus('2XX'), withStatus('200')).breaking)).toEqual([
      'response-status-removed',
    ])
  })

  it('reports a removed response media type, and a removed body media type', () => {
    const json = (type: string) =>
      GET_PETS(
        `        '200':\n          description: ok\n          content:\n            ${type}:\n              schema: { type: string }\n`,
      )
    expect(ruleNames(diffYaml(json('application/json'), json('text/plain')).breaking)).toEqual([
      'media-type-removed',
    ])
  })
})

describe('applyAllowlist', () => {
  const finding = (rule: Finding['rule'], operation = 'GET /pets/{petId}'): Finding => ({
    rule,
    operation,
    location: '/paths/~1pets~1{petId}/get',
    detail: '',
  })

  it('suppresses a finding by method and path, with or without a rule, and matches normalised params', () => {
    const breaking = [finding('response-enum-added'), finding('media-type-removed')]
    expect(applyAllowlist(breaking, ['GET /pets/{id} response-enum-added'])).toEqual({
      breaking: [finding('media-type-removed')],
      allowlisted: 1,
      stale: [],
    })
    expect(applyAllowlist(breaking, ['get /pets/{id}']).breaking).toEqual([])
  })

  it('reports an entry that matches no breaking finding as stale', () => {
    const result = applyAllowlist(
      [finding('media-type-removed')],
      ['GET /pets/{id} response-enum-added', 'GET /dogs/{id}'],
    )
    expect(result.stale).toEqual(['GET /pets/{id} response-enum-added', 'GET /dogs/{id}'])
    expect(result.breaking).toHaveLength(1)
  })

  it('rejects an entry that is not a method and a path, with an optional rule', () => {
    expect(() => applyAllowlist([], ['GET'])).toThrow('is not "METHOD /path"')
    expect(() => applyAllowlist([], ['GET /x a b'])).toThrow('is not "METHOD /path"')
  })
})

describe('ctf api-diff', () => {
  it('exits 0 with flag false when nothing changed', () => {
    const flag = tmpFile('flag', '')
    expect(
      quiet(() =>
        main([
          'api-diff',
          fixture('no-change', 'base'),
          fixture('no-change', 'head'),
          '--out-flag',
          flag,
        ]),
      ),
    ).toBe(0)
    expect(fs.readFileSync(flag, 'utf-8')).toBe('false')
  })

  it('exits 1 with flag true when a breaking change is found', () => {
    const flag = tmpFile('flag', '')
    expect(
      quiet(() =>
        main([
          'api-diff',
          fixture('operation-removed', 'base'),
          fixture('operation-removed', 'head'),
          '--out-flag',
          flag,
        ]),
      ),
    ).toBe(1)
    expect(fs.readFileSync(flag, 'utf-8')).toBe('true')
  })

  it('exits 2 and writes no flag when a spec cannot be read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-api-diff-'))
    const flag = path.join(dir, 'flag')
    expect(
      quiet(() =>
        main(['api-diff', fixture('no-change', 'base'), '/no/such/head.yaml', '--out-flag', flag]),
      ),
    ).toBe(2)
    expect(fs.existsSync(flag)).toBe(false)
  })

  it('exits 1 for a stale allowlist entry, and 0 once a breaking change is allowlisted', () => {
    const base = fixture('response-enum-added', 'base')
    const head = fixture('response-enum-added', 'head')
    const flag = tmpFile('flag', '')
    const allow = tmpFile('allow.txt', 'GET /pets/{id} response-enum-added\n')
    expect(
      quiet(() => main(['api-diff', base, head, '--allowlist', allow, '--out-flag', flag])),
    ).toBe(0)
    expect(fs.readFileSync(flag, 'utf-8')).toBe('false')

    const stale = tmpFile('stale.txt', 'GET /pets/{id} media-type-removed\n')
    expect(
      quiet(() => main(['api-diff', base, head, '--allowlist', stale, '--out-flag', flag])),
    ).toBe(1)
    expect(fs.readFileSync(flag, 'utf-8')).toBe('true')
  })

  it('prints the JSON shape', () => {
    const lines: string[] = []
    const log = console.log
    console.log = (line: string) => lines.push(line)
    try {
      expect(
        main([
          'api-diff',
          fixture('response-enum-added', 'base'),
          fixture('response-enum-added', 'head'),
          '--json',
        ]),
      ).toBe(1)
    } finally {
      console.log = log
    }
    const parsed = JSON.parse(lines.join('\n'))
    expect(Object.keys(parsed)).toEqual(['version', 'breaking', 'nonBreaking'])
    expect(parsed.version).toBe(1)
    expect(parsed.breaking).toEqual([
      expect.objectContaining({ rule: 'response-enum-added', operation: 'GET /pets/{id}' }),
    ])
    expect(Object.keys(parsed.breaking[0]).sort()).toEqual([
      'detail',
      'location',
      'operation',
      'rule',
    ])
  })

  it('needs exactly two specs', () => {
    expect(quiet(() => main(['api-diff', fixture('no-change', 'base')]))).toBe(2)
  })
})
