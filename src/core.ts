// The core entry point: `@bearingsoftware/component-test-framework/core`.
//
// Unlike the package root, importing it registers no steps, and loads no
// database, Redis or Playwright code. Register the steps a suite uses with
// the register…Steps functions, and the stack-specific pieces come from the
// adapter entry points (/wiremock, /postgres, /redis, /playwright).

// Types
export type {
  OperationEntry,
  OperationMap,
  CallRecord,
  UIStateSnapshot,
  FrameworkConfig,
  FrameworkOptions,
  AuthOptions,
  LifecycleHooks,
  PageClass,
  WorkerIsolationOptions,
} from './types'

// Setup
export { ComponentTestWorld } from './support/world'
export { loadConfig, requireApiBaseUrl } from './support/config'
export { loadFixture, listFixtures } from './support/fixtures'
export { registerHooks } from './support/hooks'

// Services under test
export {
  spawnServiceUnderTest,
  startService,
  stopServices,
  registerServiceUnderTest,
} from './support/process'
export type {
  SpawnServiceOptions,
  SpawnServiceHandle,
  ServiceOptions,
  ServiceHandle,
  RegisteredService,
} from './support/process'

// Parallel runs
export {
  currentWorker,
  workerPort,
  workerFile,
  wiremockNamespace,
  workerWiremockUrl,
  workerDatabaseUrl,
  workerRedisUrl,
} from './support/worker'
export type { WorkerInfo } from './support/worker'
export { prepareWorkerDatabase } from './support/worker-database'
export type { WorkerDatabaseOptions } from './support/worker-database'

// Waiting
export {
  eventually,
  holdsFor,
  StopRetrying,
  isStopRetrying,
  waitTimeout,
  serviceWaitTimeout,
} from './support/eventually'
export type { EventuallyOptions, HoldsForOptions } from './support/eventually'

// Requests, values and login
export { sendOperation, fillPath, EMPTY_REQUEST } from './support/requests'
export type { SendOperationOptions } from './support/requests'
export { rawRequest } from './support/raw-request'
export { readSSE } from './support/sse'
export {
  adoptTokens,
  login,
  requestLogin,
  jwtClaims,
  registerLoginTag,
  clearLoginCache,
} from './support/auth'
export type { AdoptTokensOptions, LoginResponse, LoginTagOptions } from './support/auth'

// Utilities
export { signHS256, base64UrlEncode } from './utils/jwt'
export { assertPartialMatch } from './utils/match'
export type { PartialMatchOptions } from './utils/match'
export { valueAt } from './utils/json-path'

// Steps, registered only when asked for
export {
  registerApiSteps,
  registerRawApiSteps,
  registerSseSteps,
  registerResponseSteps,
  registerWiremockSteps,
  registerDbSteps,
  registerRedisSteps,
  registerServiceSteps,
  registerUiSteps,
} from './steps/register'
export { registerWaitingSteps } from './steps/waiting.steps'
export type { WaitingStepOptions } from './steps/waiting.steps'
export type { RedisStepOptions } from './steps/common/redis.steps'
export { registerRequestSteps } from './steps/request.steps'
