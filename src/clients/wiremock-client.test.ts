import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import type { AddressInfo } from 'net'
import { WireMockClient, namespaceId, namespaceStub, namespaceUrlMatcher } from './wiremock-client'

interface Recorded {
  method: string
  url: string
  body: unknown
}

// A stand-in for WireMock's admin API: records every request and answers
// with whatever status the test sets.
describe('WireMockClient (COMPONENT-5)', () => {
  let server: http.Server
  let baseUrl: string
  let recorded: Recorded[]
  let status: number

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        recorded.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body: raw ? JSON.parse(raw) : null,
        })
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(req.url === '/__admin/requests/count' ? JSON.stringify({ count: 3 }) : '{}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  beforeEach(() => {
    recorded = []
    status = 200
  })

  it('exposes its base URL', () => {
    expect(new WireMockClient(baseUrl).baseUrl).toBe(baseUrl)
  })

  it('gives up on a stalled WireMock instead of hanging', async () => {
    const stalled = http.createServer(() => {
      /* never responds */
    })
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(stalled.address() as AddressInfo).port}`
    try {
      const started = Date.now()
      await expect(new WireMockClient(url, 200).getRequestCount('/x')).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      stalled.closeAllConnections()
      await new Promise((resolve) => stalled.close(resolve))
    }
  })

  it('throws a configuration error when no URL is set', async () => {
    await expect(new WireMockClient('').resetAll()).rejects.toThrow(/WireMock is not configured/)
  })

  it('reports a missing URL straight away when waiting for WireMock', async () => {
    const started = Date.now()
    await expect(new WireMockClient('').waitForReady(5_000)).rejects.toThrow(
      /WireMock is not configured/,
    )
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('throws when a reset fails rather than carrying on with stale stubs', async () => {
    status = 500
    const client = new WireMockClient(baseUrl)

    await expect(client.resetAll()).rejects.toThrow(/resetAll failed \(500\)/)
    await expect(client.resetRequests()).rejects.toThrow(/resetRequests failed \(500\)/)
    await expect(client.removeStub('abc')).rejects.toThrow(/removeStub failed \(500\)/)
  })

  it('treats removing a stub that is already gone as done', async () => {
    status = 404
    await expect(new WireMockClient(baseUrl).removeStub('gone')).resolves.toBeUndefined()
  })

  it('filters request counts by method when asked', async () => {
    const client = new WireMockClient(baseUrl)

    expect(await client.getRequestCount('/vendor/.*', { method: 'post' })).toBe(3)
    expect(await client.getRequestCount('/vendor/.*')).toBe(3)

    expect(recorded.map((r) => r.body)).toEqual([
      { urlPathPattern: '/vendor/.*', method: 'POST' },
      { urlPathPattern: '/vendor/.*' },
    ])
  })

  it('filters found requests by method too', async () => {
    await new WireMockClient(baseUrl).findRequests('/vendor/.*', { method: 'get' })

    expect(recorded[0]).toMatchObject({
      url: '/__admin/requests/find',
      body: { urlPathPattern: '/vendor/.*', method: 'GET' },
    })
  })

  it('names the method when a filtered call count does not match', async () => {
    await expect(
      new WireMockClient(baseUrl).verifyCallCount('/vendor/.*', 1, { method: 'post' }),
    ).rejects.toThrow('Expected 1 calls to POST /vendor/.*, got 3')
  })

  describe('loadMappingsFromDir', () => {
    let dir: string

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-wiremock-'))
      fs.mkdirSync(path.join(dir, 'mappings'))
    })

    it('imports every mapping in one request, flattening multi-mapping files', async () => {
      const single = { request: { url: '/a' }, response: { status: 200 } }
      const multi = {
        mappings: [
          { request: { url: '/b' }, response: { status: 201 } },
          { request: { url: '/c' }, response: { status: 202 } },
        ],
      }
      fs.writeFileSync(path.join(dir, 'mappings', '1-single.json'), JSON.stringify(single))
      fs.writeFileSync(path.join(dir, 'mappings', '2-multi.json'), JSON.stringify(multi))
      fs.writeFileSync(path.join(dir, 'mappings', 'notes.txt'), 'ignored')

      await new WireMockClient(baseUrl).loadMappingsFromDir(dir)

      expect(recorded).toHaveLength(1)
      expect(recorded[0].url).toBe('/__admin/mappings/import')
      // Sent in reverse, so WireMock gives the last file precedence, as it
      // did when each mapping was POSTed in turn.
      expect(recorded[0].body).toEqual({
        mappings: [single, ...multi.mappings].reverse(),
        importOptions: { duplicatePolicy: 'OVERWRITE', deleteAllNotInImport: false },
      })
    })

    it('sends nothing when the directory has no mappings', async () => {
      await new WireMockClient(baseUrl).loadMappingsFromDir(dir)
      await new WireMockClient(baseUrl).loadMappingsFromDir(path.join(dir, 'missing'))

      expect(recorded).toHaveLength(0)
    })

    it('reports a failed import', async () => {
      fs.writeFileSync(path.join(dir, 'mappings', 'a.json'), JSON.stringify({ request: {} }))
      status = 422

      await expect(new WireMockClient(baseUrl).loadMappingsFromDir(dir)).rejects.toThrow(
        /importStubs failed \(422\).*mappings from/,
      )
    })

    it('names the file that is not valid JSON', async () => {
      fs.writeFileSync(path.join(dir, 'mappings', 'broken.json'), '{ not json')

      await expect(new WireMockClient(baseUrl).loadMappingsFromDir(dir)).rejects.toThrow(
        /broken\.json is not valid JSON/,
      )
      expect(recorded).toHaveLength(0)
    })
  })
})

describe('a namespaced client', () => {
  const ns = '/__worker-2'

  it('moves each kind of URL matcher under the namespace', () => {
    expect(namespaceUrlMatcher({ url: '/a?b=1' }, ns)).toEqual({ url: '/__worker-2/a?b=1' })
    expect(namespaceUrlMatcher({ urlPath: '/a' }, ns)).toEqual({ urlPath: '/__worker-2/a' })
    expect(namespaceUrlMatcher({ urlPathTemplate: '/a/{id}' }, ns)).toEqual({
      urlPathTemplate: '/__worker-2/a/{id}',
    })
    expect(namespaceUrlMatcher({ method: 'GET' }, ns)).toEqual({
      urlPathPattern: '/__worker-2(/.*)?',
    })
  })

  // WireMock matches a pattern against the whole path, as these do.
  const matches = (pattern: string, ns: string, path: string) =>
    new RegExp(
      `^(?:${Object.values(namespaceUrlMatcher({ urlPathPattern: pattern }, ns))[0]})$`,
    ).test(path)

  it('keeps a regex pattern inside its namespace', () => {
    expect(matches('/a/.*', ns, '/__worker-2/a/x')).toBe(true)
    expect(matches('/a/.*', ns, '/a/x')).toBe(false)
    expect(matches('^/a/.*', ns, '/__worker-2/a/x')).toBe(true)
    expect(matches('.*', ns, '/__worker-2/anything')).toBe(true)
    expect(matches('/a\\?.*', ns, '/__worker-2/a?b=1')).toBe(true)
  })

  it("doesn't let a top-level alternation reach outside the namespace", () => {
    expect(matches('/a|/b', ns, '/__worker-2/b')).toBe(true)
    expect(matches('/a|/b', ns, '/b')).toBe(false)
    expect(matches('/a|/b', ns, '/__worker-3/b')).toBe(false)
  })

  it("doesn't let worker 1's pattern match worker 10's paths", () => {
    expect(matches('.*/items', '/__worker-1', '/__worker-1/items')).toBe(true)
    expect(matches('.*/items', '/__worker-1', '/__worker-10/items')).toBe(false)
    expect(matches('.*', '/__worker-1', '/__worker-10/items')).toBe(false)
  })

  it("gives a stub a namespaced id and scenario, and marks it as the namespace's", () => {
    const stub = {
      id: '8c5db8b0-2db4-4ad7-a99f-38c9b00da3f7',
      scenarioName: 'checkout',
      request: { method: 'GET', urlPath: '/a', headers: { X: { equalTo: '1' } } },
      response: { status: 200 },
      metadata: { owner: 'suite' },
    }
    const scoped = namespaceStub(stub, ns)
    expect(scoped).toEqual({
      id: namespaceId(stub.id, ns),
      scenarioName: '/__worker-2:checkout',
      request: { method: 'GET', urlPath: '/__worker-2/a', headers: { X: { equalTo: '1' } } },
      response: { status: 200 },
      metadata: { owner: 'suite', componentTestNamespace: ns },
    })
    expect(namespaceId(stub.id, ns)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(namespaceId(stub.id, ns)).not.toBe(namespaceId(stub.id, '/__worker-3'))
  })

  it('registers, counts, finds and resets only under its namespace', async () => {
    const calls: { url: string; method: string; body: unknown }[] = []
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url: url.replace('http://wm', ''),
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      })
      const body = url.endsWith('/find')
        ? {
            requests: [
              {
                request: {
                  url: '/__worker-2/orders?id=1',
                  absoluteUrl: 'http://wm/__worker-2/orders?id=1',
                },
              },
            ],
          }
        : { count: 3 }
      return new Response(JSON.stringify(body), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const client = new WireMockClient('http://wm', 1_000, { namespace: ns })
      await client.addStub({ request: { urlPath: '/orders' }, response: { status: 200 } })
      expect(await client.getRequestCount('/orders/.*', { method: 'post' })).toBe(3)
      expect(await client.findRequests('/orders', { exactPath: true })).toEqual([
        { request: { url: '/orders?id=1', absoluteUrl: 'http://wm/orders?id=1' } },
      ])
      await client.resetAll()
      await client.removeStub('8c5db8b0-2db4-4ad7-a99f-38c9b00da3f7')

      expect(calls).toEqual([
        {
          url: '/__admin/mappings',
          method: 'POST',
          body: {
            request: { urlPath: '/__worker-2/orders' },
            response: { status: 200 },
            metadata: { componentTestNamespace: ns },
          },
        },
        {
          url: '/__admin/requests/count',
          method: 'POST',
          body: { urlPathPattern: '/__worker-2(?=/|$|\\?)(?:/orders/.*)', method: 'POST' },
        },
        { url: '/__admin/requests/find', method: 'POST', body: { urlPath: '/__worker-2/orders' } },
        {
          url: '/__admin/mappings/remove-by-metadata',
          method: 'POST',
          body: { matchesJsonPath: { expression: '$.componentTestNamespace', equalTo: ns } },
        },
        {
          url: '/__admin/requests/remove',
          method: 'POST',
          body: { urlPathPattern: '/__worker-2(/.*)?' },
        },
        {
          url: `/__admin/mappings/${namespaceId('8c5db8b0-2db4-4ad7-a99f-38c9b00da3f7', ns)}`,
          method: 'DELETE',
          body: undefined,
        },
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
