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
}
