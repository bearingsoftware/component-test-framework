import {
  loadSpecDetail,
  type DetailedOperation,
  type Located,
  type LoadSpecOptions,
  type RefResolver,
} from './spec'

const BREAKING_RULES = [
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
] as const

export type Rule =
  | (typeof BREAKING_RULES)[number]
  | 'operation-added'
  | 'response-status-added'
  | 'optional-param-added'
  | 'response-property-added'
  | 'request-enum-added'
  | 'description-changed'

/** One difference. `location` is a JSON pointer into the spec, through the operation and not through `$ref`s. */
export interface Finding {
  rule: Rule
  operation: string
  location: string
  detail: string
}

export interface DiffResult {
  breaking: Finding[]
  nonBreaking: Finding[]
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const esc = (segment: string) => segment.replace(/~/g, '~0').replace(/\//g, '~1')
const normalise = (path: string) => path.replace(/\{[^}]*\}/g, '{}')
const display = (op: DetailedOperation) => `${op.method} ${op.path}`
const operationKey = (op: DetailedOperation) => `${op.method} ${normalise(op.path)}`
const pointerOf = (op: DetailedOperation) => `/paths/${esc(op.route)}/${op.method.toLowerCase()}`
const isSuccess = (status: string) => /^2\d\d$/.test(status) || status === '2XX'

interface Side {
  op: DetailedOperation
  resolve: RefResolver
}

interface Ctx {
  operation: string
  base: RefResolver
  head: RefResolver
  out: DiffResult
  inProgress: Set<string>
}

function record(out: DiffResult, finding: Finding) {
  if ((BREAKING_RULES as readonly string[]).includes(finding.rule)) out.breaking.push(finding)
  else out.nonBreaking.push(finding)
}

function emit(ctx: Ctx, rule: Rule, location: string, detail: string) {
  record(ctx.out, { rule, operation: ctx.operation, location, detail })
}

function deref(loc: Located, resolve: RefResolver): Located {
  return typeof loc.value.$ref === 'string' ? resolve(loc.value.$ref, loc) : loc
}

// The type sets are compared as sets of JSON types; `undefined` is any type.
function covers(types: Set<string>, type: string): boolean {
  return types.has(type) || (type === 'integer' && types.has('number'))
}

function allows(from: Set<string> | undefined, to: Set<string> | undefined): boolean {
  if (!to) return true
  if (!from) return false
  return [...from].every((type) => covers(to, type))
}

function describe(types: Set<string> | undefined): string {
  return types ? [...types].join('|') : 'any'
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  return new Set([...a, ...b].filter((type) => covers(a, type) && covers(b, type)))
}

interface Shape {
  types?: Set<string>
  enum?: string[]
  required: Set<string>
  properties: Map<string, Located>
  items?: Located
}

function typesOf(schema: Json): Set<string> | undefined {
  let types: Set<string> | undefined
  if (typeof schema.type === 'string') types = new Set([schema.type])
  else if (Array.isArray(schema.type)) types = new Set(schema.type.map(String))
  if (types && schema.nullable === true) types.add('null')
  return types
}

function mergeInto(into: Shape, part: Shape) {
  if (part.types) into.types = into.types ? intersect(into.types, part.types) : part.types
  const values = part.enum
  if (values) into.enum = into.enum ? into.enum.filter((v) => values.includes(v)) : values
  for (const name of part.required) into.required.add(name)
  for (const [name, prop] of part.properties) {
    if (!into.properties.has(name)) into.properties.set(name, prop)
  }
  if (!into.items) into.items = part.items
}

// What a schema allows, with its allOf parts merged and oneOf/anyOf reduced to their branch types.
// Formats, patterns and numeric or length limits are not part of the shape.
function shapeOf(
  loc: Located | undefined,
  resolve: RefResolver,
  inProgress = new Set<Json>(),
): Shape {
  const shape: Shape = { required: new Set(), properties: new Map() }
  if (!loc) return shape
  const at = deref(loc, resolve)
  const schema = at.value
  if (!isObject(schema) || inProgress.has(schema)) return shape
  inProgress.add(schema)

  shape.types = typesOf(schema)
  if (Array.isArray(schema.enum)) shape.enum = schema.enum.map((v) => JSON.stringify(v))
  else if ('const' in schema) shape.enum = [JSON.stringify(schema.const)]
  if (isObject(schema.properties)) {
    for (const [name, prop] of Object.entries(schema.properties)) {
      if (isObject(prop)) shape.properties.set(name, { value: prop, file: at.file, root: at.root })
    }
  }
  if (Array.isArray(schema.required))
    for (const name of schema.required) shape.required.add(String(name))
  if (isObject(schema.items)) shape.items = { value: schema.items, file: at.file, root: at.root }

  const parts = Array.isArray(schema.allOf) ? schema.allOf : []
  for (const part of parts.filter(isObject)) {
    mergeInto(shape, shapeOf({ value: part, file: at.file, root: at.root }, resolve, inProgress))
  }

  const branches = [
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
  ].filter(isObject)
  if (!shape.types && branches.length > 0) {
    const sets = branches.map(
      (branch) =>
        shapeOf({ value: branch, file: at.file, root: at.root }, resolve, inProgress).types,
    )
    shape.types = sets.some((s) => !s)
      ? undefined
      : new Set(sets.flatMap((s) => [...(s as Set<string>)]))
  }
  if (!shape.types) {
    if (shape.properties.size > 0) shape.types = new Set(['object'])
    else if (shape.items) shape.types = new Set(['array'])
  }

  inProgress.delete(schema)
  return shape
}

const ids = new WeakMap<object, number>()
let nextId = 0
function idOf(value: object): number {
  let id = ids.get(value)
  if (id === undefined) {
    id = nextId++
    ids.set(value, id)
  }
  return id
}

// `dir` is the side the schema describes: a request is accepted, a response is produced.
function compare(
  ctx: Ctx,
  dir: 'request' | 'response',
  base: Located | undefined,
  head: Located | undefined,
  at: string,
): void {
  if (!base && !head) return
  const b = base && deref(base, ctx.base)
  const h = head && deref(head, ctx.head)
  // Keyed by the schema objects, so a recursive $ref stops at the pair it came back to.
  const key = b && h ? `${idOf(b.value)}>${idOf(h.value)}` : undefined
  if (key && ctx.inProgress.has(key)) return
  if (key) ctx.inProgress.add(key)

  const bs = shapeOf(b, ctx.base)
  const hs = shapeOf(h, ctx.head)

  const [from, to] = dir === 'request' ? [bs.types, hs.types] : [hs.types, bs.types]
  if (!allows(from, to)) {
    emit(
      ctx,
      dir === 'request' ? 'request-property-type-changed' : 'response-property-type-changed',
      at,
      `type ${describe(bs.types)} changed to ${describe(hs.types)}`,
    )
  }

  const bEnum = bs.enum
  const hEnum = hs.enum
  if (dir === 'request') {
    if (bEnum && hEnum) {
      const removed = bEnum.filter((v) => !hEnum.includes(v))
      if (removed.length > 0) {
        emit(ctx, 'request-property-type-changed', at, `enum values removed: ${removed.join(', ')}`)
      }
      const added = hEnum.filter((v) => !bEnum.includes(v))
      if (added.length > 0)
        emit(ctx, 'request-enum-added', at, `enum values added: ${added.join(', ')}`)
    } else if (!bEnum && hEnum) {
      emit(ctx, 'request-property-type-changed', at, 'now limited to an enum')
    }
  } else if (bEnum) {
    if (!hEnum) {
      emit(ctx, 'response-enum-added', at, 'no longer limited to an enum')
    } else {
      const added = hEnum.filter((v) => !bEnum.includes(v))
      if (added.length > 0)
        emit(ctx, 'response-enum-added', at, `enum values added: ${added.join(', ')}`)
    }
  }

  const names = new Set([...bs.properties.keys(), ...hs.properties.keys()])
  for (const name of names) {
    const bp = bs.properties.get(name)
    const hp = hs.properties.get(name)
    const child = `${at}/properties/${esc(name)}`
    if (bp && hp) {
      if (dir === 'request' && !bs.required.has(name) && hs.required.has(name)) {
        emit(ctx, 'request-body-required-added', child, `${name} is now required`)
      }
      if (dir === 'response' && bs.required.has(name) && !hs.required.has(name)) {
        emit(ctx, 'response-property-removed', child, `${name} is no longer required`)
      }
      compare(ctx, dir, bp, hp, child)
    } else if (bp) {
      if (dir === 'request')
        emit(ctx, 'request-property-type-changed', child, `${name} was removed`)
      else emit(ctx, 'response-property-removed', child, `${name} was removed`)
    } else if (hp) {
      if (dir === 'request') {
        if (hs.required.has(name))
          emit(ctx, 'request-body-required-added', child, `${name} was added as required`)
      } else {
        emit(ctx, 'response-property-added', child, `${name} was added`)
      }
    }
  }

  if (bs.items || hs.items) compare(ctx, dir, bs.items, hs.items, `${at}/items`)

  if (key) ctx.inProgress.delete(key)
}

interface Param {
  name: string
  required: boolean
  schema: Located
}

// Shared path-level parameters first, then the operation's own, which win for the same key.
function parametersOf(side: Side): Located[] {
  const { source, pathItem } = side.op
  const of = (list: unknown, loc: Located) =>
    (Array.isArray(list) ? list : [])
      .filter(isObject)
      .map((value) => ({ value, file: loc.file, root: loc.root }))
  return [...of(pathItem.value.parameters, pathItem), ...of(source.value.parameters, source)].map(
    (p) => deref(p, side.resolve),
  )
}

// A path parameter is keyed by its position in the path, so `{id}` and `{petId}` match.
function paramsByKey(side: Side): Map<string, Param> {
  const placeholders = [...side.op.route.matchAll(/\{([^}]*)\}/g)].map((m) => m[1])
  const params = new Map<string, Param>()
  for (const loc of parametersOf(side)) {
    const p = loc.value
    if (typeof p.name !== 'string' || typeof p.in !== 'string' || p.in === 'body') continue
    const key =
      p.in === 'path'
        ? `path:${placeholders.indexOf(p.name)}`
        : p.in === 'header'
          ? `header:${p.name.toLowerCase()}`
          : `${p.in}:${p.name}`
    const schema = isObject(p.schema) ? { value: p.schema, file: loc.file, root: loc.root } : loc
    params.set(key, { name: p.name, required: p.in === 'path' || p.required === true, schema })
  }
  return params
}

