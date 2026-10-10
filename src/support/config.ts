import type { FrameworkConfig } from '../types'

/**
 * Load framework configuration from environment variables.
 * Consumer can override any field by passing partial config.
 */
export function loadConfig(overrides?: Partial<FrameworkConfig>): FrameworkConfig {
  return {
    apiBaseUrl: process.env.API_BASE_URL ?? 'http://localhost:8080',
    webBaseUrl: process.env.WEB_BASE_URL ?? 'http://localhost:3000',
    wiremockUrl: process.env.WIREMOCK_URL ?? 'http://localhost:8443',
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    fixturesDir: process.env.FIXTURES_DIR ?? './fixtures',
    wiremockStubsDir: process.env.WIREMOCK_STUBS_DIR,
    ...overrides,
  }
}

/**
 * Return the configured API base URL, or throw if the suite didn't set one.
 * Used by every step that calls the API under test.
 */
export function requireApiBaseUrl(config: FrameworkConfig): string {
  if (!config.apiBaseUrl) {
    throw new Error(
      'apiBaseUrl is not configured. Set API_BASE_URL or pass apiBaseUrl to registerHooks.',
    )
  }
  return config.apiBaseUrl
}
