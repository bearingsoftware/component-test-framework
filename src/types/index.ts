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
  /** Tables to truncate between scenarios (with CASCADE). */
  cleanupTables?: string[]
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