function compareParams(ctx: Ctx, base: Side, head: Side, bAt: string, hAt: string) {
  const bp = paramsByKey(base)
  const hp = paramsByKey(head)
  for (const [key, b] of bp) {
    const h = hp.get(key)
    if (!h) {
      emit(
        ctx,
        'request-param-removed',
        `${bAt}/parameters/${esc(b.name)}`,
        `${b.name} was removed`,
      )
      continue
    }
    const at = `${hAt}/parameters/${esc(h.name)}`
    if (!b.required && h.required)
      emit(ctx, 'request-param-added-required', at, `${h.name} is now required`)
    compare(ctx, 'request', b.schema, h.schema, at)
  }
  for (const [key, h] of hp) {
    if (bp.has(key)) continue
    const at = `${hAt}/parameters/${esc(h.name)}`
    if (h.required) emit(ctx, 'request-param-added-required', at, `${h.name} was added as required`)
    else emit(ctx, 'optional-param-added', at, `${h.name} was added`)
  }
}

interface Body {
  required: boolean
  content: Map<string, Located | undefined>
}

// The media types of a body or response, each with its schema. A Swagger 2 response's schema is
// filed under application/json, as spec.ts does.
function contentOf(loc: Located): Map<string, Located | undefined> {
  const content = new Map<string, Located | undefined>()
  const { value, file, root } = loc
  if (isObject(value.content)) {
    for (const [mediaType, media] of Object.entries(value.content)) {
      const schema = isObject(media) && isObject(media.schema) ? media.schema : undefined
      content.set(mediaType, schema && { value: schema, file, root })
    }
  } else if (isObject(value.schema)) {
    content.set('application/json', { value: value.schema, file, root })
  }
  return content
}

