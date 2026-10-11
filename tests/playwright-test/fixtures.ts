import * as path from 'path'
import { defineFixtures } from '../../dist/playwright-test'

export const WIREMOCK_URL = process.env.WIREMOCK_URL ?? 'http://localhost:58443'

export const test = defineFixtures({
  // The SPA shows which worker served it, from runtimeEnv, and stands in for
  // an instrumented bundle with a coverage statement per worker.
  spa: (worker) => ({
    distDir: path.join(__dirname, '..', 'parallel', 'spa'),
    runtimeEnv: { WORKER: String(worker.parallelIndex) },
  }),
  // CTF_NO_ISOLATION=1 shares one WireMock namespace between workers, to see
  // the price tests trample each other.
  wiremock: { url: WIREMOCK_URL, resetEachTest: true, isolate: !process.env.CTF_NO_ISOLATION },
  stubsDir: path.join(__dirname, 'stubs'),
  // Logins go the way the SPA's would: through the SPA server to WireMock.
  auth: { loginPath: '/api/auth/login' },
  coverage: {
    outDir: path.join(__dirname, 'coverage'),
    reporters: ['json-summary'],
    onNothingCollected: 'throw',
  },
})

export { expect } from '@playwright/test'
