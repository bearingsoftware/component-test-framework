import { Given, Then, When } from '@cucumber/cucumber'
import { strict as assert } from 'assert'
import * as path from 'path'
import type { ComponentTestWorld } from '../../support/world'
import { eventually, StopRetrying, waitTimeout } from '../../support/eventually'

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
