import { loadFixture } from './fixtures'
import { requireApiBaseUrl } from './config'
import type { ComponentTestWorld } from './world'

/** A request file name that means "no fixture": an empty body and no parameters. */
export const EMPTY_REQUEST = '_empty'

/** Options for {@link sendOperation}. */
export interface SendOperationOptions {
  /**
   * Fixture under `{fixturesDir}/requests/`, without `.json`. Its `_pathParams`
   * and `_queryParams` fill the URL; the rest is the JSON body. Omit it, or
   * pass `_empty`, to send no fixture.
   */
  requestFile?: string
  /** Values for `{placeholders}` in the path. These win over the fixture's `_pathParams`. */
  pathParams?: Record<string, unknown>
  /** Query parameters. These win over the fixture's `_queryParams`. */
  queryParams?: Record<string, string>
  /** Extra request headers. */
  headers?: Record<string, string>
  /** Send this exact body instead of the fixture's JSON, e.g. malformed JSON or text. */
  rawBody?: string
  /** Content type for `rawBody`. Default `application/json`. */
  contentType?: string
  /**
   * Which token to send as `Authorization: Bearer …`: the world's current
   * access token (default), none, or a specific one.
   */
  auth?: 'current' | 'none' | { token: string }
}

const METHODS_WITHOUT_BODY = ['GET', 'DELETE', 'HEAD']

/**
 * Send a request to an operation in the consumer's operation map, record it as
 * the last response and count the call. This is what the `I send the request
 * … to the … operation` steps use; call it from your own steps for anything
 * they don't cover.
 *
 * @example
 * await sendOperation(this, 'getScan', {
 *   requestFile: '_empty',
 *   pathParams: { oid: this.recall('org'), sid: this.recall('scan') },
 * })
 */
export async function sendOperation(
  world: ComponentTestWorld,
  operationId: string,
  options: SendOperationOptions = {},
): Promise<void> {
  const op = world.operationMap[operationId]
  if (!op) {
    throw new Error(
      `Unknown operationId "${operationId}". Available: ${Object.keys(world.operationMap).join(', ')}`,
    )
  }

  const requestFile = options.requestFile ?? EMPTY_REQUEST
  const fixture =
    requestFile === EMPTY_REQUEST
      ? {}
      : (loadFixture('requests', requestFile, world.config.fixturesDir) as Record<string, unknown>)
  const { _pathParams, _queryParams, ...jsonBody } = fixture

  const path = fillPath(op.path, {
    ...((_pathParams ?? {}) as Record<string, unknown>),
    ...options.pathParams,
  })
  const query = new URLSearchParams({
    ...((_queryParams ?? {}) as Record<string, string>),
    ...options.queryParams,
  }).toString()
  const url = `${requireApiBaseUrl(world.config)}${path}${query ? `?${query}` : ''}`

  const headers: Record<string, string> = {
    'Content-Type':
      options.rawBody !== undefined
        ? (options.contentType ?? 'application/json')
        : 'application/json',
    ...options.headers,
  }
  const auth = options.auth ?? 'current'
  const token = auth === 'none' ? null : auth === 'current' ? world.accessToken : auth.token
  if (token) headers['Authorization'] = `Bearer ${token}`

  let body: string | undefined
  if (options.rawBody !== undefined) body = options.rawBody
  else if (!METHODS_WITHOUT_BODY.includes(op.method.toUpperCase())) body = JSON.stringify(jsonBody)

  const res = await fetch(url, { method: op.method, headers, body })

  const responseBody = res.status === 204 ? null : await res.json().catch(() => null)
  const responseHeaders: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })

  // trackCall sets lastResponse too (COMPONENT-4), headers included.
  world.trackCall(operationId, requestFile, {
    status: res.status,
    body: responseBody,
    headers: responseHeaders,
  })
}

/**
 * Fill `{placeholders}` in a path template, URL-encoding each value.
 * Placeholders without a value are left as they are.
 *
 * e.g. "/orgs/{oid}/scans/{sid}" + { oid: 1, sid: "a b" } -> "/orgs/1/scans/a%20b"
 */
export function fillPath(template: string, params: Record<string, unknown>): string {
  let filled = template
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    filled = filled.split(`{${key}}`).join(encodeURIComponent(String(value)))
  }
  return filled
}
