import type { Page } from '@playwright/test'
import type { ITestCaseHookParameter } from '@cucumber/cucumber'
import type { ComponentTestWorld } from '../support/world'
import type { BasePage } from '../pages/base.page'

/** Maps an OpenAPI operationId to its HTTP method and URL path. */
export interface OperationEntry {
  method: string
  path: string
}

/** Consumer-provided map of operationId -> HTTP method and path. */
export type OperationMap = Record<string, OperationEntry>

/** Record of a single service call made during a scenario. */
export interface CallRecord {
  service: string
  requestFile: string
  response: { status: number; body: unknown; headers?: Record<string, string> }
  timestamp: Date
}

/** Snapshot of a UI element value captured during a scenario step. */
export interface UIStateSnapshot {
  step: string
  values: Record<string, string>
}

/**
 * Points in the framework's per-scenario lifecycle where suite code runs in
 * a known order, rather than depending on the order hooks were registered.
 * Each receives the scenario's world.
 */
export interface LifecycleHooks {
  /**
   * After the framework's per-scenario reset (world state, WireMock reset and
   * baseline stubs, Redis flush). It runs before the framework's @ui hook, so
   * there's no page yet, and before Before hooks registered after
   * registerHooks.
   */
  afterReset?: (world: ComponentTestWorld) => unknown | Promise<unknown>
  /**
   * When a scenario has failed (including an undefined, ambiguous or pending
   * step), before anything is torn down: the page is still open, so this is
   * the place to save a screenshot or the HTML. If it throws, cleanup still
   * runs and the error is reported after it.
   */
  onScenarioFailed?: (
    world: ComponentTestWorld,
    scenario: ITestCaseHookParameter,
  ) => unknown | Promise<unknown>
  /**
   * In @ui scenarios, just before the framework closes the page: for
   * example to collect browser-side coverage. The page is closed even if this
   * throws.
   */
  beforePageClose?: (world: ComponentTestWorld) => unknown | Promise<unknown>
}

/** A page object class, as the `pages` option takes it. */
export type PageClass = new (page: Page, baseUrl: string) => BasePage

/** How the API under test issues tokens, for the login and token steps. */
export interface AuthOptions {
  /**
   * Where the access token is in a login (or token) response body, as a dot
   * path. Default `access_token`.
   */
  tokenPath?: string
  /** Where the refresh token is, if any. Default `refresh_token`. */
  refreshTokenPath?: string
  /** Path of the login endpoint, e.g. `/auth/login`. Needed by the login steps. */
  loginPath?: string
  /** HTTP method for login. Default `POST`. */
  loginMethod?: string
  /**
   * The login request body for a username and password. Default
   * `{ email: username, password }`.
   */
  loginBody?: (username: string, password: string) => unknown
}

/**
 * What `registerHooks` keeps apart between Cucumber `--parallel` workers.
 * Each part takes effect only in a parallel run: run serially, a suite with
 * these set behaves exactly as without them.
 */
export interface WorkerIsolationOptions {
  /**
   * Share one WireMock between workers, each under its own path prefix
   * (`/__worker-<n>`): the worker's stubs match only under its prefix, and
   * the per-scenario reset removes only its own stubs and requests. The
   * service under test, or the SPA server, must call WireMock at
   * `workerWiremockUrl(url)`.
   */
  wiremock?: boolean
  /**
   * Give each worker its own database, `<name>_w<n>`, created before the
   * first scenario as a copy of the configured database (or of `template`).
   * The service under test must use `workerDatabaseUrl(url)`, and should
   * await `prepareWorkerDatabase(url)` before it starts.
   */
  database?: boolean | { template?: string }
  /**
   * Give each worker its own Redis database index: the URL's index plus the
   * worker number. The per-scenario flush then empties only the worker's
   * own. The service under test must use `workerRedisUrl(url)`. Pub/sub
   * channels are shared across databases, so workers must not rely on
   * channel names alone being theirs.
   */
  redis?: boolean
}

/** Framework configuration — consumers provide their project-specific values. */
export interface FrameworkConfig {
  /** Base URL of the API service under test. */
  apiBaseUrl: string
  /** Base URL of the web UI under test. */
  webBaseUrl?: string
  /** WireMock admin base URL. */
  wiremockUrl: string
  /** PostgreSQL connection string for direct DB access. */
  databaseUrl?: string
  /** Redis connection string for cache access. */
  redisUrl?: string
  /** Path to the consumer's fixtures directory. */
  fixturesDir: string
  /**
   * Root directory for WireMock stub mapping files registered at runtime via
   * {@link WireMockClient.addStubFromFile}. Defaults to `{fixturesDir}/wiremock`.
   */
  wiremockStubsDir?: string
  /** Consumer-provided OpenAPI operation map. */
  operationMap?: OperationMap
  /** How the API issues tokens. See {@link AuthOptions}. */
  auth?: AuthOptions
  /** Suite code to run at fixed points in each scenario. See {@link LifecycleHooks}. */
  hooks?: LifecycleHooks
  /**
   * Page objects by name, created for every @ui scenario with its page and
   * `webBaseUrl` and put in `world.pageRegistry`, so a suite needn't register
   * them in a hook of its own.
   */
  pages?: Record<string, PageClass>
  /**
   * WireMock stub directories, relative to `fixturesDir`, each laid out as
   * `<dir>/mappings/*.json`, loaded after every reset: stubs most scenarios need, such as a login, so each scenario's
   * own stubs are only what's particular to it. A scenario's stubs are
   * added later, so they win where both match at the same priority.
   */
  wiremockBaseline?: string[]
  /**
   * How to clean up after each scenario, for state `cleanupTables` doesn't
   * cover (another database, a queue, files). Runs after the `cleanupTables`
   * cleanup when both are set.
   */
  cleanup?: (world: ComponentTestWorld) => unknown | Promise<unknown>
  /** Tables to truncate between scenarios (with CASCADE). */
  cleanupTables?: string[]
  /**
   * Keep Cucumber `--parallel` workers apart: WireMock by path prefix,
   * Postgres by database, Redis by database index. Opt-in, and only used in
   * a parallel run. See {@link WorkerIsolationOptions}.
   */
  workerIsolation?: WorkerIsolationOptions
  /**
   * Default timeout in milliseconds for every step and hook, applied through
   * Cucumber's `setDefaultTimeout`. Cucumber's own default is 5s. Leave unset
   * to keep whatever the suite configures itself.
   */
  defaultStepTimeout?: number
  /**
   * How long waiting steps poll before failing, in ms. Defaults to 1s less
   * than `defaultStepTimeout`, so a failed wait reports what it was waiting
   * for before Cucumber's timeout fires. Without either, steps that used to
   * check once wait up to 4s, and steps that always waited keep their 30s.
   */
  waitTimeout?: number
  /**
   * How long waits for background work poll before failing, in ms: the DB
   * record waits and the opt-in WireMock and database waiting steps. Default
   * 30s, which the record waits have always used.
   */
  serviceWaitTimeout?: number
}

/**
 * Options accepted by `registerHooks`. The same as {@link FrameworkConfig},
 * except the API and WireMock URLs are optional, so a suite that doesn't
 * call an API or use WireMock can leave them out. A missing URL is stored on
 * `world.config` as an empty string, and anything that needs it throws a
 * clear error.
 */
export type FrameworkOptions = Omit<FrameworkConfig, 'apiBaseUrl' | 'wiremockUrl'> & {
  apiBaseUrl?: string
  wiremockUrl?: string
}