function bodyOf(side: Side): Body | undefined {
  const { source } = side.op
  const requestBody = source.value.requestBody
  if (isObject(requestBody)) {
    const body = deref({ value: requestBody, file: source.file, root: source.root }, side.resolve)
    return { required: body.value.required === true, content: contentOf(body) }
  }
  const param = parametersOf(side).find((p) => p.value.in === 'body')
  if (!param) return undefined
  const schema = isObject(param.value.schema) ? param.value.schema : undefined
  return {
    required: param.value.required === true,
    content: new Map([['', schema && { value: schema, file: param.file, root: param.root }]]),
  }
}

function compareBody(ctx: Ctx, base: Side, head: Side, bAt: string, hAt: string) {
  const b = bodyOf(base)
  const h = bodyOf(head)
  if (!b) {
    if (h?.required)
      emit(ctx, 'request-body-required-added', `${hAt}/requestBody`, 'request body is now required')
    return
  }
  if (!h) {
    emit(ctx, 'request-property-type-changed', `${bAt}/requestBody`, 'request body was removed')
    return
  }
  if (!b.required && h.required) {
    emit(ctx, 'request-body-required-added', `${hAt}/requestBody`, 'request body is now required')
  }
  for (const [mediaType, schema] of b.content) {
    if (!h.content.has(mediaType)) {
      emit(
        ctx,
        'media-type-removed',
        `${bAt}/requestBody/content/${esc(mediaType)}`,
        `${mediaType} request body was removed`,
      )
      continue
    }
    compare(
      ctx,
      'request',
      schema,
      h.content.get(mediaType),
      `${hAt}/requestBody/content/${esc(mediaType)}/schema`,
    )
  }
}

