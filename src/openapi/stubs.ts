import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { findOperation, loadSpecDetail, type DetailedOperation, type SpecResponse } from './spec'
import { namedOperations } from './generate'
import { validateSchema } from './schema'
import type { Problem } from './check'

const GENERATED_BY = 'ctf stubs'
const LOWER_PRIORITY = 10
const METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE']

/** Options for {@link generateStubs}. */
export interface GenerateStubsOptions {
  /** See {@link LoadSpecOptions.basePath}. */
  basePath?: string
  /** Keep only operations whose name matches. */
  include?: RegExp
  /** Leave out operations whose name matches. */
  exclude?: RegExp
  /** A stub for every documented status, not just the lowest 2xx. */
  allStatuses?: boolean
}

/** What {@link generateStubs} made, and what it left out. */
export interface GeneratedStubs {
  /** `file` is relative to the output directory: `mappings/<name>.json`. */
  mappings: { file: string; mapping: object }[]
  skipped: { operation: string; reason: string }[]
  /** Examples that don't fit their own schema. The stub is written all the same. */
  warnings: { operation: string; reason: string }[]
}

function specHashOf(specFile: string): string {
  return createHash('sha256').update(fs.readFileSync(specFile)).digest('hex')
}

function isJson(mediaType: string): boolean {
  return mediaType === 'application/json' || /\+json$/.test(mediaType)
}

/**
 * WireMock mappings for a spec's operations, from the examples it gives:
 * each response's own example, else the first of its named examples, else
 * its schema's example. An operation without one is skipped, as no data is
 * made up.
 */
export function generateStubs(
  specFile: string,
  options: GenerateStubsOptions = {},
): GeneratedStubs {
  const { operations, resolve } = loadSpecDetail(specFile, { basePath: options.basePath })
  const specHash = specHashOf(specFile)
  const result: GeneratedStubs = { mappings: [], skipped: [], warnings: [] }
  const fileOwners = new Map<string, string>()

  for (const op of namedOperations(operations)) {
    if (options.include && !options.include.test(op.name)) continue
    if (options.exclude?.test(op.name)) continue

    const concrete = op.responses
      .filter((r) => /^\d{3}$/.test(r.status))
      .sort((a, b) => Number(a.status) - Number(b.status))
    // A `2XX` range has no code of its own, so it stands in as a 200 when nothing is more exact.
    const range = op.responses.find((r) => r.status.toUpperCase() === '2XX')
    const primary = concrete.find((r) => r.status.startsWith('2')) ?? range
    if (!primary) {
      result.skipped.push({ operation: op.name, reason: 'no 2xx response is documented' })
      continue
    }
    const codeOf = (r: SpecResponse) => (r === range && r === primary ? 200 : Number(r.status))
    if (options.allStatuses) {
      for (const r of op.responses.filter((r) => !/^\d{3}$/.test(r.status) && r !== primary)) {
        result.skipped.push({
          operation: `${op.name} ${r.status}`,
          reason: 'not a single status code, so there is nothing to match',
        })
      }
    }
    for (const response of options.allStatuses
      ? [...concrete, ...(range === primary ? [range] : [])]
      : [primary]) {
      const isPrimary = response === primary
      const status = codeOf(response)
      const built = stubFor(op, response, status, specHash, isPrimary)
      if (typeof built === 'string') {
        result.skipped.push({ operation: `${op.name} ${response.status}`, reason: built })
        continue
      }
      if (response.hasExample && response.schema) {
        for (const e of validateSchema(response.example, response.schema, resolve)) {
          result.warnings.push({
            operation: `${op.name} ${response.status}`,
            reason: `the example doesn't fit its schema, at ${e.pointer || '(the body)'}: ${e.message}`,
          })
        }
      }
      const file = `mappings/${op.name.replace(/[^A-Za-z0-9._-]/g, '_')}${isPrimary ? '' : `-${status}`}.json`
      const owner = fileOwners.get(file)
      if (owner !== undefined && owner !== op.name) {
        throw new Error(`operations '${owner}' and '${op.name}' would both be written to ${file}`)
      }
      fileOwners.set(file, op.name)
      result.mappings.push({ file, mapping: built })
    }
  }
  return result
}

/** How many of a path's segments are fixed text, not parameters. */
function literalSegments(route: string): number {
  return route.split('/').filter((s) => s && !s.includes('{')).length
}

