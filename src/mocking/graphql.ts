import type { Buildable, Mapping } from './rest'

/** Which operation keyword a stub accepts. `operation` accepts any. */
export type OperationKind = 'query' | 'mutation' | 'operation'

const KEYWORDS = ['query', 'mutation', 'subscription']
const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/

export interface GraphQLError {
  message: string
  [key: string]: unknown
}

export interface GraphQLResponse {
  data?: unknown
  errors?: GraphQLError[]
}

/**
 * The body patterns that select a GraphQL operation by name.
 *
 * A client may name the operation in `operationName`, or only in the query
 * text (`mutation obtainKrakenToken($input: ...) {`), as joule-genie's Go
 * client does. So the name matches when either holds:
 *   - `$.query` declares `<keyword> <Name>` followed by a word boundary, so
 *     `obtainKrakenToken` never matches `obtainKrakenTokenV2`, and
 *     `$.operationName` is absent or equals the name;
 *   - `$.operationName` equals the name and the query text, if any, does not
 *     declare that name under a different keyword.
 * It is one `or` body pattern of `matchesJsonPath` matchers, which WireMock
 * 3.13.2 evaluates correctly (checked live in graphql.integration.test.ts).
 * `matches` must cover the whole value in WireMock, hence the `(?s).*`.
 * Variables are a partial `equalToJson` on `$.variables`.
 */
export function operationBodyPatterns(
  kind: OperationKind,
  name: string,
  variables?: unknown,
): Mapping[] {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a valid GraphQL operation name.`)
  const keywords = kind === 'operation' ? KEYWORDS : [kind]
  const others = KEYWORDS.filter((k) => !keywords.includes(k))
  const declares = (words: string[]) => `(?s).*\\b(?:${words.join('|')})\\s+${name}\\b.*`
  const opName = (matcher: Mapping) => ({
    matchesJsonPath: { expression: '$.operationName', ...matcher },
  })
  const byQueryText = {
    and: [
      { matchesJsonPath: { expression: '$.query', matches: declares(keywords) } },
      // operationName picks one operation of the document, so it must pick this one.
      { or: [opName({ absent: true }), opName({ equalTo: name })] },
    ],
  }
  const named = opName({ equalTo: name })
  const byOperationName =
    others.length > 0
      ? {
          and: [
            named,
            {
              // A persisted query sends operationName with no query text.
              or: [
                { matchesJsonPath: { expression: '$.query', absent: true } },
                { matchesJsonPath: { expression: '$.query', doesNotMatch: declares(others) } },
              ],
            },
          ],
        }
      : named
  const patterns: Mapping[] = [{ or: [byQueryText, byOperationName] }]
  if (variables !== undefined) {
    patterns.push({
      matchesJsonPath: {
        expression: '$.variables',
        equalToJson: JSON.stringify(variables),
        ignoreExtraElements: true,
        ignoreArrayOrder: false,
      },
    })
  }
  return patterns
}

/** Builds one stub for a GraphQL operation. Start with {@link graphql}.endpoint. */
export class OperationStub implements Buildable {
  private variables?: unknown
  private status = 200
  private body?: GraphQLResponse

  constructor(
    private readonly path: string,
    private readonly kind: OperationKind,
    private readonly name: string,
  ) {
    operationBodyPatterns(kind, name)
  }

  /** Match only requests whose `variables` contain these. */
  withVariables(variables: Record<string, unknown>): this {
    this.variables = variables
    return this
  }

  /** Answer with this HTTP status instead of 200: a transport failure. */
  withHttpStatus(status: number): this {
    this.status = status
    return this
  }

  willReturnData(data: unknown): this {
    this.body = { data }
    return this
  }

  willReturnErrors(errors: GraphQLError[]): this {
    this.body = { errors }
    return this
  }

  /** Answer with a whole response, for partial data alongside errors. */
  willReturn(response: GraphQLResponse): this {
    this.body = response
    return this
  }

  build(): Mapping {
    return {
      request: {
        method: 'POST',
        urlPath: this.path,
        bodyPatterns: operationBodyPatterns(this.kind, this.name, this.variables),
      },
      response: {
        status: this.status,
        ...(this.body && {
          jsonBody: this.body,
          headers: { 'Content-Type': 'application/json' },
        }),
      },
    }
  }
}

export interface GraphQLEndpoint {
  readonly path: string
  query(name: string): OperationStub
  mutation(name: string): OperationStub
  operation(name: string): OperationStub
}

export const graphql = {
  /** A GraphQL endpoint to stub operations on. */
  endpoint(path = '/graphql'): GraphQLEndpoint {
    return {
      path,
      query: (name) => new OperationStub(path, 'query', name),
      mutation: (name) => new OperationStub(path, 'mutation', name),
      operation: (name) => new OperationStub(path, 'operation', name),
    }
  },
}
