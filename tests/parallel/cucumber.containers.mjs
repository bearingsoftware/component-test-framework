// The parallel reference suite with its services in Testcontainers: no
// DATABASE_URL, REDIS_URL or WIREMOCK_URL set, so startContainers starts them
// (npm run containers:test). Set any of them and that service is yours instead.
import { createRequire } from 'node:module'
import { startContainers } from '../../dist/testcontainers.js'

const require = createRequire(import.meta.url)
const { prepare } = require('./prepare.js')
const profile = require('./cucumber.js').default

await startContainers({
  postgres: { image: 'postgres:17-alpine', database: 'ctf_reference' },
  redis: { image: 'valkey/valkey:8-alpine' },
  wiremock: { image: 'wiremock/wiremock:3.13.2' },
})
// The template database npm run test:parallel makes before the suite.
await prepare(process.env.DATABASE_URL)

export default profile
