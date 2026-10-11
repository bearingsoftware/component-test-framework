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
   * spec's first server URL (`servers: [{ url: /api/v1 }]` gives `/api/v1`,
   * `http://localhost:8080` gives nothing), or `basePath` in Swagger 2.
   */
  basePath?: string
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

type Json = Record<string, unknown>

function readDocument(file: string): Json {
  const text = fs.readFileSync(file, 'utf-8')
  const doc = file.endsWith('.json') ? JSON.parse(text) : parseYaml(text)
  if (!doc || typeof doc !== 'object') throw new Error(`${file} is not an OpenAPI document`)
  return doc as Json
}

/** Follow a `$ref` (`#/a/b`, `other.yaml`, or `other.yaml#/a/b`) from `file`. */
function resolveRef(
  ref: string,
  file: string,
  root: Json,
): { value: Json; file: string; root: Json } {
  const [target, pointer = ''] = ref.split('#')
  let doc = root
  let docFile = file
  if (target) {
    docFile = path.resolve(path.dirname(file), target)
    doc = readDocument(docFile)
  }
  let value: unknown = doc
  for (const part of pointer.split('/').filter(Boolean)) {
    const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')
    value = (value as Json | undefined)?.[key]
  }
  if (!value || typeof value !== 'object') throw new Error(`Can't resolve $ref ${ref} from ${file}`)
  return { value: value as Json, file: docFile, root: doc }
}

function basePathOf(doc: Json): string {
  if (typeof doc.basePath === 'string') return doc.basePath
  const servers = doc.servers as { url?: unknown }[] | undefined
  const url = servers?.[0]?.url
  if (typeof url !== 'string') return ''
  // A relative server URL is itself the base path; an absolute one has one.
  const pathname = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? new URL(url).pathname : url
  return pathname.replace(/\{[^}]*\}/g, '').replace(/\/+$/, '')
}

/** A spec's operations, in the order the spec lists them. */
export function loadSpec(file: string, options: LoadSpecOptions = {}): SpecOperation[] {
  const doc = readDocument(file)
  if (!doc.paths || typeof doc.paths !== 'object') {
    throw new Error(`${file} has no paths: is it an OpenAPI or Swagger document?`)
  }
  const base = (options.basePath ?? basePathOf(doc)).replace(/\/+$/, '')
  const operations: SpecOperation[] = []
  for (const [route, raw] of Object.entries(doc.paths as Json)) {
    let item = raw as Json
    if (typeof item?.$ref === 'string') item = resolveRef(item.$ref, file, doc).value
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

/** A path with its parameter names dropped, so `/a/{id}` and `/a/{projectId}` compare equal. */
export function routeKey(method: string, route: string): string {
  return `${method.toUpperCase()} ${route.replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '') || '/'}`
}

function segments(route: string): string[] {
  return route.split('?')[0].replace(/\/+$/, '').split('/').slice(1)
}

/**
 * The spec operation a request goes to: the same method, and a path that
 * matches segment by segment, where a spec `{param}` matches any value. A map
 * path may carry concrete values (`/orgs/acme`) or a query string; both
 * still match, as does the map's own `{param}` against a spec parameter.
 * Where several match, the one with fewest parameters wins, as a router
 * would choose `/orgs/me` over `/orgs/{id}`.
 */
export function findOperation<T extends Pick<SpecOperation, 'method' | 'path'>>(
  operations: T[],
  method: string,
  route: string,
): T | undefined {
  const wanted = segments(route)
  let best: { op: T; params: number } | undefined
  for (const op of operations) {
    if (op.method !== method.toUpperCase()) continue
    const candidate = segments(op.path)
    if (candidate.length !== wanted.length) continue
    let params = 0
    const fits = candidate.every((segment, i) => {
      if (/^\{[^}]*\}$/.test(segment)) {
        params++
        return wanted[i] !== ''
      }
      // A map's own {param} stands for any value, so only a spec parameter
      // can match it: /orders/{id} isn't /orders/mine.
      return segment === wanted[i]
    })
    if (fits && (!best || params < best.params)) best = { op, params }
  }
  return best?.op
}
