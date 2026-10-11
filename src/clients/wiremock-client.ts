import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/** Filters for {@link WireMockClient.getRequestCount} and {@link WireMockClient.findRequests}. */
export interface RequestFilter {
  /** Only match requests with this HTTP method, e.g. "POST". Matches any method when omitted. */
  method?: string
  /**
   * Treat the path as an exact path rather than a regular expression. Use it
   * for paths containing regex characters such as `?`, `+` or `.`.
   */
  exactPath?: boolean
  /**
   * Only match requests whose JSON body matches this JSONPath expression,
   * e.g. `$[?(@.status == 'active')]`.
   */
  bodyJsonPath?: string
}

/** Options for {@link WireMockClient}. */
export interface WireMockClientOptions {
  /**
   * A path prefix, such as `/__worker-2`, that keeps this client's stubs and
   * requests apart from other clients' on the same WireMock. Every stub it
   * registers matches only under the prefix, request counts and searches
   * look only under it, and resets remove only its own stubs and requests.
   * The service under test must call WireMock under the same prefix (see
   * `workerWiremockUrl`). `registerHooks` sets it with
   * `workerIsolation.wiremock` under Cucumber `--parallel`.
   */
  namespace?: string
}

/** The metadata key that marks which namespace registered a stub. */
const NAMESPACE_KEY = 'componentTestNamespace'

/**
 * Client for WireMock's Admin API (/__admin/).
 * Manages stub mappings, resets state, and verifies request counts.
 *
 * An empty `baseUrl` means WireMock isn't configured. The client can still be
 * constructed, but every call throws and says how to configure it.
 */
export class WireMockClient {
  /**
   * @param baseUrl WireMock's base URL. Empty means not configured.
   * @param requestTimeout How long each admin request may take, in ms, so a
   *   stalled WireMock fails a step rather than hanging the run.
   */
  constructor(
    readonly baseUrl: string,
    private readonly requestTimeout = 10_000,
    private readonly options: WireMockClientOptions = {},
  ) {}

  /** The namespace prefix, or undefined when this client has WireMock to itself. */
  get namespace(): string | undefined {
    return this.options.namespace
  }

