import { describe, it, expect, afterEach } from 'vitest'
import * as dgram from 'dgram'
import * as http from 'http'
import * as https from 'https'
import * as net from 'net'
import { startCaptureServer } from './capture-server'
import type { CaptureServer } from './capture-server'

const started: CaptureServer[] = []
const start = async (...args: Parameters<typeof startCaptureServer>) => {
  const s = await startCaptureServer(...args)
  started.push(s)
  return s
}
afterEach(async () => {
  for (const s of started.splice(0)) await s.stop()
})

interface Reply {
  status: number
  body: string
}

function call(
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string>; ca?: string } = {},
): Promise<Reply> {
  const mod = url.startsWith('https') ? https : http
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      { method: init.method ?? 'GET', headers: init.headers, ca: init.ca, agent: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (d: Buffer) => chunks.push(d))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        )
      },
    )
    req.on('error', reject)
    req.end(init.body)
  })
}

const eventuallyHas = async (s: CaptureServer, n: number) => {
  for (let i = 0; i < 100 && s.requests().length < n; i++)
    await new Promise((r) => setTimeout(r, 20))
}

describe('http', () => {
  it('records the request and answers 200 by default', async () => {
    const s = await start({ kind: 'http' })
    expect(s.port).toBeGreaterThan(0)
    expect(s.url).toBe(`http://127.0.0.1:${s.port}`)
    const r = await call(`${s.url}/hook?a=1&b=two`, {
      method: 'POST',
      body: '{"n":1}',
      headers: { 'content-type': 'application/json', 'x-key': 'k' },
    })
    expect(r.status).toBe(200)
    const [got] = s.requests()
    expect(got).toMatchObject({
      method: 'POST',
      path: '/hook',
      query: { a: '1', b: 'two' },
      text: '{"n":1}',
      json: { n: 1 },
    })
    expect(got.headers?.['x-key']).toBe('k')
    expect(got.body.toString()).toBe('{"n":1}')
    expect(s.requests({ path: '/other' })).toEqual([])
    s.reset()
    expect(s.requests()).toEqual([])
  })

  it('answers a status with a body and headers', async () => {
    const s = await start({ kind: 'http' })
    s.script({ respond: [{ status: 418, body: 'tea', headers: { 'x-a': 'b' } }] })
    const r = await call(`${s.url}/`)
    expect(r).toEqual({ status: 418, body: 'tea' })
  })

  it('consumes a response list in order, then falls through', async () => {
    const s = await start({ kind: 'http' })
    s.script({ match: { path: '/x' }, respond: [503, 500, 204] })
    const seen = []
    for (let i = 0; i < 4; i++) seen.push((await call(`${s.url}/x`)).status)
    expect(seen).toEqual([503, 500, 204, 200])
  })

  it('repeats a bare status until reset', async () => {
    const s = await start({ kind: 'http' })
    s.script({ respond: 429 })
    expect((await call(s.url)).status).toBe(429)
    expect((await call(s.url)).status).toBe(429)
    s.reset()
    expect((await call(s.url)).status).toBe(200)
  })

  it('spends a one-shot rule only on a matching request, among concurrent others', async () => {
    const s = await start({ kind: 'http' })
    s.script({ match: { path: '/target', header: { 'x-key': 'mine' } }, respond: 503, once: true })
    const noise = Array.from({ length: 20 }, (_, i) =>
      call(`${s.url}/other${i}`, { headers: { 'x-key': 'mine' } }),
    )
    const noisy = await Promise.all([
      ...noise,
      call(`${s.url}/target`, { headers: { 'x-key': 'theirs' } }),
    ])
    expect(noisy.every((r) => r.status === 200)).toBe(true)
    const first = await call(`${s.url}/target`, { headers: { 'x-key': 'mine' } })
    const second = await call(`${s.url}/target`, { headers: { 'x-key': 'mine' } })
    expect([first.status, second.status]).toEqual([503, 200])
  })

  it('matches on method, query and body', async () => {
    const s = await start({ kind: 'http' })
    s.script({
      match: { method: 'POST', query: { q: '1' }, bodyIncludes: 'needle' },
      respond: 202,
    })
    expect((await call(`${s.url}/?q=1`, { method: 'POST', body: 'a needle b' })).status).toBe(202)
    expect((await call(`${s.url}/?q=1`, { method: 'POST', body: 'hay' })).status).toBe(200)
    expect((await call(`${s.url}/?q=2`, { method: 'POST', body: 'needle' })).status).toBe(200)
    expect((await call(`${s.url}/?q=1`, { method: 'PUT', body: 'needle' })).status).toBe(200)
  })

  it('refuses connections when down, and serves again on the same port when up', async () => {
    const s = await start({ kind: 'http' })
    const { port } = s
    await s.down()
    await expect(call(`http://127.0.0.1:${port}/`)).rejects.toThrow(/ECONNREFUSED/)
    await s.up()
    expect(s.port).toBe(port)
    expect((await call(s.url)).status).toBe(200)
  })

  it('uses the port from portEnv, then port, and starts on an ephemeral one otherwise', async () => {
    const probe = await start({ kind: 'http' })
    const free = probe.port
    await probe.stop()
    process.env.CTF_TEST_STUB_PORT = String(free)
    try {
      const s = await start({ kind: 'http', portEnv: 'CTF_TEST_STUB_PORT', port: 1 })
      expect(s.port).toBe(free)
    } finally {
      delete process.env.CTF_TEST_STUB_PORT
    }
  })

  it('rejects a bad port and tls on a plain kind', async () => {
    await expect(startCaptureServer({ kind: 'http', port: 70000 })).rejects.toThrow(/invalid/)
    await expect(startCaptureServer({ kind: 'tcp', tls: 'self-signed' })).rejects.toThrow(/https/)
  })
})

