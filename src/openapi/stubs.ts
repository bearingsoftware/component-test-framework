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
  const { operations } = loadSpecDetail(specFile, { basePath: options.basePath })
  const specHash = specHashOf(specFile)
  const result: GeneratedStubs = { mappings: [], skipped: [] }

  for (const op of namedOperations(operations)) {
    if (options.include && !options.include.test(op.name)) continue
    if (options.exclude?.test(op.name)) continue

    const concrete = op.responses
      .filter((r) => /^\d{3}$/.test(r.status))
      .sort((a, b) => Number(a.status) - Number(b.status))
    const primary = concrete.find((r) => r.status.startsWith('2'))
    if (!primary) {
      result.skipped.push({ operation: op.name, reason: 'no 2xx response is documented' })
      continue
    }
    if (options.allStatuses) {
      for (const r of op.responses.filter((r) => !/^\d{3}$/.test(r.status))) {
        result.skipped.push({
          operation: `${op.name} ${r.status}`,
          reason: 'not a single status code, so there is nothing to match',
        })
      }
    }
    for (const response of options.allStatuses ? concrete : [primary]) {
      const isPrimary = response === primary
      const built = stubFor(op, response, specHash, isPrimary)
      if (typeof built === 'string') {
        result.skipped.push({ operation: `${op.name} ${response.status}`, reason: built })
        continue
      }
      const base = op.name.replace(/[^A-Za-z0-9._-]/g, '_')
      result.mappings.push({
        file: `mappings/${base}${isPrimary ? '' : `-${response.status}`}.json`,
        mapping: built,
      })
    }
  }
  return result
}

/** A mapping, or the reason there isn't one. */
function stubFor(
  op: DetailedOperation & { name: string },
  response: SpecResponse,
  specHash: string,
  isPrimary: boolean,
): object | string {
  const reply: Record<string, unknown> = { status: Number(response.status) }
  if (response.mediaType) {
    if (!response.hasExample) return `no example for the ${response.mediaType} response`
    reply.headers = { 'Content-Type': response.mediaType }
    if (isJson(response.mediaType)) reply.jsonBody = response.example
    else if (typeof response.example === 'string') reply.body = response.example
    else return `the example for ${response.mediaType} isn't a string`
  }
  return {
    name: isPrimary ? op.name : `${op.name} ${response.status}`,
    ...(isPrimary ? {} : { priority: LOWER_PRIORITY }),
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

type Found = { op: DetailedOperation } | { problem: string }

/** The one operation a mapping's request goes to, or why it can't be told. */
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
    // A regex can't be matched to a template, so try it on paths with sample values filled in.
    candidates = operations.filter(
      (op) =>
        methods.includes(op.method) &&
        SAMPLES.some((sample) => re.test(op.path.replace(/\{[^}]*\}/g, sample))),
    )
    if (candidates.length !== 1) {
      return {
        problem: `unresolved: ${shown} ${candidates.length === 0 ? 'matches no operation' : `matches ${candidates.length} operations`}, so its responses can't be checked`,
      }
    }
  }
  const distinct = [...new Set(candidates)]
  if (distinct.length === 0) return { problem: `${shown} matches no operation in the spec` }
  if (distinct.length > 1) {
    return { problem: `unresolved: ${shown} matches ${distinct.length} operations` }
  }
  return { op: distinct[0] }
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
      checkMapping(mapping, operations, resolve, add)
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
): void {
  const found = operationOf(asObject(mapping.request), operations)
  if ('problem' in found) return add(found.problem)
  const reply = asObject(mapping.response)
  // A fault or a proxied response has no status or body of its own.
  if (reply.fault !== undefined || reply.proxyBaseUrl !== undefined) return

  const { op } = found
  const status = typeof reply.status === 'number' ? reply.status : 200
  const response = documented(op, status)
  if (!response) {
    return add(`${op.method} ${op.path} doesn't document a ${status} response`)
  }
  if (!response.schema) return

  let body: unknown
  if (reply.jsonBody !== undefined) body = reply.jsonBody
  else if (typeof reply.body === 'string') {
    try {
      body = JSON.parse(reply.body)
    } catch {
      return
    }
  } else return
  // A templated body isn't the final one.
  if (JSON.stringify(body).includes('{{')) return

  for (const error of validateSchema(body, response.schema, resolve)) {
    add(
      `the ${status} response of ${op.method} ${op.path} has a body that doesn't fit its schema, at ${error.pointer || '(the body)'}: ${error.message}`,
    )
  }
}

/** Where the mapping files `generateStubs` made would go, that already exist. */
export function existingFiles(dir: string, mappings: { file: string }[]): string[] {
  return mappings.map((m) => path.join(dir, m.file)).filter((f) => fs.existsSync(f))
}
