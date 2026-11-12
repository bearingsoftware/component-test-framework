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

  it('matches by the query text with a compatible operationName, or by operationName', () => {
    const [name] = operationBodyPatterns('mutation', 'obtainKrakenToken')
    const opName = (m: object) => ({ matchesJsonPath: { expression: '$.operationName', ...m } })
    expect(name).toEqual({
      or: [
        {
          and: [
            {
              matchesJsonPath: {
                expression: '$.query',
                matches: '(?s).*\\b(?:mutation)\\s+obtainKrakenToken\\b.*',
              },
            },
            { or: [opName({ absent: true }), opName({ equalTo: 'obtainKrakenToken' })] },
          ],
        },
        {
          and: [
            opName({ equalTo: 'obtainKrakenToken' }),
            {
              or: [
                { matchesJsonPath: { expression: '$.query', absent: true } },
                {
                  matchesJsonPath: {
                    expression: '$.query',
                    doesNotMatch: '(?s).*\\b(?:query|subscription)\\s+obtainKrakenToken\\b.*',
                  },
                },
              ],
            },
          ],
        },
      ],
    })
    expect(operationBodyPatterns('mutation', 'obtainKrakenToken')).toHaveLength(1)
  })

  it('an operation stub accepts every keyword, with no query check on operationName', () => {
    const [name] = operationBodyPatterns('operation', 'a') as { or: unknown[] }[]
    expect(JSON.stringify(name.or[0])).toContain('(?:query|mutation|subscription)')
    expect(name.or[1]).toEqual({
      matchesJsonPath: { expression: '$.operationName', equalTo: 'a' },
    })
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
