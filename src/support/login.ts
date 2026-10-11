// Logging in and reading tokens, without Cucumber, so runners other than
// Cucumber (the Playwright Test fixtures) can use it. The world-based
// helpers and registerLoginTag are in auth.ts.
import { requireApiBaseUrl } from './config'
import type { FrameworkConfig } from '../types'
import { valueAt } from '../utils/json-path'

export const DEFAULT_TOKEN_PATH = 'access_token'
export const DEFAULT_REFRESH_TOKEN_PATH = 'refresh_token'

/** The non-empty string at `path` in a response body, if there is one. */
export function tokenAt(body: unknown, path: string): string | undefined {
  try {
    const value = valueAt(body, path)
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/** Describe a body without its values, which may be tokens: `{token, user}`. */
export function shapeOf(body: unknown): string {
  if (body === null || typeof body !== 'object') return typeof body
  return Array.isArray(body) ? `array(${body.length})` : `{${Object.keys(body).join(', ')}}`
}

/** The response to a login request. */
export interface LoginResponse {
  status: number
  body: unknown
  headers: Record<string, string>
}

/**
 * Send a login request for `username` and `password` to `config.auth.loginPath`
 * and return the response, without changing the world. The body is
 * `config.auth.loginBody(username, password)`, by default
 * `{ email: username, password }`.
 */
export async function requestLogin(
  config: FrameworkConfig,
  username: string,
  password: string,
): Promise<LoginResponse> {
  const auth = config.auth ?? {}
  if (!auth.loginPath) {
    throw new Error(
      'auth.loginPath is not configured. Set it in the options you pass to registerHooks.',
    )
  }
  const body = auth.loginBody ? auth.loginBody(username, password) : { email: username, password }
  const res = await fetch(`${requireApiBaseUrl(config)}${auth.loginPath}`, {
    method: auth.loginMethod ?? 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })
  return { status: res.status, body: parsed, headers }
}

/**
 * Decode a JWT's claims without verifying its signature, for assertions on
 * tokens the API under test issued.
 */
export function jwtClaims(token: string): Record<string, unknown> {
  // Errors describe the token without printing it, so it doesn't land in CI logs.
  const payload = token.split('.')[1]
  if (!payload) throw new Error(`Not a JWT (${token.length} characters, no payload section)`)
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch (err) {
    throw new Error(`JWT payload is not JSON: ${(err as Error).message}`)
  }
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new Error(`JWT payload is not an object of claims: ${typeof claims}`)
  }
  return claims as Record<string, unknown>
}
