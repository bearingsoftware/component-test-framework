import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import type { AddressInfo } from 'net'
import { WireMockClient } from './wiremock-client'

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

  it('throws a configuration error when no URL is set', async () => {
    await expect(new WireMockClient('').resetAll()).rejects.toThrow(/WireMock is not configured/)
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
      expect(recorded[0].body).toEqual({
        mappings: [single, ...multi.mappings],
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
        /importStubs failed \(422\)/,
      )
    })
  })
})
