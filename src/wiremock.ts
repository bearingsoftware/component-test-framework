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
export { wiremockAdapter } from './adapters/wiremock'
export type { WireMockAdapterOptions } from './adapters/wiremock'
export { stub, StubBuilder, valueMatcher } from './mocking/rest'
export type { Buildable, Mapping, ValueMatcher } from './mocking/rest'
export { graphql, OperationStub, operationBodyPatterns } from './mocking/graphql'
export type {
  GraphQLEndpoint,
  GraphQLError,
  GraphQLResponse,
  OperationKind,
} from './mocking/graphql'
