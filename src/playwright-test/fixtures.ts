import * as fs from 'fs'
import * as path from 'path'
import { test as base } from '@playwright/test'
import type { Page, WorkerInfo } from '@playwright/test'
import { WireMockClient } from '../clients/wiremock-client'
import { startSpaServer, type SpaServer, type SpaServerOptions } from '../spa/spa-server'
import {
  createCoverageCollector,
  type CoverageCollector,
  type CoverageCollectorOptions,
} from '../spa/coverage-collector'
import { wiremockNamespace } from '../support/worker'
import {
  DEFAULT_REFRESH_TOKEN_PATH,
  DEFAULT_TOKEN_PATH,
  jwtClaims,
  requestLogin,
  shapeOf,
  tokenAt,
} from '../support/login'
import { signHS256 } from '../utils/jwt'
import type { AuthOptions } from '../types'

/** Options for {@link defineFixtures}. Leave a part out and its fixture throws when used. */
export interface FixtureOptions {
  /**
   * The SPA server, one per Playwright worker, or a function giving each
   * worker its own options (a `runtimeEnv` naming the worker, say).
   */
  spa?: SpaFixtureOptions | ((worker: WorkerInfo) => SpaFixtureOptions)
  wiremock?: {
    /** WireMock's root URL, e.g. `http://localhost:8443`. */
    url: string
    /**
     * Give each worker its own path prefix (`/__worker-<parallelIndex>`) on
     * the shared WireMock, as Cucumber's `workerIsolation.wiremock` does.
     * Default true.
     */
    isolate?: boolean
    /**
     * Reset this worker's stubs and requests before every test, then load
     * `baseline` again. Default false: they're reset once, when the worker starts.
     */
    resetEachTest?: boolean
    /** Stub directories, each laid out as `<dir>/mappings/*.json`, loaded after every reset. */
    baseline?: string[]
    /** How long each admin request may take, in ms. Default 10000. */
    requestTimeoutMs?: number
  }
  /** Where the `stubs` fixture finds stub files and directories. Default the current directory. */
  stubsDir?: string
  /** How the API under test logs in, for the `auth` fixture. */
  auth?: AuthOptions & {
    /**
     * Base URL login requests go to. Default the SPA server's, so a login
     * goes the way the SPA's own does: `loginPath: '/api/auth/login'`
     * reaches the worker's WireMock stubs, or whatever `spa.apiUrl` is.
     */
    apiBaseUrl?: string
  }
  /**
   * Collect `window.__coverage__` from each test's page before it closes, and
   * merge every worker's into the reports, as `registerCoverage` does for
   * Cucumber. Needs the istanbul packages.
   */
  coverage?: CoverageCollectorOptions
}

/** The SPA server's options in {@link FixtureOptions.spa}. */
export type SpaFixtureOptions = Omit<SpaServerOptions, 'port' | 'apiUrl'> & {
  /**
   * Where API requests go. Default the worker's WireMock URL (see
   * {@link FixtureOptions.wiremock}), so the SPA's API calls reach that
   * worker's stubs.
   */
  apiUrl?: string
  /**
   * Port of the first worker's server; worker n listens on the port plus its
   * `parallelIndex`. Default 0, a free port for each worker.
   */
  basePort?: number
}

/** Loads WireMock stubs for one test, from {@link FixtureOptions.stubsDir}. */
export interface StubLoader {
  /**
   * Load a stub file (`orders/quote.json`), or a directory's stubs
   * (`orders`, laid out as `orders/mappings/*.json`).
   */
  load(...names: string[]): Promise<void>
  /** Register a stub mapping. */
  add(mapping: Record<string, unknown>): Promise<void>
}

/** The tokens a login returned. */
export interface Tokens {
  accessToken: string
  refreshToken: string | null
}

