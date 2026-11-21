// `@bearingsoftware/component-test-framework/stubs`: capture servers (HTTP,
// HTTPS, TCP, UDP) that record what a service sends and answer as scripted,
// and their opt-in steps. Registers nothing on import.
export { startCaptureServer } from './stubs/capture-server'
export type {
  CaptureKind,
  CaptureRule,
  CaptureServer,
  CaptureServerOptions,
  Reply,
} from './stubs/capture-server'
export { parseMatch } from './stubs/match'
export type { CaptureMatch, CapturedRequest } from './stubs/match'
export { registerStubSteps } from './stubs/stub.steps'
export type { StubSource, StubStepOptions } from './stubs/stub.steps'
