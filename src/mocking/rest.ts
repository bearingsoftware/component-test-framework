/** A plain WireMock stub mapping. */
export type Mapping = Record<string, unknown>

/** Anything {@link WireMockClient.register} accepts: a builder, or a mapping. */
export interface Buildable {
  build(): Mapping
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ANY'

/** A header or query value to match: exactly (a string) or by regular expression. */
export type ValueMatcher = string | RegExp

/**
 * A matcher WireMock understands. A RegExp matches where JavaScript's `test`
 * would, anywhere in the value; WireMock itself matches the whole value, so
 * the pattern is padded to match like `test` does.
 */
export function valueMatcher(value: ValueMatcher): Record<string, unknown> {
  if (typeof value === 'string') return { equalTo: value }
  const flags = value.flags.replace(/[gy]/g, '')
  if (flags && flags !== 'i') {
    throw new Error(`Unsupported RegExp flags /${value.flags}: WireMock matching supports only i.`)
  }
  return { matches: `(?s).*(?:${flags ? '(?i)' : ''}${value.source}).*` }
}

/** Builds one WireMock mapping. Start with {@link stub}. */
export class StubBuilder implements Buildable {
  private request: Mapping
  private response: Mapping = { status: 200 }
  private extra: Mapping = {}
  private delay?: number

  constructor(method: Method, path: string) {
    this.request = { method, urlPath: path }
  }

  /** Treat the path as a regular expression rather than an exact path. */
  pathPattern(): this {
    const { urlPath, ...rest } = this.request
    this.request = { ...rest, urlPathPattern: urlPath }
    return this
  }

  /** Match when the JSON body contains this, ignoring extra properties and keeping array order. */
  withJsonBody(body: unknown): this {
    const patterns = (this.request.bodyPatterns as Mapping[] | undefined) ?? []
    this.request.bodyPatterns = [
      ...patterns,
      { equalToJson: JSON.stringify(body), ignoreArrayOrder: false, ignoreExtraElements: true },
    ]
    return this
  }

  /** Match query parameters: exact strings, or a RegExp. Other parameters are ignored. */
  withQuery(query: Record<string, ValueMatcher>): this {
    const params = (this.request.queryParameters as Mapping | undefined) ?? {}
    this.request.queryParameters = {
      ...params,
      ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, valueMatcher(v)])),
    }
    return this
  }

  withHeader(name: string, value: ValueMatcher): this {
    const headers = (this.request.headers as Mapping | undefined) ?? {}
    this.request.headers = { ...headers, [name]: valueMatcher(value) }
    return this
  }

  /** Answer with a status and, optionally, a JSON body and headers. */
  willReturn(status: number, json?: unknown, headers: Record<string, string> = {}): this {
    this.response =
      json === undefined
        ? { status, ...(Object.keys(headers).length > 0 && { headers }) }
        : { status, jsonBody: json, headers: { 'Content-Type': 'application/json', ...headers } }
    return this
  }

  /** Answer with a status and nothing else. */
  willReturnStatus(status: number): this {
    this.response = { status }
    return this
  }

  /** Answer with a text body of a given content type. */
  willReturnBody(status: number, text: string, contentType: string): this {
    this.response = { status, body: text, headers: { 'Content-Type': contentType } }
    return this
  }

  /** Hold the response back, in ms. */
  withDelay(ms: number): this {
    this.delay = ms
    return this
  }

  /** Lower numbers win when stubs overlap. WireMock's default is 5. */
  priority(n: number): this {
    this.extra.priority = n
    return this
  }

  /** Match only in `requiredState` of the scenario, and move it to `newState` once served. */
  inScenario(name: string, requiredState: string, newState?: string): this {
    this.extra.scenarioName = name
    this.extra.requiredScenarioState = requiredState
    if (newState !== undefined) this.extra.newScenarioState = newState
    return this
  }

  build(): Mapping {
    const response =
      this.delay === undefined
        ? this.response
        : { ...this.response, fixedDelayMilliseconds: this.delay }
    return structuredClone({ request: this.request, response, ...this.extra })
  }
}

/** Start a stub: `stub.get('/prices/WIDGET').willReturn(200, { price: 7 })`. */
export const stub = {
  get: (path: string) => new StubBuilder('GET', path),
  post: (path: string) => new StubBuilder('POST', path),
  put: (path: string) => new StubBuilder('PUT', path),
  patch: (path: string) => new StubBuilder('PATCH', path),
  delete: (path: string) => new StubBuilder('DELETE', path),
  /** Any method. */
  any: (path: string) => new StubBuilder('ANY', path),
}