/** Logging in and handling tokens, for one test. */
export interface AuthHelper {
  /** Log in, keep the tokens and return them. Throws on a non-2xx response or no access token. */
  login(username: string, password: string): Promise<Tokens>
  /** The tokens from the last login, if any. */
  readonly tokens: Tokens | undefined
  /** `{ Authorization: 'Bearer …' }` with the last login's access token. */
  headers(): Record<string, string>
  /** A token's claims, without verifying it. Default the last login's access token. */
  claims(token?: string): Record<string, unknown>
  /** Sign claims as an HS256 JWT, e.g. to forge an expired or foreign token. */
  sign(claims: Record<string, unknown>, secret: string): string
  /**
   * Put the last login's access token in the page's localStorage under
   * `key` before any of its scripts run, for an SPA that reads its session
   * from there.
   */
  storeInLocalStorage(page: Page, key: string): Promise<void>
}

/** Fixtures for each test. */
export interface TestFixtures {
  stubs: StubLoader
  auth: AuthHelper
  _wiremockReset: void
}

/** Fixtures for each worker. */
export interface WorkerFixtures {
  spaServer: SpaServer
  wiremock: WireMockClient
  /**
   * The URL the service under test, or the SPA server, should call WireMock
   * at: the root URL, plus this worker's prefix when isolated.
   */
  wiremockUrl: string
  coverage: CoverageCollector | undefined
}

/** What `storeInLocalStorage` uses in the browser; the package is built without the DOM types. */
interface BrowserGlobals {
  localStorage: { setItem(key: string, value: string): void }
}

function missing(fixture: string, option: string): never {
  throw new Error(`The ${fixture} fixture needs the ${option} option of defineFixtures.`)
}

/**
 * Playwright Test fixtures for a component suite: the SPA server, WireMock,
 * stub loading, logins and coverage, each kept apart between Playwright
 * workers. Returns a `test` to write tests with in place of Playwright's.
 * `baseURL` is the SPA server's, so `page.goto('/')` opens the app.
 *
 * Uses no Cucumber.
 *
 * @example
 * export const test = defineFixtures({
 *   spa: { distDir: 'dist' },
 *   wiremock: { url: process.env.WIREMOCK_URL ?? 'http://localhost:8443', resetEachTest: true },
 *   stubsDir: path.join(__dirname, 'stubs'),
 * })
 */
