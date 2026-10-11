// `@bearingsoftware/component-test-framework/playwright-test`: the SPA server,
// WireMock, stub loading, logins and coverage as Playwright Test fixtures, for
// suites that don't use Cucumber. Imports no Cucumber.
export { defineFixtures } from './playwright-test/fixtures'
export type {
  FixtureOptions,
  SpaFixtureOptions,
  StubLoader,
  Tokens,
  AuthHelper,
  TestFixtures,
  WorkerFixtures,
} from './playwright-test/fixtures'
export { WireMockClient } from './clients/wiremock-client'
export { startSpaServer } from './spa/spa-server'
export type { SpaServer, SpaServerOptions } from './spa/spa-server'
export { createCoverageCollector } from './spa/coverage-collector'
export type {
  CoverageCollector,
  CoverageCollectorOptions,
  CoverageRun,
} from './spa/coverage-collector'
export { wiremockNamespace } from './support/worker'
export { jwtClaims } from './support/login'
export { signHS256 } from './utils/jwt'
