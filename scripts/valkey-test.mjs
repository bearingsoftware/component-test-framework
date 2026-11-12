// Runs the Redis client and step tests against Valkey: REDIS_URL is taken
// from VALKEY_URL. Without VALKEY_URL it skips, so `npm test` still passes.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const url = process.env.VALKEY_URL
if (!url) {
  console.log('VALKEY_URL is not set; skipping the Valkey tests.')
  process.exit(0)
}
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const { status } = spawnSync(
  process.execPath,
  [vitest, 'run', 'src/clients/redis-client.test.ts', 'src/steps/redis-steps'],
  { stdio: 'inherit', env: { ...process.env, REDIS_URL: url } },
)
process.exit(status ?? 1)
