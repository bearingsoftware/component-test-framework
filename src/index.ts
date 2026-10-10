// Types
export type {
  OperationEntry,
  OperationMap,
  CallRecord,
  UIStateSnapshot,
  FrameworkConfig,
  FrameworkOptions,
} from './types'

// Support
export { ComponentTestWorld } from './support/world'
export { loadConfig, requireApiBaseUrl } from './support/config'
export { loadFixture, listFixtures } from './support/fixtures'
export { registerHooks } from './support/hooks'
export { spawnServiceUnderTest } from './support/process'
export {
  eventually,
  holdsFor,
  StopRetrying,
  isStopRetrying,
  waitTimeout,
  serviceWaitTimeout,
} from './support/eventually'
export type { EventuallyOptions, HoldsForOptions } from './support/eventually'
export { countRows, assertSafeTableName, requireDb, queryOnce } from './support/db'
export type { SpawnServiceOptions, SpawnServiceHandle } from './support/process'

// Clients
export { WireMockClient } from './clients/wiremock-client'
export { requestPattern, describeRequests } from './clients/wiremock-client'
export type { RequestFilter } from './clients/wiremock-client'
export { DbClient } from './clients/db-client'
export { RedisClient } from './clients/redis-client'
export type { PubSubSubscription } from './clients/redis-client'

// Pages
export { BasePage } from './pages/base.page'

// Utilities
export { signHS256, base64UrlEncode } from './utils/jwt'
export { assertPartialMatch } from './utils/match'
export type { PartialMatchOptions } from './utils/match'

// Step definitions — importing these modules registers them with Cucumber.
// Consumers should import the ones they need in their support setup.
export * as apiSteps from './steps/api/generic-api.steps'
export * as rawApiSteps from './steps/api/raw-api.steps'
export * as sseSteps from './steps/api/sse.steps'
export * as responseSteps from './steps/common/response-assertion.steps'
export * as dbAssertionSteps from './steps/common/db-assertion.steps'
export * as wiremockSteps from './steps/common/wiremock.steps'
export * as redisSteps from './steps/common/redis.steps'
export * as serviceSteps from './steps/worker/generic-service.steps'
export * as uiSteps from './steps/ui/generic-ui.steps'

// Opt-in steps: registered only when called, so they can't clash with a
// suite's own copies (see registerWaitingSteps).
export { registerWaitingSteps } from './steps/waiting.steps'
export type { WaitingStepOptions } from './steps/waiting.steps'

// Helpers exposed so consumers can compose their own raw-request step defs.
export { rawRequest } from './steps/api/raw-api.steps'
export { readSSE } from './steps/api/sse.steps'
