import * as fs from 'fs'
import * as path from 'path'
import { parse as parseYaml } from 'yaml'

/** One operation in an OpenAPI spec. */
export interface SpecOperation {
  /** The spec's `operationId`, if it has one. */
  operationId?: string
  /** Upper-case HTTP method, e.g. `GET`. */
  method: string
  /** The path as the API under test sees it: the base path, then the spec's path. */
  path: string
  /** The path as the spec has it, without the base path. */
  route: string
  /** The spec's `summary`, if any. */
  summary?: string
}

/** Options for {@link loadSpec}. */
export interface LoadSpecOptions {
  /**
   * Put in front of every path, e.g. `/api/v1`. Default: the path of the
   * spec's first server URL, with its variables' defaults filled in
   * (`servers: [{ url: /api/v1 }]` gives `/api/v1`, `http://localhost:8080`
   * gives nothing), or `basePath` in Swagger 2. Servers set on a path or an
   * operation aren't used.
   */
  basePath?: string
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

type Json = Record<string, unknown>

function readDocument(file: string, cache: Map<string, Json>): Json {
  const cached = cache.get(file)
  if (cached) return cached
  const text = fs.readFileSync(file, 'utf-8')
  let doc: unknown
  try {
    doc = file.endsWith('.json') ? JSON.parse(text) : parseYaml(text, { merge: true })
  } catch (err) {
    throw new Error(`${file} can't be parsed: ${(err as Error).message}`)
  }
  if (!doc || typeof doc !== 'object') throw new Error(`${file} is not an OpenAPI document`)
  cache.set(file, doc as Json)
  return doc as Json
}

/** Follow a `$ref` (`#/a/b`, `other.yaml`, or `other.yaml#/a/b`), and any it leads to, from `file`. */
function resolveRef(ref: string, file: string, root: Json, cache: Map<string, Json>): Json {
  const seen = new Set<string>()
  for (;;) {
    const [target, pointer = ''] = ref.split('#')
    const docFile = target ? path.resolve(path.dirname(file), target) : file
    if (seen.has(`${docFile}#${pointer}`)) throw new Error(`$ref cycle at ${ref} in ${file}`)
    seen.add(`${docFile}#${pointer}`)
    const doc = target ? readDocument(docFile, cache) : root
    let value: unknown = doc
    for (const part of pointer.split('/').filter(Boolean)) {
      const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')
      value = (value as Json | undefined)?.[key]
    }
    if (!value || typeof value !== 'object')
      throw new Error(`Can't resolve $ref ${ref} from ${file}`)
    const next = (value as Json).$ref
    if (typeof next !== 'string') return value as Json
    ref = next
    file = docFile
    root = doc
  }
}

function basePathOf(doc: Json): string {
  if (typeof doc.basePath === 'string') return doc.basePath
  const server = (doc.servers as { url?: unknown; variables?: Json }[] | undefined)?.[0]
  if (typeof server?.url !== 'string') return ''
  // Variables take their defaults, as a client would without other values.
  const url = server.url.replace(/\{([^}]*)\}/g, (_, name: string) => {
    const variable = server.variables?.[name] as { default?: unknown } | undefined
    return variable?.default !== undefined ? String(variable.default) : ''
  })
  // Relative URLs (`/api/v1`, `api/v1`, `./`) resolve against the host.
  let pathname: string
  try {
    pathname = new URL(url, 'http://server.invalid/').pathname
  } catch {
    return ''
  }
  return decodeURI(pathname).replace(/\/+$/, '')
}

/** A spec's operations, in the order the spec lists them. */
export function loadSpec(file: string, options: LoadSpecOptions = {}): SpecOperation[] {
  const cache = new Map<string, Json>()
  const doc = readDocument(file, cache)
  if (!doc.paths || typeof doc.paths !== 'object') {
    throw new Error(`${file} has no paths: is it an OpenAPI or Swagger document?`)
  }
  const base = (options.basePath ?? basePathOf(doc)).replace(/\/+$/, '')
  const operations: SpecOperation[] = []
  for (const [route, raw] of Object.entries(doc.paths as Json)) {
    let item = raw as Json
    if (typeof item?.$ref === 'string') item = resolveRef(item.$ref, file, doc, cache)
    for (const method of METHODS) {
      const op = item?.[method] as Json | undefined
      if (!op || typeof op !== 'object') continue
      operations.push({
        operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
        method: method.toUpperCase(),
        path: `${base}${route}`,
        route,
        summary: typeof op.summary === 'string' ? op.summary : undefined,
      })
    }
  }
  return operations
}

/** A path's segments, without its query string; a trailing slash is an empty last segment. */
function segments(route: string): string[] {
  return route.split(/[?#]/)[0].split('/').slice(1)
}

/** A map's own `{param}`, which stands for any value. */
const PLACEHOLDER = '\u0000'

interface CompiledSegment {
  pattern: RegExp
  /** Parameters in the segment. */
  params: number
}

function compile(segment: string): CompiledSegment {
  let params = 0
  const source = segment
    .split(/(\{[^}]*\})/)
    .map((part) => {
      if (/^\{[^}]*\}$/.test(part)) {
        params++
        return '[^/]+'
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return { pattern: new RegExp(`^${source}$`), params }
}

/**
 * The spec operation a request goes to: the same method, and a path that
 * matches segment by segment, where a spec `{param}`, alone in a segment or
 * part of one (`{name}.json`), matches any value. A map path may carry
 * concrete values (`/orgs/acme`) or a query string; both still match, as
 * does the map's own `{param}` against a spec parameter. A trailing slash
 * is significant, as it is to most routers. Where several match, the one
 * with fewest parameters wins, and then the one whose first parameter
 * comes latest, as a router would choose `/orgs/me` over `/orgs/{id}`.
 */
export function findOperation<T extends Pick<SpecOperation, 'method' | 'path'>>(
  operations: T[],
  method: string,
  route: string,
): T | undefined {
  const wanted = segments(route).map((s) => s.replace(/\{[^}]*\}/g, PLACEHOLDER))
  let best: { op: T; params: number; firstParam: number } | undefined
  for (const op of operations) {
    if (op.method !== method.toUpperCase()) continue
    const candidate = segments(op.path)
    if (candidate.length !== wanted.length) continue
    let params = 0
    let firstParam = candidate.length
    const fits = candidate.every((segment, i) => {
      const compiled = compile(segment)
      if (compiled.params === 0) return segment === wanted[i]
      params += compiled.params
      firstParam = Math.min(firstParam, i)
      return compiled.pattern.test(wanted[i])
    })
    if (!fits) continue
    if (!best || params < best.params || (params === best.params && firstParam > best.firstParam)) {
      best = { op, params, firstParam }
    }
  }
  return best?.op
}
