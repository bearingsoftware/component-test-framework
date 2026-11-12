import { describe, it, expect } from 'vitest'
import { graphql, operationBodyPatterns } from './graphql'

const gql = graphql.endpoint('/v1/graphql/')

describe('GraphQL stub mapping (COMPONENT-23)', () => {
  it('defaults the endpoint to /graphql', () => {
    expect(graphql.endpoint().query('a').build().request).toMatchObject({
      method: 'POST',
      urlPath: '/graphql',
    })
  })

  it('builds data, errors and both, as HTTP 200 JSON', () => {
    const json = { 'Content-Type': 'application/json' }
    expect(gql.mutation('m').willReturnData({ m: 1 }).build().response).toEqual({
      status: 200,
      jsonBody: { data: { m: 1 } },
      headers: json,
    })
    expect(
      gql
        .query('q')
        .willReturnErrors([{ message: 'no' }])
        .build().response,
    ).toEqual({
      status: 200,
      jsonBody: { errors: [{ message: 'no' }] },
      headers: json,
    })
    expect(
      gql
        .query('q')
        .willReturn({ data: { q: null }, errors: [{ message: 'no' }] })
        .build().response,
    ).toMatchObject({ jsonBody: { data: { q: null }, errors: [{ message: 'no' }] } })
  })

  it('answers a transport failure with only a status', () => {
    expect(gql.operation('x').withHttpStatus(500).build().response).toEqual({ status: 500 })
  })

  it('matches by operationName or the name in the query text, and any variables', () => {
    const [name] = operationBodyPatterns('mutation', 'obtainKrakenToken')
    expect(name).toEqual({
      or: [
        {
          matchesJsonPath: {
            expression: '$.query',
            matches: '(?s).*\\b(?:mutation)\\s+obtainKrakenToken\\b.*',
          },
        },
        {
          and: [
            { matchesJsonPath: { expression: '$.operationName', equalTo: 'obtainKrakenToken' } },
            {
              matchesJsonPath: {
                expression: '$.query',
                doesNotMatch: '(?s).*\\b(?:query|subscription)\\s+obtainKrakenToken\\b.*',
              },
            },
          ],
        },
      ],
    })
    expect(operationBodyPatterns('mutation', 'obtainKrakenToken')).toHaveLength(1)
  })

  it('an operation stub accepts every keyword, with no query check on operationName', () => {
    const [name] = operationBodyPatterns('operation', 'a') as { or: unknown[] }[]
    expect(name.or).toEqual([
      {
        matchesJsonPath: {
          expression: '$.query',
          matches: '(?s).*\\b(?:query|mutation|subscription)\\s+a\\b.*',
        },
      },
      { matchesJsonPath: { expression: '$.operationName', equalTo: 'a' } },
    ])
  })

  it('adds partial variables on $.variables', () => {
    expect(
      gql.query('account').withVariables({ accountNumber: 'A-1' }).build().request,
    ).toMatchObject({
      bodyPatterns: [
        {},
        {
          matchesJsonPath: {
            expression: '$.variables',
            equalToJson: '{"accountNumber":"A-1"}',
            ignoreExtraElements: true,
            ignoreArrayOrder: false,
          },
        },
      ],
    })
  })

  it('rejects a name that is not a GraphQL name, so it cannot reach the regex', () => {
    expect(() => gql.query('a.*')).toThrow(/not a valid GraphQL operation name/)
  })
})
