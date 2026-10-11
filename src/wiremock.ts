// `@bearingsoftware/component-test-framework/wiremock`: the WireMock client
// and its steps. Registers nothing on import.
export { WireMockClient, requestPattern, describeRequests } from './clients/wiremock-client'
export type { RequestFilter, WireMockClientOptions } from './clients/wiremock-client'
export { namespaceStub, namespaceUrlMatcher, namespaceId } from './clients/wiremock-client'
export { registerWiremockSteps } from './steps/register'
