/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { WireMockClient } from './wiremock-client'
import { graphql } from '../mocking/graphql'

const calls: { url: string; text: string }[] = []

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, text: String(init?.body) })
      return new Response('{}', { status: 200 })
    }),
  )
})
afterEach(() => {
  calls.length = 0
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const price = (path: string) => ({
  request: { method: 'GET', urlPath: path },
  response: { status: 200, jsonBody: { price: 1 } },
})

describe('fault injection in WireMockClient (COMPONENT-30)', () => {
  it('posts exactly the mappings it is given when CTF_FAULT is unset', async () => {
    const mappings = [price('/a'), price('/b')]
    const expected = JSON.stringify(price('/a'))
    for (const options of [{}, { namespace: '/__worker-1' }]) {
      const client = new WireMockClient('http://wm', undefined, options)
      await client.addStub(mappings[0])
      await client.importStubs(mappings)
    }
    expect(calls[0].text).toBe(expected)
    expect(JSON.parse(calls[1].text).mappings).toEqual([price('/b'), price('/a')])
    expect(calls[2].text).not.toContain('injected')
    expect(calls.map((c) => c.text).join()).not.toMatch(/ctfStubKey|CONNECTION_RESET|"status":500/)
  })

  it('rewrites only the matching stub, on every registration path', async () => {
    vi.stubEnv('CTF_FAULT', 'GET /a=status500')
    const client = new WireMockClient('http://wm')
    await client.addStub(price('/a'))
    await client.importStubs([price('/a'), price('/b')])
    await client.register(price('/a'), price('/b'))
    expect(JSON.parse(calls[0].text).response.status).toBe(500)
    for (const c of calls.slice(1)) {
      const byPath = Object.fromEntries(
        JSON.parse(c.text).mappings.map((m: any) => [m.request.urlPath, m.response.status]),
      )
      expect(byPath).toEqual({ '/a': 500, '/b': 200 })
    }
  })

  it.each([
    ['url', { url: '/a?x=1' }, 'GET /a?x=1'],
    ['urlPath', { urlPath: '/a' }, 'GET /a'],
    ['urlPathTemplate', { urlPathTemplate: '/a/{id}' }, 'GET /a/{id}'],
    ['urlPathPattern', { urlPathPattern: '/a/.*' }, 'GET /a/.*'],
  ])('matches a stub using %s', async (_form, request, selector) => {
    vi.stubEnv('CTF_FAULT', `${selector}=connectionReset`)
    await new WireMockClient('http://wm').addStub({
      request: { method: 'GET', ...request },
      response: { status: 200 },
    })
    expect(JSON.parse(calls[0].text).response.fault).toBe('CONNECTION_RESET_BY_PEER')
  })

  it('leaves a stub of another method alone', async () => {
    vi.stubEnv('CTF_FAULT', 'POST /a=emptyBody')
    await new WireMockClient('http://wm').addStub(price('/a'))
    expect(calls[0].text).toBe(JSON.stringify(price('/a')))
  })

  it('selects a GraphQL operation by endpoint and name, not its siblings', async () => {
    vi.stubEnv('CTF_FAULT', 'GRAPHQL /v1/graphql/ account=status500')
    const gql = graphql.endpoint('/v1/graphql/')
    const client = new WireMockClient('http://wm', undefined, { namespace: '/__worker-2' })
    await client.register(
      gql.query('account').willReturnData({ account: {} }),
      gql.mutation('obtainKrakenToken').willReturnData({}),
    )
    const [token, account] = JSON.parse(calls[0].text).mappings
    expect(account.response.status).toBe(500)
    expect(account.request.urlPath).toBe('/__worker-2/v1/graphql/')
    expect(token.response.status).toBe(200)
  })

  it('composes with namespacing', async () => {
    vi.stubEnv('CTF_FAULT', 'GET /a=status500')
    await new WireMockClient('http://wm', undefined, { namespace: '/__worker-1' }).addStub(
      price('/a'),
    )
    const posted = JSON.parse(calls[0].text)
    expect(posted.request.urlPath).toBe('/__worker-1/a')
    expect(posted.response.status).toBe(500)
  })

  it('fails to construct on a bad CTF_FAULT', () => {
    vi.stubEnv('CTF_FAULT', 'GET /a=slow')
    expect(() => new WireMockClient('http://wm')).toThrow(/unknown fault "slow"/)
  })

  it('tags stubs with their key only while CTF_FAULT_HITS is set', async () => {
    vi.stubEnv('CTF_FAULT_HITS', '/tmp/x')
    await new WireMockClient('http://wm').addStub(price('/a'))
    expect(JSON.parse(calls[0].text).metadata.ctfStubKey).toBe('GET /a')
  })

  it('reads the keys of the stubs that served requests, for its own namespace', async () => {
    const served = {
      requests: [
        {
          wasMatched: true,
          stubMapping: { metadata: { ctfStubKey: 'GET /a', componentTestNamespace: '/w1' } },
        },
        {
          wasMatched: true,
          stubMapping: { metadata: { ctfStubKey: 'GET /b', componentTestNamespace: '/w2' } },
        },
        {
          wasMatched: false,
          stubMapping: { metadata: { ctfStubKey: 'GET /c', componentTestNamespace: '/w1' } },
        },
        { wasMatched: true, stubMapping: { metadata: { componentTestNamespace: '/w1' } } },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(served))),
    )
    expect(
      await new WireMockClient('http://wm', undefined, { namespace: '/w1' }).servedStubKeys(),
    ).toEqual(['GET /a'])
  })
})
