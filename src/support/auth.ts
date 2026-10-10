import { Before } from '@cucumber/cucumber'
import { requireApiBaseUrl } from './config'
import type { ComponentTestWorld } from './world'
import type { FrameworkConfig } from '../types'
import { valueAt } from '../utils/json-path'

const DEFAULT_TOKEN_PATH = 'access_token'
const DEFAULT_REFRESH_TOKEN_PATH = 'refresh_token'

function tokenAt(body: unknown, path: string): string | undefined {
  try {
    const value = valueAt(body, path)
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Take the access token (and refresh token, if there is one) from a response
 * body and make them the world's current tokens. Where they are is set by
 * `config.auth.tokenPath` and `refreshTokenPath`, which default to
 * `access_token` and `refresh_token`. With `require` (the default), a body
 * with no access token is an error; without it, nothing changes.
 */
export function adoptTokens(
  world: ComponentTestWorld,
  body: unknown,
  { require = true }: { require?: boolean } = {},
): void {
  const tokenPath = world.config.auth?.tokenPath ?? DEFAULT_TOKEN_PATH
  const accessToken = tokenAt(body, tokenPath)
  if (!accessToken) {
    if (require) {
      throw new Error(`No token at "${tokenPath}" in the response: ${JSON.stringify(body)}`)
    }
    return
  }
  world.accessToken = accessToken
  const refreshToken = tokenAt(
    body,
    world.config.auth?.refreshTokenPath ?? DEFAULT_REFRESH_TOKEN_PATH,
  )
  if (refreshToken) world.refreshToken = refreshToken
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
 * Log in and make the returned tokens the world's current ones. Throws if the
 * login fails or returns no token. Doesn't change `lastResponse`, so a step
 * before the login can still be asserted on.
 */
export async function login(
  world: ComponentTestWorld,
  username: string,
  password: string,
): Promise<void> {
  const res = await requestLogin(world.config, username, password)
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`login as ${username} failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  adoptTokens(world, res.body)
}

/**
 * Decode a JWT's claims without verifying its signature, for assertions on
 * tokens the API under test issued.
 */
export function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  if (!payload) throw new Error(`Not a JWT: ${token}`)
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch (err) {
    throw new Error(`JWT payload is not JSON: ${(err as Error).message}`)
  }
}

/** Options for {@link registerLoginTag}. */
export interface LoginTagOptions {
  /** The user to log in as. Called after `before`, so it can use what `before` set up. */
  credentials:
    | { username: string; password: string }
    | ((
        world: ComponentTestWorld,
      ) => { username: string; password: string } | Promise<{ username: string; password: string }>)
  /** Runs first, e.g. to seed the user and their data. */
  before?: (world: ComponentTestWorld) => unknown | Promise<unknown>
  /**
   * Reuse the tokens from this worker's first login for the tag, instead of
   * logging in for every scenario. Only safe when the user and its session
   * outlive a scenario (not when cleanup deletes the user).
   */
  cache?: boolean
}

const cachedTokens = new Map<string, { accessToken: string; refreshToken: string | null }>()

/**
 * Log in before every scenario tagged `tag`: run `before` (to seed the user),
 * then log in with `credentials`. Replaces hand-written `@auth-required`
 * style hooks.
 *
 * @example
 * registerLoginTag('@auth-required', {
 *   before: (world) => seedUser(world, 'owner@example.com'),
 *   credentials: { username: 'owner@example.com', password: 'Sup3rSecret!' },
 * })
 */
export function registerLoginTag(tag: string, options: LoginTagOptions): void {
  Before({ tags: tag }, async function (this: ComponentTestWorld) {
    await options.before?.(this)
    const { username, password } =
      typeof options.credentials === 'function'
        ? await options.credentials(this)
        : options.credentials
    const key = `${tag}\u0000${username}`
    const cached = options.cache ? cachedTokens.get(key) : undefined
    if (cached) {
      this.accessToken = cached.accessToken
      this.refreshToken = cached.refreshToken
      return
    }
    try {
      await login(this, username, password)
    } catch (err) {
      ;(err as Error).message = `${tag}: ${(err as Error).message}`
      throw err
    }
    if (options.cache && this.accessToken) {
      cachedTokens.set(key, { accessToken: this.accessToken, refreshToken: this.refreshToken })
    }
  })
}
