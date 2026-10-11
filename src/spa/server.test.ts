import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import type { AddressInfo } from 'net'
import { startSpaServer, type SpaServer, type SpaServerOptions } from './server'

interface Received {
  method: string
  url: string
  body: string
}

/** A GET with the path sent exactly as given, so /../x reaches the server unnormalised. */
function get(
  baseUrl: string,
  requestPath: string,
): Promise<{ status: number; body: string; type?: string }> {
  const { hostname, port } = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    http
      .request({ hostname, port, path: requestPath, method: 'GET' }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, type: res.headers['content-type'] }),
        )
      })
      .on('error', reject)
      .end()
  })
}

describe('SPA server (COMPONENT-10)', () => {
  let tmp: string
  let dist: string
  let api: http.Server
  let apiUrl: string
  let received: Received[]
  let spa: SpaServer | null

  const start = async (options: Partial<SpaServerOptions> = {}) => {
    spa = await startSpaServer({ distDir: dist, apiUrl, ...options })
    return spa
  }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-spa-'))
    dist = path.join(tmp, 'dist')
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(dist, 'index.html'), '<html>app</html>')
    fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)')
    fs.mkdirSync(path.join(tmp, 'dist-old'))
    fs.writeFileSync(path.join(tmp, 'dist-old', 'secret.txt'), 'secret')

    api = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', body })
        res.writeHead(201, { 'Content-Type': 'application/json', 'X-Stub': 'yes' })
        res.end('{"ok":true}')
      })
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise((resolve) => api.close(resolve))
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  beforeEach(async () => {
    received = []
    await spa?.close()
    spa = null
    fs.rmSync(path.join(dist, '__env.js'), { force: true })
  })

  it('serves the build, with content types', async () => {
    const { baseUrl } = await start()
    expect(await get(baseUrl, '/')).toMatchObject({ status: 200, body: '<html>app</html>' })
    expect(await get(baseUrl, '/assets/app.js')).toMatchObject({
      status: 200,
      type: 'application/javascript; charset=utf-8',
    })
  })

  it('answers client-side routes and missing files with index.html', async () => {
    const { baseUrl } = await start()
    expect(await get(baseUrl, '/projects/42/settings')).toMatchObject({
      status: 200,
      body: '<html>app</html>',
    })
    expect(await get(baseUrl, '/assets/missing.js')).toMatchObject({
      status: 200,
      body: '<html>app</html>',
    })
  })

  it('refuses paths outside the build, including a sibling folder with the same prefix', async () => {
    const { baseUrl } = await start()
    expect(await get(baseUrl, '/../dist-old/secret.txt')).toMatchObject({ status: 403 })
  })

  it('forwards /api with the prefix stripped by default, body, method and query included', async () => {
    const { baseUrl } = await start()
    const res = await fetch(`${baseUrl}/api/v1/things?page=2`, {
      method: 'POST',
      body: '{"name":"x"}',
    })

    expect(res.status).toBe(201)
    expect(res.headers.get('x-stub')).toBe('yes')
    expect(await res.json()).toEqual({ ok: true })
    expect(received).toEqual([{ method: 'POST', url: '/v1/things?page=2', body: '{"name":"x"}' }])
  })

  it('forwards several prefixes unstripped when asked, and only whole path segments', async () => {
    const { baseUrl } = await start({ proxyPrefixes: ['/rapi', '/wapi'], stripPrefix: false })
    await fetch(`${baseUrl}/rapi/read?day=1`)
    await fetch(`${baseUrl}/wapi`)
    expect(await get(baseUrl, '/rapidly')).toMatchObject({ body: '<html>app</html>' })
    expect(received.map((r) => r.url)).toEqual(['/rapi/read?day=1', '/wapi'])
  })

  it('answers 502 when the API is unreachable', async () => {
    const { baseUrl } = await start({ apiUrl: 'http://127.0.0.1:9' })
    expect(await get(baseUrl, '/api/x')).toMatchObject({
      status: 502,
      body: expect.stringMatching(/^proxy error: /),
    })
  })

  it('writes the runtime config the SPA reads', async () => {
    await start({ runtimeEnv: { VITE_API_BASE_URL: '/api', VITE_TURNSTILE_SITE_KEY: '' } })
    expect(fs.readFileSync(path.join(dist, '__env.js'), 'utf8')).toBe(
      'window.__ENV = {\n  "VITE_API_BASE_URL": "/api",\n  "VITE_TURNSTILE_SITE_KEY": ""\n};\n',
    )
  })

  it('names the build command when there is no build', async () => {
    await expect(
      startSpaServer({
        distDir: path.join(tmp, 'nowhere'),
        apiUrl,
        buildHint: 'npm run build:coverage',
      }),
    ).rejects.toThrow(/index.html is missing\)\. Build it first: npm run build:coverage/)
  })
})
