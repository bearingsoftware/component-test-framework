import { Before } from '@cucumber/cucumber'
import type { ComponentTestWorld } from './world'
import {
  DEFAULT_REFRESH_TOKEN_PATH,
  DEFAULT_TOKEN_PATH,
  jwtClaims,
  requestLogin,
  shapeOf,
  tokenAt,
  type LoginResponse,
} from './login'

export { jwtClaims, requestLogin }
export type { LoginResponse }

/** Options for {@link adoptTokens}. */
export interface AdoptTokensOptions {
  /** Fail when there's no access token. Default true; when false, nothing changes. */
  require?: boolean
  /**
   * What to do with the refresh token: `replace` (default) sets it, or clears
   * it when the response has none, so an earlier user's can't linger;
   * `require` fails when there's none; `keep` leaves the current one when
   * there's none.
   */
  refresh?: 'replace' | 'require' | 'keep'
}

/**
 * Take the access token (and refresh token) from a response body and make
 * them the world's current tokens. Where they are is set by
 * `config.auth.tokenPath` and `refreshTokenPath`, which default to
 * `access_token` and `refresh_token`.
 */
export function adoptTokens(
  world: ComponentTestWorld,
  body: unknown,
  { require = true, refresh = 'replace' }: AdoptTokensOptions = {},
): void {
  const tokenPath = world.config.auth?.tokenPath ?? DEFAULT_TOKEN_PATH
  const refreshPath = world.config.auth?.refreshTokenPath ?? DEFAULT_REFRESH_TOKEN_PATH
  const accessToken = tokenAt(body, tokenPath)
  const refreshToken = tokenAt(body, refreshPath)
  if (!accessToken) {
    if (require)
      throw new Error(`No token at "${tokenPath}" in the response, which has ${shapeOf(body)}`)
    return
  }
  if (refresh === 'require' && !refreshToken) {
    throw new Error(
      `No refresh token at "${refreshPath}" in the response, which has ${shapeOf(body)}`,
    )
  }
  world.accessToken = accessToken
  if (refreshToken || refresh !== 'keep') world.refreshToken = refreshToken ?? null
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
   * logging in for every scenario. Only safe when the user, its session and
   * everything its token refers to outlive a scenario. Not when cleanup
   * deletes the user, when `before` seeds new data the token carries (such
   * as a household id in a claim), or when a scenario logs out, revokes or
   * rotates the session. {@link clearLoginCache} empties it.
   */
  cache?: boolean
}

const cachedTokens = new Map<string, { accessToken: string; refreshToken: string | null }>()

/** Forget every login cached by {@link registerLoginTag}. */
export function clearLoginCache(): void {
  cachedTokens.clear()
}

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
    if (!this.config) {
      throw new Error(
        `${tag}: the framework isn't set up for this scenario. Call registerHooks before registerLoginTag.`,
      )
    }
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
