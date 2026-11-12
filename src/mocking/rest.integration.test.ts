import { describe, it, expect, beforeEach } from 'vitest'
import { WireMockClient } from '../clients/wiremock-client'
import { stub } from './rest'

// Against a real WireMock; skipped without WIREMOCK_URL. Each file keeps to
// its own path prefix, so test files running at once don't reset each other.
const url = process.env.WIREMOCK_URL ?? ''
const NS = '/__rest-it'

describe.skipIf(!url)('REST stub builder against WireMock (COMPONENT-23)', () => {
  const client = new WireMockClient(url, undefined, { namespace: NS })
  const call = (path: string, init?: RequestInit) => fetch(`${url}${NS}${path}`, init)
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  beforeEach(() => client.resetAll())

  it('serves a JSON response with headers', async () => {
    await client.register(
      stub.post('/orders').willReturn(201, { id: 'o1' }, { Location: '/orders/o1' }),
    )
    const res = await post('/orders', {})
    expect(res.status).toBe(201)
    expect(res.headers.get('location')).toBe('/orders/o1')
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ id: 'o1' })
  })

  it('matches the method', async () => {
    await client.register(stub.get('/m').willReturnStatus(200))
    expect((await call('/m')).status).toBe(200)
    expect((await post('/m', {})).status).toBe(404)
    await client.register(stub.any('/any').willReturnStatus(200))
    expect((await post('/any', {})).status).toBe(200)
    expect((await call('/any')).status).toBe(200)
  })

  it('matches a JSON body partially', async () => {
    await client.register(
      stub
        .post('/o')
        .withJsonBody({ sku: 'W', opts: [1, 2] })
        .willReturnStatus(201),
    )
    expect((await post('/o', { sku: 'W', opts: [1, 2], extra: true })).status).toBe(201)
    expect((await post('/o', { sku: 'X', opts: [1, 2] })).status).toBe(404)
    expect((await post('/o', { sku: 'W', opts: [2, 1] })).status).toBe(404)
    expect((await post('/o', { sku: 'W' })).status).toBe(404)
  })

  it('matches query strings exactly and by regex', async () => {
    await client.register(
      stub
        .get('/q')
        .withQuery({ page: '2', sort: /^(asc|desc)$/ })
        .willReturnStatus(200),
    )
    expect((await call('/q?page=2&sort=asc&other=1')).status).toBe(200)
    expect((await call('/q?page=3&sort=asc')).status).toBe(404)
    expect((await call('/q?page=2&sort=up')).status).toBe(404)
    expect((await call('/q?page=2')).status).toBe(404)
  })

  it('matches headers exactly and by regex, as JavaScript would', async () => {
    await client.register(
      stub
        .get('/h')
        .withHeader('Authorization', /^Bearer /)
        .withHeader('X-Kind', 'a')
        .willReturnStatus(200),
    )
    const get = (headers: Record<string, string>) => call('/h', { headers })
    expect((await get({ Authorization: 'Bearer abc', 'X-Kind': 'a' })).status).toBe(200)
    expect((await get({ Authorization: 'Basic abc', 'X-Kind': 'a' })).status).toBe(404)
    expect((await get({ Authorization: 'X Bearer abc', 'X-Kind': 'a' })).status).toBe(404)
    expect((await get({ Authorization: 'Bearer abc', 'X-Kind': 'b' })).status).toBe(404)
  })

  it('delays the response', async () => {
    await client.register(stub.get('/d').withDelay(300).willReturnStatus(200))
    const started = Date.now()
    await call('/d')
    expect(Date.now() - started).toBeGreaterThanOrEqual(290)
  })

  it('lets the lower priority number win, and a path pattern match many paths', async () => {
    await client.register(
      stub.any('/p/.*').pathPattern().priority(1).willReturnStatus(500),
      stub.get('/p/ok').willReturnStatus(200),
    )
    expect((await call('/p/ok')).status).toBe(500)
    expect((await call('/p/other')).status).toBe(500)
  })

  it('moves through a scenario', async () => {
    await client.register(
      stub.get('/s').inScenario('flow', 'Started', 'Second').willReturn(200, { n: 1 }),
      stub.get('/s').inScenario('flow', 'Second').willReturn(200, { n: 2 }),
    )
    expect(await (await call('/s')).json()).toEqual({ n: 1 })
    expect(await (await call('/s')).json()).toEqual({ n: 2 })
    expect(await (await call('/s')).json()).toEqual({ n: 2 })
    expect(await client.getScenarioState('flow')).toBe('Second')
  })

  it('serves a text body with its content type', async () => {
    await client.register(stub.get('/t').willReturnBody(200, 'plain', 'text/plain'))
    const res = await call('/t')
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe('plain')
  })
})
