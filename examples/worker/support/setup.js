// A worker, Postgres and Redis. There is no API: the scenarios publish to
// Redis and then wait for the worker's row and key.
const path = require('path')
const core = require('../../../dist/core')
const { registerDbSteps } = require('../../../dist/postgres')
const { registerRedisSteps } = require('../../../dist/redis')

const SUITE = path.resolve(__dirname, '..')
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55440/postgres'
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:56390'
const PORT = Number(process.env.EXAMPLE_WORKER_PORT ?? 18102)

core.registerServiceUnderTest({
  name: 'worker',
  cwd: SUITE,
  cmd: process.execPath,
  args: [path.join(SUITE, 'service', 'worker.js')],
  env: { ...process.env, PORT: String(PORT), DATABASE_URL, REDIS_URL },
  logFile: path.join(SUITE, 'reports', 'worker.log'),
  readyCheck: { url: `http://localhost:${PORT}/` },
})

core.registerHooks({
  ...core.loadConfig(),
  // No WireMock and no API in this suite.
  wiremockUrl: undefined,
  apiBaseUrl: undefined,
  databaseUrl: DATABASE_URL,
  redisUrl: REDIS_URL,
  cleanupTables: ['worker_jobs'],
})

registerDbSteps()
registerRedisSteps()
