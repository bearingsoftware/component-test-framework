/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { WireMockClient } from './wiremock-client'
import { stub } from '../mocking/rest'
import { graphql } from '../mocking/graphql'

const calls: { url: string; body: any }[] = []

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ count: 2 }), { status: 200 })
  }),
)

afterEach(() => {
  calls.length = 0
})

describe('WireMockClient.register and graphqlRequestCount (COMPONENT-23)', () => {
  const client = new WireMockClient('http://wm', undefined, { namespace: '/__worker-1' })

  it('adds one stub directly, namespaced', async () => {
    await client.register(stub.get('/a').willReturnStatus(200))
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://wm/__admin/mappings')
    expect(calls[0].body.request.urlPath).toBe('/__worker-1/a')
  })

  it('imports several in one request, builders and mappings mixed', async () => {
    await client.register(stub.get('/a').willReturnStatus(200), {
      request: { urlPath: '/b' },
      response: { status: 200 },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://wm/__admin/mappings/import')
    expect(
      calls[0].body.mappings.map((m: { request: { urlPath: string } }) => m.request.urlPath),
    ).toEqual(['/__worker-1/b', '/__worker-1/a'])
  })

  it('registers a GraphQL builder', async () => {
    await client.register(graphql.endpoint().query('q').willReturnData({}))
    expect(calls[0].body.request.urlPath).toBe('/__worker-1/graphql')
  })

  it('counts GraphQL requests with the operation body patterns under the namespace', async () => {
    expect(await client.graphqlRequestCount('/v1/graphql/', 'q', { kind: 'query' })).toBe(2)
    expect(calls[0].url).toBe('http://wm/__admin/requests/count')
    expect(calls[0].body).toMatchObject({
      method: 'POST',
      urlPath: '/__worker-1/v1/graphql/',
      bodyPatterns: [{ or: [expect.anything(), expect.anything()] }],
    })
  })
})
