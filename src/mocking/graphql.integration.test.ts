import { describe, it, expect, beforeEach } from 'vitest'
import { WireMockClient } from '../clients/wiremock-client'
import { graphql } from './graphql'

// Against real WireMock; skipped without WIREMOCK_URL. This is where the
// operation-name matching is proved: the stubs are JSON, and only WireMock
// can say what they match.
const url = process.env.WIREMOCK_URL ?? ''
const NS = '/__gql-it'
const PATH = '/v1/graphql/'

interface GqlResult {
  status: number
  body: { data?: unknown; errors?: unknown[] }
}

describe.skipIf(!url)('GraphQL mocking against WireMock (COMPONENT-23)', () => {
  const client = new WireMockClient(url, undefined, { namespace: NS })
  const octopus = graphql.endpoint(PATH)

  async function send(payload: Record<string, unknown>, path = PATH): Promise<GqlResult> {
    const res = await fetch(`${url}${NS}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    return {
      status: res.status,
      body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : {},
    }
  }

  // The shape joule-genie's Go client sends: no operationName.
  const tokenMutation =
    'mutation obtainKrakenToken($input: ObtainJSONWebTokenInput!) {\n  obtainKrakenToken(input: $input) {\n    token\n  }\n}'

  beforeEach(() => client.resetAll())

  it('matches an operation named only in the query text', async () => {
    await client.register(
      octopus.mutation('obtainKrakenToken').willReturnData({ obtainKrakenToken: { token: 't' } }),
    )
    const res = await send({ query: tokenMutation, variables: { input: { APIKey: 'k' } } })
    expect(res).toEqual({ status: 200, body: { data: { obtainKrakenToken: { token: 't' } } } })
  })

  it('matches a request that gives operationName', async () => {
    await client.register(octopus.mutation('obtainKrakenToken').willReturnData({ ok: true }))
    const res = await send({ query: '{ x }', operationName: 'obtainKrakenToken' })
    expect(res.body).toEqual({ data: { ok: true } })
    const both = await send({ query: tokenMutation, operationName: 'obtainKrakenToken' })
    expect(both.body).toEqual({ data: { ok: true } })
  })

  it('does not match an operation whose name merely contains it', async () => {
    await client.register(octopus.mutation('obtainKrakenToken').willReturnData({ ok: true }))
    expect(
      (
        await send({
          query: tokenMutation
            .replace('obtainKrakenToken(', 'obtainKrakenTokenV2(')
            .replace('mutation obtainKrakenToken', 'mutation obtainKrakenTokenV2'),
        })
      ).status,
    ).toBe(404)
    expect((await send({ query: 'mutation obtainKrakenTokenV2 { x }' })).status).toBe(404)
    expect((await send({ query: '{ x }', operationName: 'obtainKrakenTokenV2' })).status).toBe(404)
    expect((await send({ query: 'mutation xobtainKrakenToken { x }' })).status).toBe(404)
    expect((await send({ query: 'mutation obtainKrakenToken_2 { x }' })).status).toBe(404)
  })

  it('keeps queries and mutations of the same name apart', async () => {
    await client.register(
      octopus.query('account').willReturnData({ kind: 'query' }),
      octopus.mutation('account').willReturnData({ kind: 'mutation' }),
    )
    expect((await send({ query: 'query account { a }' })).body.data).toEqual({ kind: 'query' })
    expect((await send({ query: 'mutation account { a }' })).body.data).toEqual({
      kind: 'mutation',
    })
    expect(
      (await send({ query: 'mutation account { a }', operationName: 'account' })).body.data,
    ).toEqual({ kind: 'mutation' })
    expect(
      (await send({ query: 'query account { a }', operationName: 'account' })).body.data,
    ).toEqual({ kind: 'query' })
    expect((await send({ query: '{ a }', operationName: 'account' })).status).toBe(200)
    expect((await send({ query: 'subscription account { a }' })).status).toBe(404)
  })

  it('an operation stub takes any keyword', async () => {
    await client.register(octopus.operation('anything').withHttpStatus(500))
    expect((await send({ query: 'query anything { a }' })).status).toBe(500)
    expect((await send({ query: 'mutation anything { a }' })).status).toBe(500)
    expect((await send({ query: 'subscription anything { a }' })).status).toBe(500)
    expect((await send({ query: '{ a }', operationName: 'anything' })).status).toBe(500)
    expect((await send({ query: 'query other { a }' })).status).toBe(404)
  })

  it('matches variables partially', async () => {
    await client.register(
      octopus.query('account').willReturnData({ account: 'other' }),
      octopus
        .query('account')
        .withVariables({ accountNumber: 'A-1' })
        .willReturnData({ account: 'one' }),
    )
    const query = 'query account($accountNumber: String!, $x: Int) { account }'
    const hit = await send({ query, variables: { accountNumber: 'A-1', x: 5 } })
    expect(hit.body.data).toEqual({ account: 'one' })
    const miss = await send({ query, variables: { accountNumber: 'A-2' } })
    expect(miss.body.data).toEqual({ account: 'other' })
    expect((await send({ query })).body.data).toEqual({ account: 'other' })
  })

  it('answers errors, and partial data with errors, as HTTP 200', async () => {
    await client.register(
      octopus
        .query('gone')
        .willReturnErrors([{ message: 'not found', extensions: { code: 'NOT_FOUND' } }]),
      octopus
        .query('partial')
        .willReturn({ data: { account: null }, errors: [{ message: 'nope' }] }),
    )
    expect(await send({ query: 'query gone { a }' })).toEqual({
      status: 200,
      body: { errors: [{ message: 'not found', extensions: { code: 'NOT_FOUND' } }] },
    })
    expect(await send({ query: 'query partial { a }' })).toEqual({
      status: 200,
      body: { data: { account: null }, errors: [{ message: 'nope' }] },
    })
  })

  it('only matches POSTs to its endpoint', async () => {
    await client.register(octopus.operation('a').willReturnData({}))
    expect((await send({ query: 'query a { a }' }, '/graphql')).status).toBe(404)
    const get = await fetch(`${url}${NS}${PATH}`)
    expect(get.status).toBe(404)
  })

  it('counts requests by the same name rule', async () => {
    await send({ query: tokenMutation })
    await send({ query: '{ x }', operationName: 'obtainKrakenToken' })
    await send({ query: 'mutation obtainKrakenTokenV2 { x }' })
    await send({ query: 'query obtainKrakenToken { x }' })
    await send({ query: 'query account($n: String) { a }', variables: { n: 'A-1', z: 1 } })
    await send({ query: 'query account($n: String) { a }', variables: { n: 'A-2' } })
    await send({ query: tokenMutation }, '/other')

    expect(await client.graphqlRequestCount(PATH, 'obtainKrakenToken')).toBe(3)
    expect(await client.graphqlRequestCount(PATH, 'obtainKrakenToken', { kind: 'mutation' })).toBe(
      2,
    )
    expect(await client.graphqlRequestCount(PATH, 'obtainKrakenToken', { kind: 'query' })).toBe(2)
    expect(await client.graphqlRequestCount(PATH, 'obtainKrakenTokenV2')).toBe(1)
    expect(await client.graphqlRequestCount(PATH, 'account')).toBe(2)
    expect(await client.graphqlRequestCount(PATH, 'account', { variables: { n: 'A-1' } })).toBe(1)
    expect(await client.graphqlRequestCount(PATH, 'missing')).toBe(0)
  })
})