export function defineFixtures(options: FixtureOptions) {
  const wm = options.wiremock
  const isolate = wm?.isolate ?? true
  const namespaceOf = (info: WorkerInfo) =>
    isolate ? wiremockNamespace(info.parallelIndex) : undefined

  async function resetWiremock(client: WireMockClient): Promise<void> {
    await client.resetAll()
    for (const dir of wm?.baseline ?? []) await client.loadMappingsFromDir(dir)
  }

  const test = base.extend<TestFixtures, WorkerFixtures>({
    wiremockUrl: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use, info) => {
        if (!wm) missing('wiremockUrl', 'wiremock')
        const ns = namespaceOf(info)
        await use(ns ? `${wm.url.replace(/\/+$/, '')}${ns}` : wm.url)
      },
      { scope: 'worker' },
    ],

    wiremock: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use, info) => {
        if (!wm) missing('wiremock', 'wiremock')
        const client = new WireMockClient(wm.url, wm.requestTimeoutMs, {
          namespace: namespaceOf(info),
        })
        // A worker that replaces a failed one, with the same parallelIndex,
        // starts clean rather than with what the failed one left.
        await resetWiremock(client)
        await use(client)
      },
      { scope: 'worker' },
    ],

    _wiremockReset: [
      async ({ wiremock }, use) => {
        await resetWiremock(wiremock)
        await use()
      },
      { auto: Boolean(wm?.resetEachTest) } as { auto: boolean },
    ],

    spaServer: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use, info) => {
        if (!options.spa) missing('spaServer', 'spa')
        const spa = typeof options.spa === 'function' ? options.spa(info) : options.spa
        const { basePort, apiUrl, ...rest } = spa
        let url = apiUrl
        if (!url) {
          if (!wm) missing('spaServer', 'spa.apiUrl (or wiremock)')
          const ns = namespaceOf(info)
          url = ns ? `${wm.url.replace(/\/+$/, '')}${ns}` : wm.url
        }
        const port = basePort ? basePort + info.parallelIndex : 0
        const server = await startSpaServer({ ...rest, apiUrl: url, port })
        await use(server)
        await server.close()
      },
      { scope: 'worker', timeout: 30_000 },
    ],

    coverage: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use, info) => {
        if (!options.coverage) return use(undefined)
        const collector = createCoverageCollector(options.coverage)
        await use(collector)
        // Playwright's workers are child processes of the runner, so its pid
        // identifies the run. workerIndex is unique, even for a worker that
        // replaces a failed one, so no worker's file overwrites another's.
        collector.write({
          key: String(process.ppid),
          worker: info.workerIndex,
          workers: info.config.workers,
        })
      },
      { scope: 'worker', auto: true },
    ],

    page: async ({ page, coverage }, use) => {
      await use(page)
      await coverage?.collect(page)
    },

    stubs: async ({ wiremock }, use) => {
      const root = path.resolve(options.stubsDir ?? '.')
      await use({
        async load(...names) {
          for (const name of names) {
            const target = path.resolve(root, name)
            if (!fs.existsSync(target)) throw new Error(`No stub file or directory at ${target}`)
            if (fs.statSync(target).isDirectory()) {
              if (!fs.existsSync(path.join(target, 'mappings'))) {
                throw new Error(`Stub directory ${target} has no mappings/ directory`)
              }
              await wiremock.loadMappingsFromDir(target)
            } else {
              await wiremock.addStubFromFile(path.relative(root, target), root)
            }
          }
        },
        add: (mapping) => wiremock.addStub(mapping),
      })
    },

    // eslint-disable-next-line no-empty-pattern
    auth: async ({}, use) => {
      await use(authHelper(options.auth, options.auth?.apiBaseUrl))
    },
  })

  // With an SPA, `page.goto('/')` opens it. Without one, baseURL is left as
  // configured, and no SPA server starts.
  if (!options.spa) return test
  const withSpa = test.extend({
    baseURL: async ({ spaServer }, use) => {
      await use(spaServer.baseUrl)
    },
  })
  // Logins go through the SPA server only when no apiBaseUrl is given, so
  // only then does using `auth` start it.
  if (options.auth?.apiBaseUrl) return withSpa
  return withSpa.extend({
    auth: async ({ spaServer }, use) => {
      await use(authHelper(options.auth, spaServer.baseUrl))
    },
  })
}

/** The `auth` fixture: logins against `apiBaseUrl`, and the tokens they return. */
function authHelper(auth: FixtureOptions['auth'], apiBaseUrl: string | undefined): AuthHelper {
  let tokens: Tokens | undefined
  const current = () => tokens ?? missingLogin()
  return {
    async login(username, password) {
      if (!auth) missing('auth', 'auth')
      if (!apiBaseUrl) missing('auth', 'auth.apiBaseUrl (or spa)')
      const { apiBaseUrl: _base, ...rest } = auth
      const res = await requestLogin(
        { apiBaseUrl, auth: rest, wiremockUrl: '', fixturesDir: '' },
        username,
        password,
      )
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`login as ${username} failed: ${res.status} ${JSON.stringify(res.body)}`)
      }
      const tokenPath = rest.tokenPath ?? DEFAULT_TOKEN_PATH
      const accessToken = tokenAt(res.body, tokenPath)
      if (!accessToken) {
        throw new Error(
          `No token at "${tokenPath}" in the login response, which has ${shapeOf(res.body)}`,
        )
      }
      tokens = {
        accessToken,
        refreshToken:
          tokenAt(res.body, rest.refreshTokenPath ?? DEFAULT_REFRESH_TOKEN_PATH) ?? null,
      }
      return tokens
    },
    get tokens() {
      return tokens
    },
    headers: () => ({ Authorization: `Bearer ${current().accessToken}` }),
    claims: (token) => jwtClaims(token ?? current().accessToken),
    sign: signHS256,
    async storeInLocalStorage(page, key) {
      const value = current().accessToken
      await page.addInitScript(
        ([k, v]) => {
          ;(globalThis as unknown as BrowserGlobals).localStorage.setItem(k, v)
        },
        [key, value] as const,
      )
    },
  }
}

function missingLogin(): never {
  throw new Error('No login yet: call auth.login(username, password) first.')
}
