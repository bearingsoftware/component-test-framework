// `@bearingsoftware/component-test-framework/wiremock`: the WireMock client
// and its steps. Registers nothing on import.
export { WireMockClient, requestPattern, describeRequests } from './clients/wiremock-client'
export type {
  RequestFilter,
  WireMockClientOptions,
  WireMockScenario,
} from './clients/wiremock-client'
export {
  namespaceStub,
  namespaceUrlMatcher,
  namespaceId,
  namespaceScenarioName,
} from './clients/wiremock-client'
export { registerWiremockSteps } from './steps/register'
