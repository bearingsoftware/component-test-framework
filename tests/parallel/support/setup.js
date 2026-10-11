// The parallel reference suite (COMPONENT-11): a service under test with
// WireMock, Postgres and Redis behind it, and an SPA, run by four Cucumber
// workers at once. Every scenario uses the same stub path, table and cache
// key, so without workerIsolation the workers trample each other's state.
// CTF_NO_ISOLATION turns isolation off, to see that happen: 1 for all of
// it, or a comma-separated list of wiremock, database and redis.
const assert = require('assert')
const path = require('path')
const { Given, When, Then } = require('@cucumber/cucumber')
const core = require('../../../dist/core')
const postgres = require('../../../dist/postgres')
const spa = require('../../../dist/spa')

const WIREMOCK_URL = process.env.WIREMOCK_URL ?? 'http://localhost:58443'
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55440/ctf_reference'
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:56390'
const off = (process.env.CTF_NO_ISOLATION ?? '').split(',')
const isolated = (part) => !off.includes('1') && !off.includes(part)
const isolation = {
  wiremock: isolated('wiremock'),
  database: isolated('database'),
  redis: isolated('redis'),
}
const SUITE = path.resolve(__dirname, '..')

// The service and the SPA server, one of each per worker, on the worker's
// own port and pointed at the worker's own database, Redis and WireMock prefix.
const servicePort = core.workerPort(18100)
core.registerServiceUnderTest({
  name: 'orders',
  cwd: SUITE,
  cmd: process.execPath,
  args: [path.join(SUITE, 'service', 'orders.js')],
  env: {
    ...process.env,
    PORT: String(servicePort),
    DATABASE_URL: isolation.database ? core.workerDatabaseUrl(DATABASE_URL) : DATABASE_URL,
    REDIS_URL: isolation.redis ? core.workerRedisUrl(REDIS_URL) : REDIS_URL,
    PRICING_URL: `${isolation.wiremock ? core.workerWiremockUrl(WIREMOCK_URL) : WIREMOCK_URL}/pricing`,
  },
  // The worker's database must exist before the service connects to it.
  beforeStart: () => (isolation.database ? core.prepareWorkerDatabase(DATABASE_URL) : undefined),
  logFile: path.join(SUITE, 'reports', 'orders.log'),
  readyCheck: { url: `http://localhost:${servicePort}/health` },
})

const shop = spa.registerSpaServer({
  distDir: path.join(SUITE, 'spa'),
  apiUrl: isolation.wiremock ? core.workerWiremockUrl(WIREMOCK_URL) : WIREMOCK_URL,
  defaultPort: 3300,
  runtimeEnv: { WORKER: String(core.currentWorker().id) },
})

const coverage = spa.registerCoverage({
  outDir: path.join(SUITE, 'coverage'),
  reporters: ['json-summary'],
  onNothingCollected: 'throw',
})

core.registerHooks({
  apiBaseUrl: `http://localhost:${servicePort}`,
  wiremockUrl: WIREMOCK_URL,
  databaseUrl: DATABASE_URL,
  redisUrl: REDIS_URL,
  webBaseUrl: shop.baseUrl,
  fixturesDir: SUITE,
  cleanupTables: ['orders'],
  defaultStepTimeout: 30_000,
  workerIsolation: isolation,
  hooks: {
    beforePageClose: (world) => coverage.collect(world.page),
  },
})
core.registerWiremockSteps()
postgres.registerDbSteps()

Given('the pricing service quotes {int} for {word}', async function (price, sku) {
  await this.wiremock.addStub({
    request: { method: 'GET', urlPath: `/pricing/prices/${sku}` },
    response: { status: 200, jsonBody: { price } },
  })
})

// A WireMock scenario: the first quote, then the second. Scenario state is
// shared by name, so it too must be kept apart between workers.
Given(
  'the pricing service quotes {int} and then {int} for {word}',
  async function (first, second, sku) {
    const request = { method: 'GET', urlPath: `/pricing/prices/${sku}` }
    await this.wiremock.importStubs([
      {
        scenarioName: 'repricing',
        requiredScenarioState: 'Started',
        newScenarioState: 'repriced',
        request,
        response: { status: 200, jsonBody: { price: first } },
      },
      {
        scenarioName: 'repricing',
        requiredScenarioState: 'repriced',
        request,
        response: { status: 200, jsonBody: { price: second } },
      },
    ])
  },
)

When('I order {int} of {word}', async function (qty, sku) {
  const res = await fetch(`${this.config.apiBaseUrl}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku, qty }),
  })
  this.lastResponse = { status: res.status, body: await res.json(), headers: {} }
})

Then('the order total is {int}', function (total) {
  assert.equal(this.lastResponse.status, 201, JSON.stringify(this.lastResponse.body))
  assert.equal(this.lastResponse.body.total, total)
})

Then('the cached last order total is {int}', async function (total) {
  assert.equal(await this.redis.get('last-order-total'), String(total))
})

When('I open the shop', async function () {
  await this.page.goto(this.config.webBaseUrl)
})

Then('the shop shows the widget price {int}', async function (price) {
  await this.page.locator('#price', { hasText: String(price) }).waitFor({ timeout: 10_000 })
})

Then('the shop was served by this worker', async function () {
  assert.equal(await this.page.locator('#worker').textContent(), String(core.currentWorker().id))
})
