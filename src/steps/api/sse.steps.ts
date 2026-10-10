import { When } from '@cucumber/cucumber'
import type { ComponentTestWorld } from '../../support/world'
import { readSSE } from '../../support/sse'

// Re-exported for anyone importing it from here.
export { readSSE }

When(
  'I connect to the SSE endpoint {string} and read the first event',
  async function (this: ComponentTestWorld, path: string) {
    await readSSE(this, path, { timeoutMs: 5_000 })
  },
)

When(
  'I connect to the SSE endpoint {string} and wait for a keepalive',
  async function (this: ComponentTestWorld, path: string) {
    await readSSE(this, path, { timeoutMs: 5_000, wantKeepalive: true })
  },
)