describe('https', () => {
  it('serves a self-signed certificate the caller can trust', async () => {
    const s = await start({ kind: 'https', tls: 'self-signed' })
    expect(s.url.startsWith('https://')).toBe(true)
    expect(s.ca).toContain('BEGIN CERTIFICATE')
    s.script({ respond: 201 })
    const r = await call(`${s.url}/x`, { method: 'POST', body: 'hi', ca: s.ca })
    expect(r.status).toBe(201)
    expect(s.requests()[0]).toMatchObject({ path: '/x', text: 'hi' })
    await expect(call(`${s.url}/x`)).rejects.toThrow()
  })
})

describe('tcp', () => {
  it('records what is written and goes down and up', async () => {
    const s = await start({ kind: 'tcp' })
    const send = (text: string) =>
      new Promise<void>((resolve, reject) => {
        const c = net.connect(s.port, '127.0.0.1', () => c.end(text, () => resolve()))
        c.on('error', reject)
      })
    await send('<14>one')
    await eventuallyHas(s, 1)
    expect(s.requests()).toHaveLength(1)
    expect(s.requests({ bodyIncludes: 'one' })[0].text).toBe('<14>one')
    expect(s.requests()[0].path).toBeUndefined()
    await s.down()
    await expect(send('x')).rejects.toThrow(/ECONNREFUSED/)
    await s.up()
    await send('<14>two')
    await eventuallyHas(s, 2)
    expect(s.requests({ bodyIncludes: 'two' })).toHaveLength(1)
    expect(() => s.script({ respond: 200 })).toThrow(/never replies/)
  })
})

describe('udp', () => {
  it('records datagrams', async () => {
    const s = await start({ kind: 'udp' })
    expect(s.url).toBe(`udp://127.0.0.1:${s.port}`)
    const client = dgram.createSocket('udp4')
    await new Promise<void>((resolve, reject) =>
      client.send('<14>hello', s.port, '127.0.0.1', (err) => (err ? reject(err) : resolve())),
    )
    client.close()
    await eventuallyHas(s, 1)
    expect(s.requests()[0].text).toBe('<14>hello')
    await s.down()
    await s.up()
    const again = dgram.createSocket('udp4')
    await new Promise<void>((resolve, reject) =>
      again.send('<14>after', s.port, '127.0.0.1', (err) => (err ? reject(err) : resolve())),
    )
    again.close()
    await eventuallyHas(s, 2)
    expect(s.requests({ bodyIncludes: 'after' })).toHaveLength(1)
  })
})
