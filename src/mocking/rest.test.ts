import { describe, it, expect } from 'vitest'
import { stub } from './rest'

describe('stub builder (COMPONENT-23)', () => {
  it('builds a plain GET', () => {
    expect(stub.get('/pricing/prices/WIDGET').willReturn(200, { price: 7 }).build()).toEqual({
      request: { method: 'GET', urlPath: '/pricing/prices/WIDGET' },
      response: {
        status: 200,
        jsonBody: { price: 7 },
        headers: { 'Content-Type': 'application/json' },
      },
    })
  })

  it('builds a POST with a partial JSON body and response headers', () => {
    expect(
      stub
        .post('/orders')
        .withJsonBody({ sku: 'WIDGET' })
        .willReturn(201, { id: 'o1' }, { Location: '/orders/o1' })
        .build(),
    ).toEqual({
      request: {
        method: 'POST',
        urlPath: '/orders',
        bodyPatterns: [
          {
            equalToJson: '{"sku":"WIDGET"}',
            ignoreArrayOrder: false,
            ignoreExtraElements: true,
          },
        ],
      },
      response: {
        status: 201,
        jsonBody: { id: 'o1' },
        headers: { 'Content-Type': 'application/json', Location: '/orders/o1' },
      },
    })
  })

  it('matches query and headers by string or RegExp, and delays', () => {
    expect(
      stub
        .get('/slow')
        .withQuery({ page: '2', q: /^a/i })
        .withHeader('Authorization', /^Bearer /)
        .withHeader('X-Id', 'abc')
        .withDelay(500)
        .willReturnStatus(503)
        .build(),
    ).toEqual({
      request: {
        method: 'GET',
        urlPath: '/slow',
        queryParameters: {
          page: { equalTo: '2' },
          q: { matches: '(?s).*(?:(?i)^a).*' },
        },
        headers: {
          Authorization: { matches: '(?s).*(?:^Bearer ).*' },
          'X-Id': { equalTo: 'abc' },
        },
      },
      response: { status: 503, fixedDelayMilliseconds: 500 },
    })
  })

  it('keeps the delay whichever order it is set in', () => {
    const built = stub.get('/x').withDelay(5).willReturnStatus(200).withDelay(7).build()
    expect(built.response).toEqual({ status: 200, fixedDelayMilliseconds: 7 })
  })

  it('builds a path pattern for any method with a priority', () => {
    expect(stub.any('/pricing/.*').pathPattern().priority(1).willReturnStatus(500).build()).toEqual(
      {
        request: { method: 'ANY', urlPathPattern: '/pricing/.*' },
        response: { status: 500 },
        priority: 1,
      },
    )
  })

  it('builds scenario transitions', () => {
    expect(
      stub.get('/state').inScenario('flow', 'Started', 'Second').willReturn(200, { n: 1 }).build(),
    ).toMatchObject({
      scenarioName: 'flow',
      requiredScenarioState: 'Started',
      newScenarioState: 'Second',
    })
    expect(stub.get('/s').inScenario('flow', 'Second').build()).not.toHaveProperty(
      'newScenarioState',
    )
  })

  it.each([
    ['put', 'PUT'],
    ['patch', 'PATCH'],
    ['delete', 'DELETE'],
  ] as const)('%s uses the %s method', (name, method) => {
    expect(stub[name]('/x').build().request).toMatchObject({ method })
  })

  it('builds a text body with its content type, and a bare JSON status', () => {
    expect(stub.get('/t').willReturnBody(200, 'hi', 'text/plain').build().response).toEqual({
      status: 200,
      body: 'hi',
      headers: { 'Content-Type': 'text/plain' },
    })
    expect(stub.get('/t').willReturn(204).build().response).toEqual({ status: 204 })
  })

  it('refuses RegExp flags WireMock cannot express', () => {
    expect(() => stub.get('/x').withHeader('A', /a/m)).toThrow(/Unsupported RegExp flags/)
  })

  it('returns a copy from build, so later changes do not leak', () => {
    const builder = stub.get('/x').willReturnStatus(200)
    const first = builder.build()
    builder.willReturnStatus(500)
    expect(first.response).toEqual({ status: 200 })
  })
})