function responsesOf(side: Side): Map<string, Map<string, Located | undefined>> {
  const out = new Map<string, Map<string, Located | undefined>>()
  const { source } = side.op
  const responses = source.value.responses
  if (!isObject(responses)) return out
  for (const [status, raw] of Object.entries(responses)) {
    const response = isObject(raw)
      ? deref({ value: raw, file: source.file, root: source.root }, side.resolve)
      : undefined
    out.set(status, response ? contentOf(response) : new Map())
  }
  return out
}

function compareResponses(ctx: Ctx, base: Side, head: Side, bAt: string, hAt: string) {
  const bResponses = responsesOf(base)
  const hResponses = responsesOf(head)
  for (const [status, bContent] of bResponses) {
    if (!isSuccess(status)) continue
    const matched = hResponses.has(status)
      ? status
      : status !== '2XX' && hResponses.has('2XX')
        ? '2XX'
        : undefined
    if (matched === undefined) {
      if (!hResponses.has('default')) {
        emit(ctx, 'response-status-removed', `${bAt}/responses/${status}`, `${status} was removed`)
      }
      continue
    }
    const hContent = hResponses.get(matched) ?? new Map<string, Located | undefined>()
    for (const [mediaType, schema] of bContent) {
      if (!hContent.has(mediaType)) {
        emit(
          ctx,
          'media-type-removed',
          `${bAt}/responses/${status}/content/${esc(mediaType)}`,
          `${mediaType} response was removed from ${status}`,
        )
        continue
      }
      compare(
        ctx,
        'response',
        schema,
        hContent.get(mediaType),
        `${hAt}/responses/${matched}/content/${esc(mediaType)}/schema`,
      )
    }
  }
  for (const status of hResponses.keys()) {
    if (!bResponses.has(status)) {
      emit(
        ctx,
        'response-status-added',
        `${hAt}/responses/${status}`,
        `${status} is now documented`,
      )
    }
  }
}

