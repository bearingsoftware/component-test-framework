import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import * as net from 'net'
import type { AddressInfo } from 'net'
type HookFn = (this: unknown) => unknown
// Capture registerSpaServer's hooks so a test can run them.
const hooks = vi.hoisted(() => ({ beforeAll: [] as HookFn[], afterAll: [] as HookFn[] }))
vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  return {
    ...actual,
    BeforeAll: (_options: unknown, fn: HookFn) => void hooks.beforeAll.push(fn),
    AfterAll: (_options: unknown, fn: HookFn) => void hooks.afterAll.push(fn),
  }
})

import { registerSpaServer, startSpaServer, type SpaServer, type SpaServerOptions } from './server'

interface Received {
  method: string
  url: string
  body: string
}

interface Got {
  status: number
  body: string
  type?: string
  /** False when the connection was cut before the response ended. */
  complete: boolean
}

/** A GET with the path sent exactly as given, so /../x reaches the server unnormalised. */
function get(baseUrl: string, requestPath: string): Promise<Got> {
  const { hostname, port } = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    http
      .request({ hostname, port, path: requestPath, method: 'GET' }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('error', () => {})
        res.on('close', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            type: res.headers['content-type'],
            complete: res.complete,
          }),
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

  it('answers client-side routes with index.html, and a missing asset with a 404', async () => {
    const { baseUrl } = await start()
    expect(await get(baseUrl, '/projects/42/settings')).toMatchObject({
      status: 200,
      body: '<html>app</html>',
    })
    // As deployed: a missing asset is a 404, so a test can see the build never emitted it.
    expect(await get(baseUrl, '/assets/missing.js')).toMatchObject({ status: 404 })
    expect(await get(baseUrl, '/assets/maplibre-gl-worker.mjs')).toMatchObject({ status: 404 })
  })

  it('answers a browser navigation with index.html even when the path looks like a file', async () => {
    const { baseUrl } = await start()
    const res = await fetch(`${baseUrl}/releases/v1.2`, { headers: { Accept: 'text/html' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>app</html>')
    expect((await fetch(`${baseUrl}/releases/v1.2`)).status).toBe(404)
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

  it('forwards a bare prefix with a query string as a path', async () => {
    const { baseUrl } = await start()
    await fetch(`${baseUrl}/api?x=1`)
    await fetch(`${baseUrl}/api`)
    expect(received.map((r) => r.url)).toEqual(['/?x=1', '/'])
  })

  it('treats a prefix with a trailing slash like one without', async () => {
    const { baseUrl } = await start({ proxyPrefixes: ['/auth/'], stripPrefix: false })
    await fetch(`${baseUrl}/auth/login`)
    expect(received.map((r) => r.url)).toEqual(['/auth/login'])
  })

  it('decodes file names, and still refuses encoded paths out of the build', async () => {
    fs.writeFileSync(path.join(dist, 'assets', 'my file.txt'), 'spaced')
    const { baseUrl } = await start()
    expect(await get(baseUrl, '/assets/my%20file.txt')).toMatchObject({
      status: 200,
      body: 'spaced',
      type: 'text/plain; charset=utf-8',
    })
    expect(await get(baseUrl, '/..%2fdist-old/secret.txt')).toMatchObject({ status: 403 })
    expect(await get(baseUrl, '/%E0%A4%A')).toMatchObject({ status: 400 })
  })

  it('drops the browser connection when the API drops mid-response', async () => {
    const dropping = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.write('partial')
      setTimeout(() => res.socket?.destroy(), 50)
    })
    await new Promise<void>((resolve) => dropping.listen(0, '127.0.0.1', resolve))
    const { baseUrl } = await start({
      apiUrl: `http://127.0.0.1:${(dropping.address() as AddressInfo).port}`,
    })
    try {
      expect(await get(baseUrl, '/api/stream')).toMatchObject({ body: 'partial', complete: false })
    } finally {
      dropping.closeAllConnections()
      await new Promise((resolve) => dropping.close(resolve))
    }
  })

  it('closes promptly while a proxied stream is still open', async () => {
    const streaming = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: hello\n\n')
    })
    await new Promise<void>((resolve) => streaming.listen(0, '127.0.0.1', resolve))
    const server = await startSpaServer({
      distDir: dist,
      apiUrl: `http://127.0.0.1:${(streaming.address() as AddressInfo).port}`,
    })
    const req = http.get(`${server.baseUrl}/api/events`)
    req.on('error', () => {})
    await new Promise((resolve) => req.on('response', resolve))
    const started = Date.now()
    await server.close()
    expect(Date.now() - started).toBeLessThan(1_000)
    streaming.closeAllConnections()
    await new Promise((resolve) => streaming.close(resolve))
  })

  it('answers 502 when the API is unreachable', async () => {
    const { baseUrl } = await start({ apiUrl: 'http://127.0.0.1:9' })
    expect(await get(baseUrl, '/api/x')).toMatchObject({
      status: 502,
      body: expect.stringMatching(/^proxy error: /),
    })
  })

  it('serves the runtime config the SPA reads, without writing it into the build', async () => {
    const { baseUrl } = await start({
      runtimeEnv: { VITE_API_BASE_URL: '/api', VITE_TURNSTILE_SITE_KEY: '' },
    })
    expect(await get(baseUrl, '/__env.js')).toMatchObject({
      status: 200,
      type: 'application/javascript; charset=utf-8',
      body: 'window.__ENV = {\n  "VITE_API_BASE_URL": "/api",\n  "VITE_TURNSTILE_SITE_KEY": ""\n};\n',
    })
    expect(fs.existsSync(path.join(dist, '__env.js'))).toBe(false)
  })

  it('puts the path in apiUrl in front of forwarded paths, and takes it off redirects', async () => {
    const seen: string[] = []
    const prefixed = http.createServer((req, res) => {
      seen.push(req.url ?? '')
      const self = `http://127.0.0.1:${(prefixed.address() as AddressInfo).port}`
      if (req.url?.endsWith('/start'))
        res.writeHead(302, { Location: `${self}/__worker-2/v1/next` })
      else res.writeHead(200)
      res.end()
    })
    await new Promise<void>((resolve) => prefixed.listen(0, '127.0.0.1', resolve))
    const { baseUrl } = await start({
      apiUrl: `http://127.0.0.1:${(prefixed.address() as AddressInfo).port}/__worker-2/`,
    })
    try {
      await fetch(`${baseUrl}/api/v1/items?x=1`)
      const redirect = await fetch(`${baseUrl}/api/v1/start`, { redirect: 'manual' })
      expect(seen).toEqual(['/__worker-2/v1/items?x=1', '/__worker-2/v1/start'])
      expect(redirect.headers.get('location')).toBe('/api/v1/next')
    } finally {
      await new Promise((resolve) => prefixed.close(resolve))
    }
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

  it('needs a fixed port to register, since its base URL is known up front', () => {
    expect(() => registerSpaServer({ distDir: dist, apiUrl, defaultPort: 0 })).toThrow(
      /registerSpaServer needs a fixed port/,
    )
  })

  it('ends the upstream request when the browser gives up on it', async () => {
    let upstreamClosed = false
    const streaming = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: hello\n\n')
      req.socket.on('close', () => (upstreamClosed = true))
    })
    await new Promise<void>((resolve) => streaming.listen(0, '127.0.0.1', resolve))
    const { baseUrl } = await start({
      apiUrl: `http://127.0.0.1:${(streaming.address() as AddressInfo).port}`,
    })
    try {
      const req = http.get(`${baseUrl}/api/events`)
      req.on('error', () => {})
      await new Promise((resolve) => req.on('response', resolve))
      req.destroy()
      const deadline = Date.now() + 2_000
      while (!upstreamClosed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      expect(upstreamClosed).toBe(true)
    } finally {
      streaming.closeAllConnections()
      await new Promise((resolve) => streaming.close(resolve))
    }
  })

  it('ends open upstream requests when it stops', async () => {
    let upstreamClosed = false
    const streaming = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: hello\n\n')
      req.socket.on('close', () => (upstreamClosed = true))
    })
    await new Promise<void>((resolve) => streaming.listen(0, '127.0.0.1', resolve))
    const server = await startSpaServer({
      distDir: dist,
      apiUrl: `http://127.0.0.1:${(streaming.address() as AddressInfo).port}`,
    })
    try {
      const req = http.get(`${server.baseUrl}/api/events`)
      req.on('error', () => {})
      await new Promise((resolve) => req.on('response', resolve))
      await server.close()
      const deadline = Date.now() + 2_000
      while (!upstreamClosed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      expect(upstreamClosed).toBe(true)
    } finally {
      streaming.closeAllConnections()
      await new Promise((resolve) => streaming.close(resolve))
    }
  })

  it('does not pass on connection-level headers, either way', async () => {
    let seen: http.IncomingHttpHeaders = {}
    const echo = http.createServer((req, res) => {
      seen = req.headers
      // Node adds its own Keep-Alive to keep-alive responses, so the check uses a
      // header the upstream names as connection-level.
      res.writeHead(200, {
        Connection: 'X-Upstream-Private',
        'X-Upstream-Private': '1',
        'X-Stub': 'yes',
      })
      res.end('ok')
    })
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    const { baseUrl } = await start({
      apiUrl: `http://127.0.0.1:${(echo.address() as AddressInfo).port}`,
    })
    try {
      const { hostname, port } = new URL(baseUrl)
      const response = await new Promise<http.IncomingMessage>((resolve, reject) =>
        http
          .request(
            {
              hostname,
              port,
              path: '/api/x',
              headers: { Connection: 'keep-alive, X-Private', 'X-Private': '1', 'X-Kept': '1' },
            },
            resolve,
          )
          .on('error', reject)
          .end(),
      )
      response.resume()
      expect(seen['x-private']).toBeUndefined()
      expect(seen['x-kept']).toBe('1')
      expect(response.headers['x-upstream-private']).toBeUndefined()
      expect(response.headers['x-stub']).toBe('yes')
    } finally {
      echo.closeAllConnections()
      await new Promise((resolve) => echo.close(resolve))
    }
  })

  it("points the API's own redirects back through the server", async () => {
    const redirecting = http.createServer((req, res) => {
      const self = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`
      const to = req.url === '/elsewhere' ? 'https://example.com/x' : `${self}/v1/next?page=2`
      res.writeHead(302, { Location: to })
      res.end()
    })
    await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve))
    const apiUrl = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`
    const { baseUrl } = await start({ apiUrl })
    try {
      const own = await fetch(`${baseUrl}/api/v1/start`, { redirect: 'manual' })
      expect(own.headers.get('location')).toBe('/api/v1/next?page=2')
      const other = await fetch(`${baseUrl}/api/elsewhere`, { redirect: 'manual' })
      expect(other.headers.get('location')).toBe('https://example.com/x')
    } finally {
      await new Promise((resolve) => redirecting.close(resolve))
    }
  })

  it('answers a WebSocket upgrade with 501 instead of hanging', async () => {
    const { baseUrl } = await start()
    const { hostname, port } = new URL(baseUrl)
    const status = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(port), hostname, () => {
        socket.write(
          'GET /api/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        )
      })
      socket.on('data', (data: Buffer) => resolve(data.toString().split('\r\n')[0]))
      socket.on('error', reject)
    })
    expect(status).toBe('HTTP/1.1 501 Not Implemented')
  })

  it('rejects a runtimeEnvGlobal that is not an identifier', async () => {
    await expect(
      start({ runtimeEnv: { A: '1' }, runtimeEnvGlobal: 'x; alert(1)' }),
    ).rejects.toThrow(/runtimeEnvGlobal must be a JavaScript identifier/)
  })

  it('registers hooks that start and stop the server on the configured port, and explains a port in use', async () => {
    hooks.beforeAll.length = 0
    hooks.afterAll.length = 0
    const blocker = http.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, resolve))
    const busyPort = (blocker.address() as AddressInfo).port
    try {
      const busy = registerSpaServer({
        distDir: dist,
        apiUrl,
        portEnvVar: 'CTF_TEST_PORT',
        defaultPort: busyPort,
      })
      expect(busy).toEqual({ port: busyPort, baseUrl: `http://localhost:${busyPort}` })
      await expect(hooks.beforeAll[0].call({})).rejects.toThrow(
        `Port ${busyPort} is in use (CTF_TEST_PORT). Is another run still going?`,
      )
    } finally {
      await new Promise((resolve) => blocker.close(resolve))
    }
    await hooks.beforeAll[0].call({})
    expect((await get(`http://localhost:${busyPort}`, '/')).status).toBe(200)
    await hooks.afterAll[0].call({})
    await expect(get(`http://localhost:${busyPort}`, '/')).rejects.toThrow()
  })

  it('listens on the port plus the worker number under --parallel', () => {
    Object.assign(process.env, {
      CUCUMBER_PARALLEL: 'true',
      CUCUMBER_WORKER_ID: '3',
      CUCUMBER_TOTAL_WORKERS: '4',
    })
    try {
      expect(registerSpaServer({ distDir: dist, apiUrl, defaultPort: 4100 })).toEqual({
        port: 4103,
        baseUrl: 'http://localhost:4103',
      })
    } finally {
      delete process.env.CUCUMBER_PARALLEL
      delete process.env.CUCUMBER_WORKER_ID
      delete process.env.CUCUMBER_TOTAL_WORKERS
    }
  })
})
