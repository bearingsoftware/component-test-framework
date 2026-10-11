// `@bearingsoftware/component-test-framework/spa`: testing a built single-page
// app. A static server that forwards API calls to WireMock, browser-side
// coverage, failure screenshots, and browser helpers. Registers nothing on
// import; istanbul and axe are loaded only when used.
export { startSpaServer, registerSpaServer } from './spa/server'
export type { SpaServerOptions, SpaServer, RegisterSpaServerOptions } from './spa/server'
export { createCoverageCollector, registerCoverage } from './spa/coverage'
export type { CoverageCollectorOptions, CoverageCollector } from './spa/coverage'
export {
  saveFailureArtifacts,
  addVirtualAuthenticator,
  registerWebAuthnTag,
  blockRoutes,
  registerRouteBlocks,
  registerAccessibilitySteps,
} from './spa/browser'
export type { BlockedRoute, AccessibilityOptions } from './spa/browser'
