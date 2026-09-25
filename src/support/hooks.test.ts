import { describe, it, expect, vi } from 'vitest'
import type { Browser } from '@playwright/test'

import { reuseBrowser } from './hooks'

const browser = (connected: boolean, id = 'b'): Browser =>
  ({ isConnected: () => connected, id }) as unknown as Browser

describe('reuseBrowser (SECREPO-602)', () => {
  it('reuses a connected browser rather than launching another', async () => {
    const current = browser(true, 'first')
    const launch = vi.fn()

    const got = await reuseBrowser(current, launch as unknown as () => Promise<Browser>)

    expect(got).toBe(current)
    expect(launch).not.toHaveBeenCalled()
  })

  it('launches when there is nothing to reuse', async () => {
    const fresh = browser(true, 'fresh')
    const launch = vi.fn().mockResolvedValue(fresh)

    expect(await reuseBrowser(null, launch)).toBe(fresh)
    expect(launch).toHaveBeenCalledTimes(1)
  })

  // Without this, a browser that died mid-suite would be handed to every
  // scenario that followed, turning one crash into a whole-run failure.
  it('replaces a browser that has disconnected', async () => {
    const dead = browser(false, 'dead')
    const fresh = browser(true, 'fresh')
    const launch = vi.fn().mockResolvedValue(fresh)

    expect(await reuseBrowser(dead, launch)).toBe(fresh)
    expect(launch).toHaveBeenCalledTimes(1)
  })
})
