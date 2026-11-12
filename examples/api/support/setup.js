// A service, WireMock and Postgres. Every piece comes from /core or an
// adapter entry point, and registers only when asked to.
const path = require('path')
const core = require('../../../dist/core')
const { registerWiremockSteps } = require('../../../dist/wiremock')
const { registerDbSteps, registerServiceSteps } = require('../../../dist/postgres')

const SUITE = path.resolve(__dirname, '..')
const WIREMOCK_URL = process.env.WIREMOCK_URL ?? 'http://localhost:58443'
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55440/postgres'
const PORT = Number(process.env.EXAMPLE_API_PORT ?? 18101)

core.registerServiceUnderTest({
  name: 'notes',
  cwd: SUITE,
  cmd: process.execPath,
  args: [path.join(SUITE, 'service', 'notes.js')],
  env: {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL,
    MODERATION_URL: `${WIREMOCK_URL}/moderation`,
  },
  logFile: path.join(SUITE, 'reports', 'notes.log'),
  readyCheck: { url: `http://localhost:${PORT}/health` },
})

core.registerHooks({
  apiBaseUrl: `http://localhost:${PORT}`,
  wiremockUrl: WIREMOCK_URL,
  databaseUrl: DATABASE_URL,
  fixturesDir: path.join(SUITE, 'fixtures'),
  operationMap: { createNote: { method: 'POST', path: '/notes' } },
  cleanupTables: ['api_notes'],
})

core.registerApiSteps()
core.registerResponseSteps()
registerWiremockSteps()
registerDbSteps()
registerServiceSteps()