function compareOperation(base: Side, head: Side, out: DiffResult) {
  const ctx: Ctx = {
    operation: display(head.op),
    base: base.resolve,
    head: head.resolve,
    out,
    inProgress: new Set(),
  }
  const bAt = pointerOf(base.op)
  const hAt = pointerOf(head.op)
  const bSource = base.op.source.value
  const hSource = head.op.source.value
  if (bSource.summary !== hSource.summary || bSource.description !== hSource.description) {
    emit(ctx, 'description-changed', hAt, 'summary or description changed')
  }
  compareParams(ctx, base, head, bAt, hAt)
  compareBody(ctx, base, head, bAt, hAt)
  compareResponses(ctx, base, head, bAt, hAt)
}

/**
 * Compare two OpenAPI specs from a client's point of view: a change is breaking when
 * an existing client could fail. Operations are matched by method and path, with
 * path parameter names ignored. Formats, patterns and numeric or length limits are
 * not compared.
 */
export function diffSpecs(
  baseFile: string,
  headFile: string,
  options: LoadSpecOptions = {},
): DiffResult {
  const base = loadSpecDetail(baseFile, options)
  const head = loadSpecDetail(headFile, options)
  const out: DiffResult = { breaking: [], nonBreaking: [] }

  const headByKey = new Map<string, Side>(
    head.operations.map((op) => [operationKey(op), { op, resolve: head.resolve }]),
  )
  const baseKeys = new Set(base.operations.map(operationKey))
  for (const op of base.operations) {
    const h = headByKey.get(operationKey(op))
    if (h) {
      compareOperation({ op, resolve: base.resolve }, h, out)
    } else {
      record(out, {
        rule: 'operation-removed',
        operation: display(op),
        location: pointerOf(op),
        detail: `${display(op)} was removed`,
      })
    }
  }
  for (const op of head.operations) {
    if (baseKeys.has(operationKey(op))) continue
    record(out, {
      rule: 'operation-added',
      operation: display(op),
      location: pointerOf(op),
      detail: `${display(op)} was added`,
    })
  }
  return out
}

/**
 * Suppress the breaking findings that the allowlist names. Each line is `METHOD /path`
 * or `METHOD /path <rule>`. A line that matches no breaking finding is stale.
 */
export function applyAllowlist(
  breaking: Finding[],
  lines: string[],
): { breaking: Finding[]; allowlisted: number; stale: string[] } {
  const entries = lines.map((line) => {
    const parts = line.split(/\s+/)
    if (parts.length < 2 || parts.length > 3) {
      throw new Error(`allowlist entry '${line}' is not "METHOD /path" or "METHOD /path <rule>"`)
    }
    const [method, path, rule] = parts
    return { line, key: `${method.toUpperCase()} ${normalise(path)}`, rule }
  })
  const used = new Set<number>()
  const remaining: Finding[] = []
  let allowlisted = 0
  for (const finding of breaking) {
    const i = entries.findIndex(
      (e) =>
        e.key === normalise(finding.operation) && (e.rule === undefined || e.rule === finding.rule),
    )
    if (i < 0) {
      remaining.push(finding)
    } else {
      used.add(i)
      allowlisted++
    }
  }
  const stale = entries.filter((_, i) => !used.has(i)).map((e) => e.line)
  return { breaking: remaining, allowlisted, stale }
}
