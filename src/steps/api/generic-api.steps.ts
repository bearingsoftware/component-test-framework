import { Given, When } from '@cucumber/cucumber'
import { loadFixture } from '../../support/fixtures'
import { requireApiBaseUrl } from '../../support/config'
import type { ComponentTestWorld } from '../../support/world'

/**
 * Resolve path parameters in a URL template. Fixture `_pathParams` are
 * applied first; `overrides` take precedence and are used to inject values
 * not known at fixture-authoring time (e.g. an id captured from the
 * previous response).
 *
 * e.g. "/integrations/{id}" + { _pathParams: { id: "int-1" } } -> "/integrations/int-1"
 */
function resolvePathParams(
  pathTemplate: string,
  body: Record<string, unknown>,
  overrides: Record<string, string> = {},
): string {
  const fixtureParams = (body._pathParams ?? {}) as Record<string, string>
  const params = { ...fixtureParams, ...overrides }
  let resolved = pathTemplate
  for (const [key, value] of Object.entries(params)) {
    resolved = resolved.replace(`{${key}}`, encodeURIComponent(value))
  }
  return resolved
}

/** Strip framework-internal keys from the request body before sending. */
function cleanBody(body: Record<string, unknown>): Record<string, unknown> {
  const { _pathParams, _queryParams, ...rest } = body
  return rest
}

/** Build query string from _queryParams in fixture. */
function buildQueryString(body: Record<string, unknown>): string {
  const params = (body._queryParams ?? {}) as Record<string, string>
  const entries = Object.entries(params)
  if (entries.length === 0) return ''
  const qs = new URLSearchParams(params).toString()
  return `?${qs}`
}

/**
 * Send an HTTP request to an API operation defined in the consumer's operation map.
 * Loads the request body from a fixture file, resolves path/query params, and tracks the call.
 */
async function sendRequest(
  world: ComponentTestWorld,
  requestFile: string,
  operationId: string,
  options: {
    withAuth: boolean
    tokenOverride?: string
    pathOverrides?: Record<string, string>
  },
): Promise<void> {
  const op = world.operationMap[operationId]
  if (!op) {
    throw new Error(
      `Unknown operationId "${operationId}". Available: ${Object.keys(world.operationMap).join(', ')}`,
    )
  }

  const fixture = loadFixture('requests', requestFile, world.config.fixturesDir) as Record<
    string,
    unknown
  >
  const resolvedPath = resolvePathParams(op.path, fixture, options.pathOverrides)
  const queryString = buildQueryString(fixture)
  const url = `${requireApiBaseUrl(world.config)}${resolvedPath}${queryString}`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.withAuth) {
    const token = options.tokenOverride ?? world.accessToken
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
  }

  const hasBody = !['GET', 'DELETE', 'HEAD'].includes(op.method.toUpperCase())
  const body = hasBody ? JSON.stringify(cleanBody(fixture)) : undefined

  const res = await fetch(url, {
    method: op.method,
    headers,
    body,
  })

  const responseBody = res.status === 204 ? null : await res.json().catch(() => null)
  const responseHeaders: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })

  // COMPONENT-4: trackCall sets lastResponse, so the headers go through it.
  // Setting lastResponse here first and calling trackCall without headers
  // used to wipe them, and header assertions after an operation step failed.
  world.trackCall(operationId, requestFile, {
    status: res.status,
    body: responseBody,
    headers: responseHeaders,
  })
}

// --- Step definitions ---

Given(
  'I send the request {word} to the {word} operation',
  async function (this: ComponentTestWorld, requestFile: string, operationId: string) {
    await sendRequest(this, requestFile, operationId, { withAuth: true })
  },
)

Given(
  'I send the request {word} to the {word} operation with token {word}',
  async function (
    this: ComponentTestWorld,
    requestFile: string,
    operationId: string,
    token: string,
  ) {
    await sendRequest(this, requestFile, operationId, { withAuth: true, tokenOverride: token })
  },
)

Given(
  'I send the request {word} to the {word} operation without authentication',
  async function (this: ComponentTestWorld, requestFile: string, operationId: string) {
    await sendRequest(this, requestFile, operationId, { withAuth: false })
  },
)

When(
  'I authenticate with the request {word} to the {word} operation',
  async function (this: ComponentTestWorld, requestFile: string, operationId: string) {
    await sendRequest(this, requestFile, operationId, { withAuth: false })
    if (this.lastResponse && this.lastResponse.status < 300) {
      const body = this.lastResponse.body as Record<string, unknown>
      if (body.access_token) this.accessToken = body.access_token as string
      if (body.refresh_token) this.refreshToken = body.refresh_token as string
    }
  },
)

When(
  'I send the request {word} to the {word} operation with id from last response',
  async function (this: ComponentTestWorld, requestFile: string, operationId: string) {
    const id = (this.lastResponse?.body as { id?: string } | null | undefined)?.id
    if (!id) {
      throw new Error(
        'No `id` field on last response body — this step needs a prior request that returned one.',
      )
    }
    await sendRequest(this, requestFile, operationId, {
      withAuth: true,
      pathOverrides: { id },
    })
  },
)
