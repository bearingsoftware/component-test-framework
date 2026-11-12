import { Given, Then, When } from '@cucumber/cucumber'
import { strict as assert } from 'assert'
import * as path from 'path'
import type { ComponentTestWorld } from '../../support/world'
import { eventually, StopRetrying, waitTimeout } from '../../support/eventually'
import { graphql } from '../../mocking/graphql'
import type { OperationKind, OperationStub } from '../../mocking/graphql'

/**
 * Wait until WireMock has received exactly `count` requests matching the
 * pattern. Counts only grow, so overshooting fails at once.
 */
async function waitForExactRequestCount(
  world: ComponentTestWorld,
  urlPathPattern: string,
  count: number,
): Promise<void> {
  await eventually(
    async () => {
      const actual = await world.wiremock.getRequestCount(urlPathPattern)
      const message = `Expected ${count} calls to ${urlPathPattern}, got ${actual}`
      if (actual > count) throw new StopRetrying(message)
      assert.equal(actual, count, message)
    },
    { timeout: waitTimeout(world.config) },
  )
}

Given(
  'the {word} API is stubbed from {word}',
  async function (this: ComponentTestWorld, _provider: string, stubDir: string) {
    const fullPath = path.resolve(this.config.fixturesDir, stubDir)
    await this.wiremock.loadMappingsFromDir(fullPath)
  },
)

Given(
  'the WireMock stub {string} is registered',
  async function (this: ComponentTestWorld, relPath: string) {
    const rootDir =
      this.config.wiremockStubsDir ?? path.resolve(this.config.fixturesDir, 'wiremock')
    await this.wiremock.addStubFromFile(relPath, rootDir)
  },
)

Given(
  'the {word} API returns HTTP {int}',
  async function (this: ComponentTestWorld, provider: string, status: number) {
    await this.wiremock.addStub({
      name: `${provider}-override-${status}`,
      request: { urlPathPattern: `.*` },
      response: {
        status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Stubbed ${status} for ${provider}` }),
      },
      priority: 1,
    })
  },
)

Given(
  'the {word} API at {string} returns HTTP {int}',
  async function (this: ComponentTestWorld, _provider: string, urlPath: string, status: number) {
    await this.wiremock.addStub({
      request: { urlPath },
      response: {
        status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Stubbed ${status}` }),
      },
      priority: 1,
    })
  },
)

Given(
  'the {word} API at {string} returns the response {word}',
  async function (
    this: ComponentTestWorld,
    _provider: string,
    urlPath: string,
    responseFixture: string,
  ) {
    const { loadFixture } = await import('../../support/fixtures')
    const body = loadFixture('responses', responseFixture, this.config.fixturesDir)
    await this.wiremock.addStub({
      request: { urlPath },
      response: {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: body,
      },
      priority: 1,
    })
  },
)

Then(
  'the {word} API at {string} was called {int} time(s)',
  async function (
    this: ComponentTestWorld,
    _provider: string,
    urlPathPattern: string,
    count: number,
  ) {
    await waitForExactRequestCount(this, urlPathPattern, count)
  },
)

Then(
  'the {word} API was called {int} time(s)',
  async function (this: ComponentTestWorld, provider: string, count: number) {
    await waitForExactRequestCount(this, `/${provider}/.*`, count)
  },
)

// COMPONENT-14: stateful stubs. A scenario's stubs answer by its state, so a
// test can move it on mid-scenario, say from failing to recovered, without
// loading other stubs. Under worker isolation each worker has its own.
When(
  'the WireMock scenario {string} is moved to state {string}',
  async function (this: ComponentTestWorld, name: string, state: string) {
    await this.wiremock.setScenarioState(name, state)
  },
)

Then(
  'the WireMock scenario {string} is in state {string}',
  async function (this: ComponentTestWorld, name: string, state: string) {
    await eventually(
      async () => {
        const actual = await this.wiremock.getScenarioState(name)
        if (actual === undefined) throw new StopRetrying(`WireMock has no scenario "${name}"`)
        assert.equal(actual, state, `WireMock scenario "${name}" is in state "${actual}"`)
      },
      { timeout: waitTimeout(this.config) },
    )
  },
)

// COMPONENT-23: GraphQL operations, matched by operationName or by the name in
// the query text. A service's endpoint comes from config.graphql.endpoints.
function graphqlEndpoint(world: ComponentTestWorld, service: string): string {
  return world.config.graphql?.endpoints?.[service] ?? '/graphql'
}

function operationKind(kind: string): OperationKind {
  if (kind === 'query' || kind === 'mutation' || kind === 'operation') return kind
  throw new Error(`Expected "query", "mutation" or "operation" in the step, got "${kind}"`)
}

function graphqlStub(
  world: ComponentTestWorld,
  service: string,
  kind: string,
  name: string,
): OperationStub {
  return graphql.endpoint(graphqlEndpoint(world, service))[operationKind(kind)](name)
}

Given(
  'the {word} GraphQL {word} {word} returns:',
  async function (
    this: ComponentTestWorld,
    service: string,
    kind: string,
    name: string,
    doc: string,
  ) {
    await this.wiremock.register(
      graphqlStub(this, service, kind, name).willReturnData(JSON.parse(doc)),
    )
  },
)

Given(
  'the {word} GraphQL {word} {word} returns the errors:',
  async function (
    this: ComponentTestWorld,
    service: string,
    kind: string,
    name: string,
    doc: string,
  ) {
    await this.wiremock.register(
      graphqlStub(this, service, kind, name).willReturnErrors(JSON.parse(doc)),
    )
  },
)

Given(
  'the {word} GraphQL {word} {word} with variables {string} returns:',
  async function (
    this: ComponentTestWorld,
    service: string,
    kind: string,
    name: string,
    variables: string,
    doc: string,
  ) {
    await this.wiremock.register(
      graphqlStub(this, service, kind, name)
        .withVariables(JSON.parse(variables))
        .willReturnData(JSON.parse(doc)),
    )
  },
)

Then(
  'the {word} GraphQL {word} {word} was called {int} time(s)',
  async function (
    this: ComponentTestWorld,
    service: string,
    kind: string,
    name: string,
    count: number,
  ) {
    const endpoint = graphqlEndpoint(this, service)
    const k = operationKind(kind)
    await eventually(
      async () => {
        const actual = await this.wiremock.graphqlRequestCount(endpoint, name, { kind: k })
        const message = `Expected ${count} calls to ${service} GraphQL ${kind} ${name} at ${endpoint}, got ${actual}`
        if (actual > count) throw new StopRetrying(message)
        assert.equal(actual, count, message)
      },
      { timeout: waitTimeout(this.config) },
    )
  },
)