/** A mapping, or the reason there isn't one. */
function stubFor(
  op: DetailedOperation & { name: string },
  response: SpecResponse,
  status: number,
  specHash: string,
  isPrimary: boolean,
): object | string {
  const reply: Record<string, unknown> = { status }
  if (response.mediaType) {
    if (!response.hasExample) return `no example for the ${response.mediaType} response`
    reply.headers = { 'Content-Type': response.mediaType }
    // WireMock serves a `jsonBody` of null as an empty body, so null goes out as text.
    if (isJson(response.mediaType) && response.example === null) reply.body = 'null'
    else if (isJson(response.mediaType)) reply.jsonBody = response.example
    else if (typeof response.example === 'string') reply.body = response.example
    else return `the example for ${response.mediaType} isn't a string`
  }
  // WireMock tries the lowest number first: a path with more fixed segments
  // (`/pets/mine`) goes before `/pets/{id}`, and both before the error stubs (10).
  // They stay above 5, WireMock's default, so a stub a scenario adds without a priority wins.
  const priority = isPrimary
    ? LOWER_PRIORITY - 1 - Math.min(3, literalSegments(op.path))
    : LOWER_PRIORITY
  return {
    name: isPrimary ? op.name : `${op.name} ${response.status}`,
    priority,
    metadata: { generatedBy: GENERATED_BY, operation: op.name, specHash },
    request: { method: op.method, urlPathTemplate: op.path },
    response: reply,
  }
}

/** Options for {@link checkStubs}. */
export interface CheckStubsOptions {
  /** See {@link LoadSpecOptions.basePath}. */
  basePath?: string
  /**
   * Known gaps, each a mapping's file name (`getPet.json`), that aren't
   * reported. An entry that no longer matches a problem is reported as stale.
   */
  allowlist?: Iterable<string>
  /** WireMock runs with global response templating: a body with `{{` isn't checked. */
  templated?: boolean
}

/** What {@link checkStubs} found. `key` in each problem is the mapping's file name. */
export interface CheckStubsResult {
  problems: Problem[]
  /** Generated stubs made from another version of the spec. They are still checked. */
  warnings: Problem[]
  /** Problems the allowlist accounted for. */
  allowlisted: Problem[]
  /** Allowlist entries that matched nothing: remove them. */
  stale: string[]
}

type Mapping = Record<string, unknown>

function asObject(value: unknown): Mapping {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Mapping) : {}
}

const SAMPLES = ['1', 'abc', '00000000-0000-0000-0000-000000000000']

type Found = { ops: DetailedOperation[] } | { problem: string }

/** Sample queries to try a `urlPattern` with, as WireMock matches it against the path and query. */
const QUERIES = ['', '?a=1', '?a=1&b=2']

/**
 * The operations a mapping's request goes to, or why that can't be told.
 * With a method there is one; with `ANY` or none, there may be one per
 * method, but all at the same path.
 */
function operationOf(request: Mapping, operations: DetailedOperation[]): Found {
  const method = typeof request.method === 'string' ? request.method.toUpperCase() : 'ANY'
  const methods = method === 'ANY' ? METHODS : [method]
  const describe = (url: string) => `${method} ${url}`

  const literal = ['urlPathTemplate', 'urlPath', 'url'].find((k) => typeof request[k] === 'string')
  let candidates: DetailedOperation[]
  let shown: string
  if (literal) {
    shown = describe(request[literal] as string)
    candidates = methods.flatMap(
      (m) => findOperation(operations, m, request[literal] as string) ?? [],
    )
    if (candidates.length === 0) return { problem: `${shown} matches no operation in the spec` }
  } else {
    const key = ['urlPathPattern', 'urlPattern'].find((k) => typeof request[k] === 'string')
    if (!key) return { problem: 'unresolved: the request has no URL matcher' }
    const pattern = request[key] as string
    shown = describe(`${key} ${pattern}`)
    let re: RegExp
    try {
      re = new RegExp(`^(?:${pattern})$`)
    } catch {
      return { problem: `unresolved: ${shown} is not a regular expression this check can read` }
    }
    // A regex can't be matched to a template, so try it on paths with sample
    // values filled in, and for `urlPattern`, a sample query after them.
    const queries = key === 'urlPattern' ? QUERIES : ['']
    candidates = operations.filter(
      (op) =>
        methods.includes(op.method) &&
        SAMPLES.some((sample) =>
          queries.some((q) => re.test(op.path.replace(/\{[^}]*\}/g, sample) + q)),
        ),
    )
    if (candidates.length === 0) {
      return {
        problem: `unresolved: ${shown} matches no operation, so its responses can't be checked`,
      }
    }
  }
  if (new Set(candidates.map((op) => op.path)).size > 1) {
    return {
      problem: `unresolved: ${shown} matches ${candidates.length} operations at different paths`,
    }
  }
  return { ops: candidates }
}