  /** `fetch` with this client's request timeout. */
  private fetch(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, { ...init, signal: AbortSignal.timeout(this.requestTimeout) })
  }

  private url(adminPath: string): string {
    if (!this.baseUrl) {
      throw new Error(
        'WireMock is not configured. Set WIREMOCK_URL or pass wiremockUrl to registerHooks.',
      )
    }
    return `${this.baseUrl}${adminPath}`
  }

  private async expectOk(res: Response, action: string): Promise<void> {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`WireMock ${action} failed (${res.status}): ${body}`)
    }
  }

  /**
   * Reset all stubs and request logs. With a namespace, only this client's:
   * its stubs (and so their scenarios) and the requests under its prefix.
   */
  async resetAll(): Promise<void> {
    const ns = this.options.namespace
    if (!ns) {
      const res = await this.fetch(this.url('/__admin/reset'), { method: 'POST' })
      return this.expectOk(res, 'resetAll')
    }
    const res = await this.fetch(this.url('/__admin/mappings/remove-by-metadata'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchesJsonPath: { expression: `$.${NAMESPACE_KEY}`, equalTo: ns } }),
    })
    await this.expectOk(res, 'resetAll (stubs)')
    await this.resetRequests()
  }

  /** Reset only the request journal (keep stubs). With a namespace, only requests under it. */
  async resetRequests(): Promise<void> {
    const ns = this.options.namespace
    if (!ns) {
      const res = await this.fetch(this.url('/__admin/requests'), { method: 'DELETE' })
      return this.expectOk(res, 'resetRequests')
    }
    const res = await this.fetch(this.url('/__admin/requests/remove'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urlPathPattern: `${escapeRegex(ns)}(/.*)?` }),
    })
    await this.expectOk(res, 'resetRequests')
  }

  /**
   * Load all WireMock mapping files from a directory and register them in one
   * call to `/__admin/mappings/import`, rather than one POST per file.
   * Expects the standard WireMock layout: {dir}/mappings/*.json. A file may
   * hold a single mapping or WireMock's multi-mapping form, `{ "mappings": [...] }`.
   */
  async loadMappingsFromDir(mappingsDir: string): Promise<void> {
    const dir = path.resolve(mappingsDir, 'mappings')
    if (!fs.existsSync(dir)) return

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
    const mappings = files.flatMap((file) => {
      const filePath = path.join(dir, file)
      let parsed
      try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      } catch (err) {
        throw new Error(`WireMock mapping ${filePath} is not valid JSON: ${String(err)}`)
      }
      return Array.isArray(parsed.mappings) ? parsed.mappings : [parsed]
    })
    try {
      await this.importStubs(mappings)
    } catch (err) {
      throw new Error(`${(err as Error).message} (mappings from ${dir})`)
    }
  }

  /**
   * Register several stub mappings in one request, with the same result as
   * calling {@link addStub} for each in order. Existing stubs are kept; a
   * mapping whose `id` matches an existing stub replaces it.
   */
  async importStubs(mappings: Record<string, unknown>[]): Promise<void> {
    if (mappings.length === 0) return
    const res = await this.fetch(this.url('/__admin/mappings/import'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // When two stubs have the same priority, WireMock serves the one added
        // most recently. One POST at a time, that's the last one; an import
        // gives precedence to the first. Reversing keeps "last one wins".
        mappings: [...mappings].reverse().map((m) => this.scoped(m)),
        importOptions: { duplicatePolicy: 'OVERWRITE', deleteAllNotInImport: false },
      }),
    })
    await this.expectOk(res, 'importStubs')
  }

  /** A mapping as this client registers it: unchanged, or moved under its namespace. */
  private scoped(mapping: Record<string, unknown>): Record<string, unknown> {
    return this.options.namespace ? namespaceStub(mapping, this.options.namespace) : mapping
  }

  /** Register a single stub mapping. */
  async addStub(mapping: Record<string, unknown>): Promise<void> {
    const res = await this.fetch(this.url('/__admin/mappings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.scoped(mapping)),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`WireMock addStub failed (${res.status}): ${body}`)
    }
  }

  /**
   * Load a stub mapping from `{rootDir}/{relPath}` and register it. If the
   * mapping's response has a `bodyFileName` but no inline `body`, the
   * referenced file is read from disk and inlined before POSTing to the admin
   * API — WireMock itself resolves `bodyFileName` from its `__files` mount,
   * which isn't always available when stubs are registered at runtime.
   */
  async addStubFromFile(relPath: string, rootDir: string): Promise<void> {
    const raw = await fs.promises.readFile(path.join(rootDir, relPath), 'utf-8')
    const stub = JSON.parse(raw) as {
      response?: { bodyFileName?: string; body?: string }
    }
    if (stub.response?.bodyFileName && !stub.response.body) {
      const bodyFileName = stub.response.bodyFileName
      try {
        stub.response.body = await fs.promises.readFile(path.join(rootDir, bodyFileName), 'utf-8')
      } catch {
        // Fall back to WireMock's standard layout: sibling __files dir next to mappings/.
        const fallback = path.join(
          path.dirname(path.join(rootDir, relPath)),
          '..',
          '__files',
          path.basename(bodyFileName),
        )
        stub.response.body = await fs.promises.readFile(fallback, 'utf-8')
      }
      delete stub.response.bodyFileName
    }
    await this.addStub(stub)
  }

  /** Wait for the WireMock admin API to respond to /__admin/health. */
  async waitForReady(timeoutMs: number): Promise<void> {
    // Resolved outside the retry loop, so a missing URL fails at once rather
    // than being swallowed as "not up yet" until the timeout.
    const healthUrl = this.url('/__admin/health')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const res = await this.fetch(healthUrl)
        if (res.ok) return
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`WireMock at ${this.baseUrl} did not become ready within ${timeoutMs}ms`)
  }

  /** Remove a stub mapping by its UUID. */
  async removeStub(id: string): Promise<void> {
    const ns = this.options.namespace
    const scopedId = ns ? namespaceId(id, ns) : id
    const res = await this.fetch(this.url(`/__admin/mappings/${scopedId}`), { method: 'DELETE' })
    // Removing a stub that's already gone is not an error.
    if (res.status === 404) return
    await this.expectOk(res, 'removeStub')
  }

  /** Get the count of requests matching a URL path pattern, optionally filtered by method. */
  async getRequestCount(urlPathPattern: string, filter: RequestFilter = {}): Promise<number> {
    const res = await this.fetch(this.url('/__admin/requests/count'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.pattern(urlPathPattern, filter)),
    })
    if (!res.ok) {
      throw new Error(`WireMock request count failed: ${res.status}`)
    }
    const data = (await res.json()) as { count: number }
    return data.count
  }

  /** Verify that a URL path pattern was called exactly N times. */
  async verifyCallCount(
    urlPathPattern: string,
    expectedCount: number,
    filter: RequestFilter = {},
  ): Promise<void> {
    const actual = await this.getRequestCount(urlPathPattern, filter)
    if (actual !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} calls to ${describeRequests(urlPathPattern, filter)}, got ${actual}`,
      )
    }
  }

  /** Find all requests matching a URL path pattern, optionally filtered by method. */
  async findRequests(urlPathPattern: string, filter: RequestFilter = {}): Promise<unknown[]> {
    const res = await this.fetch(this.url('/__admin/requests/find'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.pattern(urlPathPattern, filter)),
    })
    if (!res.ok) {
      throw new Error(`WireMock find requests failed: ${res.status}`)
    }
    const data = (await res.json()) as { requests: unknown[] }
    const ns = this.options.namespace
    // Requests are reported as the service sent them, without the prefix.
    return ns ? data.requests.map((r) => withoutNamespace(r, ns)) : data.requests
  }

  /** A request pattern for a path, under the namespace if there is one. */
  private pattern(urlPathPattern: string, filter: RequestFilter): Record<string, unknown> {
    const pattern = requestPattern(urlPathPattern, filter)
    const ns = this.options.namespace
    return ns ? { ...pattern, ...namespaceUrlMatcher(pattern, ns) } : pattern
  }
}

/** Build a WireMock request pattern from a path and a {@link RequestFilter}. */
export function requestPattern(path: string, filter: RequestFilter = {}): Record<string, unknown> {
  const pattern: Record<string, unknown> = filter.exactPath
    ? { urlPath: path }
    : { urlPathPattern: path }
  if (filter.method) pattern.method = filter.method.toUpperCase()
  if (filter.bodyJsonPath) pattern.bodyPatterns = [{ matchesJsonPath: filter.bodyJsonPath }]
  return pattern
}

/** Describe a path and filter for error messages, e.g. "POST /orders matching $.id". */
export function describeRequests(path: string, filter: RequestFilter = {}): string {
  const method = filter.method ? `${filter.method.toUpperCase()} ` : ''
  const body = filter.bodyJsonPath ? ` matching ${filter.bodyJsonPath}` : ''
  return `${method}${path}${body}`
}

const URL_KEYS = ['url', 'urlPath', 'urlPathTemplate', 'urlPattern', 'urlPathPattern'] as const

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The URL matcher of a request pattern, moved under `ns`. Exact paths get
 * the prefix in front; patterns get it in front of the regex (after a
 * leading `^`); a pattern with no URL matcher, which matched any URL, now
 * matches any URL under the prefix.
 */
export function namespaceUrlMatcher(
  request: Record<string, unknown>,
  ns: string,
): Record<string, unknown> {
  const key = URL_KEYS.find((k) => typeof request[k] === 'string')
  if (!key) return { urlPathPattern: `${escapeRegex(ns)}(/.*)?` }
  const value = request[key] as string
  if (key === 'urlPattern' || key === 'urlPathPattern') {
    // The pattern goes in a group, so a top-level `|` can't reach outside
    // the prefix, and the prefix must end at a `/` or the end of the path,
    // so worker 1's `.*/items` can't match worker 10's `/__worker-10/items`.
    const rest = value.startsWith('^') ? value.slice(1) : value
    return { [key]: `${escapeRegex(ns)}(?=/|$|\\?)(?:${rest})` }
  }
  return { [key]: `${ns}${value}` }
}

/**
 * A stable id for a stub id under a namespace, so the same stub file loaded
 * by two workers is two stubs, not one overwriting the other.
 */
export function namespaceId(id: string, ns: string): string {
  const hex = createHash('sha256').update(`${ns}\0${id}`).digest('hex')
  // Laid out as a UUID, which WireMock requires of stub ids.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * A stub mapping moved under a namespace: its URL matcher, its id and its
 * scenario name, with metadata marking it as the namespace's own, so a
 * reset can remove exactly the namespace's stubs.
 */
export function namespaceStub(
  mapping: Record<string, unknown>,
  ns: string,
): Record<string, unknown> {
  const request = { ...((mapping.request as Record<string, unknown> | undefined) ?? {}) }
  for (const key of URL_KEYS) delete request[key]
  const scoped: Record<string, unknown> = {
    ...mapping,
    request: {
      ...request,
      ...namespaceUrlMatcher((mapping.request as Record<string, unknown> | undefined) ?? {}, ns),
    },
    metadata: {
      ...((mapping.metadata as Record<string, unknown> | undefined) ?? {}),
      [NAMESPACE_KEY]: ns,
    },
  }
  for (const key of ['id', 'uuid'] as const) {
    if (typeof mapping[key] === 'string') scoped[key] = namespaceId(mapping[key] as string, ns)
  }
  if (typeof mapping.scenarioName === 'string')
    scoped.scenarioName = `${ns}:${mapping.scenarioName}`
  return scoped
}

/** A logged request with the namespace taken off its URL. */
function withoutNamespace(logged: unknown, ns: string): unknown {
  const entry = logged as { request?: Record<string, unknown> } & Record<string, unknown>
  const request = (entry.request ?? entry) as Record<string, unknown>
  const strip = (value: unknown) =>
    typeof value === 'string'
      ? value.replace(new RegExp(`^((?:[a-z]+://[^/]+)?)${escapeRegex(ns)}(?=/|$|\\?)`), '$1') ||
        '/'
      : value
  const fixed = { ...request, url: strip(request.url), absoluteUrl: strip(request.absoluteUrl) }
  return entry.request ? { ...entry, request: fixed } : fixed
}
