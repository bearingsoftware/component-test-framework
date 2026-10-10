import * as fs from 'fs'
import * as path from 'path'

/** Filters for {@link WireMockClient.getRequestCount} and {@link WireMockClient.findRequests}. */
export interface RequestFilter {
  /** Only match requests with this HTTP method, e.g. "POST". Matches any method when omitted. */
  method?: string
}

/**
 * Client for WireMock's Admin API (/__admin/).
 * Manages stub mappings, resets state, and verifies request counts.
 *
 * An empty `baseUrl` means WireMock isn't configured. The client can still be
 * constructed, but every call throws and says how to configure it.
 */
export class WireMockClient {
  constructor(readonly baseUrl: string) {}

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

  /** Reset all stubs and request logs. */
  async resetAll(): Promise<void> {
    const res = await fetch(this.url('/__admin/reset'), { method: 'POST' })
    await this.expectOk(res, 'resetAll')
  }

  /** Reset only the request journal (keep stubs). */
  async resetRequests(): Promise<void> {
    const res = await fetch(this.url('/__admin/requests'), { method: 'DELETE' })
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
    const res = await fetch(this.url('/__admin/mappings/import'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // When two stubs have the same priority, WireMock serves the one added
        // most recently. One POST at a time, that's the last one; an import
        // gives precedence to the first. Reversing keeps "last one wins".
        mappings: [...mappings].reverse(),
        importOptions: { duplicatePolicy: 'OVERWRITE', deleteAllNotInImport: false },
      }),
    })
    await this.expectOk(res, 'importStubs')
  }

  /** Register a single stub mapping. */
  async addStub(mapping: Record<string, unknown>): Promise<void> {
    const res = await fetch(this.url('/__admin/mappings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mapping),
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
        const res = await fetch(healthUrl)
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
    const res = await fetch(this.url(`/__admin/mappings/${id}`), { method: 'DELETE' })
    // Removing a stub that's already gone is not an error.
    if (res.status === 404) return
    await this.expectOk(res, 'removeStub')
  }

  /** Get the count of requests matching a URL path pattern, optionally filtered by method. */
  async getRequestCount(urlPathPattern: string, filter: RequestFilter = {}): Promise<number> {
    const res = await fetch(this.url('/__admin/requests/count'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPattern(urlPathPattern, filter)),
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
      const target = filter.method
        ? `${filter.method.toUpperCase()} ${urlPathPattern}`
        : urlPathPattern
      throw new Error(`Expected ${expectedCount} calls to ${target}, got ${actual}`)
    }
  }

  /** Find all requests matching a URL path pattern, optionally filtered by method. */
  async findRequests(urlPathPattern: string, filter: RequestFilter = {}): Promise<unknown[]> {
    const res = await fetch(this.url('/__admin/requests/find'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPattern(urlPathPattern, filter)),
    })
    if (!res.ok) {
      throw new Error(`WireMock find requests failed: ${res.status}`)
    }
    const data = (await res.json()) as { requests: unknown[] }
    return data.requests
  }
}

function requestPattern(urlPathPattern: string, filter: RequestFilter): Record<string, string> {
  return filter.method
    ? { urlPathPattern, method: filter.method.toUpperCase() }
    : { urlPathPattern }
}