function documented(op: DetailedOperation, status: number): SpecResponse | undefined {
  const exact = op.responses.find((r) => r.status === String(status))
  const range = op.responses.find((r) => r.status.toUpperCase() === `${String(status)[0]}XX`)
  return exact ?? range ?? op.responses.find((r) => r.status === 'default')
}

/**
 * Check the WireMock mappings in `<dir>/mappings` against a spec, generated
 * or hand-written: each must go to a spec operation, answer with a status
 * the operation documents, and give a JSON body that fits the response's
 * schema. A generated stub from another version of the spec is a warning.
 */
export function checkStubs(
  specFile: string,
  dir: string,
  options: CheckStubsOptions = {},
): CheckStubsResult {
  const { operations, resolve } = loadSpecDetail(specFile, { basePath: options.basePath })
  const specHash = specHashOf(specFile)
  const mappingsDir = path.join(dir, 'mappings')
  if (!fs.existsSync(mappingsDir)) throw new Error(`${mappingsDir} doesn't exist`)

  const found: Problem[] = []
  const warnings: Problem[] = []
  const files = fs
    .readdirSync(mappingsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
  for (const name of files) {
    const where = path.join(mappingsDir, name)
    const add = (message: string) => found.push({ key: name, where, message })
    let parsed: Mapping
    try {
      parsed = asObject(JSON.parse(fs.readFileSync(where, 'utf-8')))
    } catch (err) {
      add(`isn't valid JSON: ${(err as Error).message}`)
      continue
    }
    const mappings = Array.isArray(parsed.mappings) ? parsed.mappings.map(asObject) : [parsed]
    for (const mapping of mappings) {
      const metadata = asObject(mapping.metadata)
      if (metadata.generatedBy === GENERATED_BY && metadata.specHash !== specHash) {
        warnings.push({
          key: name,
          where,
          message: `was generated from another version of ${specFile}: regenerate it with ctf stubs`,
        })
      }
      checkMapping(mapping, operations, resolve, add, options.templated ?? false)
    }
  }

  const allowlist = new Set(options.allowlist ?? [])
  const used = new Set<string>()
  const result: CheckStubsResult = { problems: [], warnings, allowlisted: [], stale: [] }
  for (const problem of found) {
    if (allowlist.has(problem.key)) {
      used.add(problem.key)
      result.allowlisted.push(problem)
    } else {
      result.problems.push(problem)
    }
  }
  result.stale = [...allowlist].filter((key) => !used.has(key)).sort()
  return result
}

function checkMapping(
  mapping: Mapping,
  operations: DetailedOperation[],
  resolve: Parameters<typeof validateSchema>[2],
  add: (message: string) => void,
  templated: boolean,
): void {
  const found = operationOf(asObject(mapping.request), operations)
  if ('problem' in found) return add(found.problem)
  const reply = asObject(mapping.response)
  // A fault or a proxied response has no status or body of its own.
  if (reply.fault !== undefined || reply.proxyBaseUrl !== undefined) return

  const { ops } = found
  const status = typeof reply.status === 'number' ? reply.status : 200
  const describe = (list: DetailedOperation[]) =>
    `${list.map((op) => op.method).join('|')} ${list[0].path}`
  const responses = ops.flatMap((op) => documented(op, status) ?? [])
  if (responses.length === 0) return add(`${describe(ops)} doesn't document a ${status} response`)
  const label = describe(ops.filter((op) => documented(op, status)))
  // A response without a schema puts no limit on the body, but it can't excuse a body that is wrong for another.
  const schemas = responses.flatMap((r) => r.schema ?? [])
  if (schemas.length === 0) return

  let body: unknown
  if (reply.jsonBody !== undefined) body = reply.jsonBody
  else if (typeof reply.body === 'string') {
    try {
      body = JSON.parse(reply.body)
    } catch {
      return
    }
  } else return
  // A body that goes through response templating isn't the final one.
  if (asArray(reply.transformers).includes('response-template')) return
  if (templated && JSON.stringify(body).includes('{{')) return

  // The body must fit every operation that documents the status.
  const failed = schemas
    .map((schema) => validateSchema(body, schema, resolve))
    .find((errors) => errors.length > 0)
  if (!failed) return
  for (const error of failed) {
    add(
      `the ${status} response of ${label} has a body that doesn't fit its schema, at ${error.pointer || '(the body)'}: ${error.message}`,
    )
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Where the mapping files `generateStubs` made would go, that already exist. */
export function existingFiles(dir: string, mappings: { file: string }[]): string[] {
  return mappings.map((m) => path.join(dir, m.file)).filter((f) => fs.existsSync(f))
}
