import { describe, it, expect, vi } from 'vitest'
import type { Browser } from '@playwright/test'

import {
  createBrowserSource,
  launchUi,
  loadPlaywright,
  reuseBrowser,
  uiHookTimeout,
  validateUiTimeouts,
} from './hooks'

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

describe('loadPlaywright', () => {
  const notFound = (name: string) =>
    Object.assign(new Error(`Cannot find package '${name}' imported from /x`), {
      code: 'ERR_MODULE_NOT_FOUND',
    })

  it('names the package and its install command when it is missing', async () => {
    const importer = vi.fn().mockRejectedValue(notFound('@playwright/test'))

    await expect(loadPlaywright(importer)).rejects.toThrow(
      "@ui scenarios need @playwright/test. Add it to the suite's dependencies: npm install --save-dev @playwright/test",
    )
  })

  it('rethrows a missing dependency of Playwright unchanged', async () => {
    const err = notFound('some-transitive-dep')
    const importer = vi.fn().mockRejectedValue(err)

    await expect(loadPlaywright(importer)).rejects.toBe(err)
  })

  it('rethrows any other error unchanged', async () => {
    const err = new Error('boom')
    const importer = vi.fn().mockRejectedValue(err)

    await expect(loadPlaywright(importer)).rejects.toBe(err)
  })
})

describe('launchUi (COMPONENT-41)', () => {
  const never = () => new Promise<never>(() => undefined)
  const fakePage = { close: vi.fn() }
  const ctx = (newPage: () => Promise<unknown> = async () => fakePage) =>
    ({
      newPage,
      close: vi.fn().mockResolvedValue(undefined),
    }) as unknown as import('@playwright/test').BrowserContext
  const fakeBrowser = (connected: boolean, newContext: () => Promise<unknown>) =>
    ({
      isConnected: () => connected,
      newContext,
      close: vi.fn().mockResolvedValue(undefined),
    }) as unknown as Browser
  const harness = (first: Browser, later: Browser[] = []) => {
    let shared: Browser | null = null
    const queue = [first, ...later]
    const getBrowser = vi.fn(async () => {
      if (!shared?.isConnected()) shared = queue.shift() as Browser
      return shared
    })
    return {
      getBrowser,
      deps: { getBrowser, peekBrowser: () => shared, dropBrowser: () => (shared = null) },
    }
  }

  it('names browserForWorker and the connected flag when it hangs', async () => {
    const { deps } = harness(fakeBrowser(true, async () => ctx()))
    await expect(launchUi({ launchTimeoutMs: 20 }, { ...deps, getBrowser: never })).rejects.toThrow(
      /browserForWorker.*20ms.*connected: false/,
    )
  })

  it('names newPage and the connected flag when it hangs', async () => {
    const { deps } = harness(fakeBrowser(true, async () => ctx(never)))
    await expect(launchUi({ launchTimeoutMs: 20 }, deps)).rejects.toThrow(
      /newPage.*connected: true/,
    )
  })

  it('relaunches once when newContext hangs, then succeeds', async () => {
    const hung = fakeBrowser(true, never)
    const good = fakeBrowser(true, async () => ctx())
    const { deps, getBrowser } = harness(hung, [good])
    const got = await launchUi({ launchTimeoutMs: 20 }, deps)
    expect(got.browser).toBe(good)
    expect(getBrowser).toHaveBeenCalledTimes(2)
    expect(hung.close).toHaveBeenCalled()
  })

  it('relaunches once when the browser is disconnected, then succeeds', async () => {
    const dead = fakeBrowser(false, async () => {
      throw new Error('Target closed')
    })
    const good = fakeBrowser(true, async () => ctx())
    const { deps } = harness(dead, [good])
    const got = await launchUi({ launchTimeoutMs: 20 }, deps)
    expect(got.browser).toBe(good)
  })

  it('fails after a single retry when newContext hangs again', async () => {
    const a = fakeBrowser(true, never)
    const b = fakeBrowser(true, never)
    const { deps, getBrowser } = harness(a, [b, fakeBrowser(true, async () => ctx())])
    await expect(launchUi({ launchTimeoutMs: 20 }, deps)).rejects.toThrow(
      /newContext.*connected: true/,
    )
    expect(getBrowser).toHaveBeenCalledTimes(2)
  })

  it('logs timings through the ctf debug channel', async () => {
    const { deps } = harness(fakeBrowser(true, async () => ctx()))
    const lines: string[] = []
    await launchUi({}, { ...deps, log: (m) => lines.push(m) })
    expect(lines.join('\n')).toMatch(/newPage took \d+ms/)
  })

  it('worst case always throws the named error before the hook timeout', async () => {
    vi.useFakeTimers()
    try {
      const hookTimeout = uiHookTimeout({})
      const start = Date.now()
      const bad = () => fakeBrowser(true, never)
      const { deps } = harness(bad(), [bad(), bad()])
      let failedAt = 0
      const p = launchUi({}, deps).catch((e: Error) => ((failedAt = Date.now()), e))
      await vi.advanceTimersByTimeAsync(hookTimeout)
      const err = (await p) as Error
      expect(err.message).toMatch(/newContext did not finish/)
      expect(failedAt - start).toBeLessThan(hookTimeout)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips the relaunch when less than two minimum attempts remain', async () => {
    vi.useFakeTimers()
    try {
      const { deps, getBrowser } = harness(fakeBrowser(true, never), [
        fakeBrowser(true, async () => ctx()),
      ])
      const p = launchUi({ launchTimeoutMs: 10_000, uiSetupTimeoutMs: 12_000 }, deps).catch(
        (e: Error) => e,
      )
      await vi.advanceTimersByTimeAsync(12_000)
      const err = (await p) as Error
      expect(err.message).toMatch(/newContext did not finish.*retry skipped/)
      expect(getBrowser).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('hook timeout is the setup budget plus 5s', () => {
    expect(uiHookTimeout({})).toBe(50_000)
    expect(uiHookTimeout({ uiSetupTimeoutMs: 20_000 })).toBe(25_000)
  })
})

describe('createBrowserSource (COMPONENT-41)', () => {
  it('closes a launch that finishes after being abandoned and leaves the shared browser unset', async () => {
    let resolve!: (b: Browser) => void
    const late = {
      isConnected: () => true,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Browser
    const src = createBrowserSource(() => new Promise<Browser>((r) => (resolve = r)))
    const pending = src.get().catch((e: Error) => e)
    src.abandon()
    resolve(late)
    expect(((await pending) as Error).message).toMatch(/after its timeout/)
    expect(late.close).toHaveBeenCalled()
    expect(src.peek()).toBeNull()
  })

  it('assigns a launch that was not abandoned', async () => {
    const b = { isConnected: () => true } as unknown as Browser
    const src = createBrowserSource(async () => b)
    expect(await src.get()).toBe(b)
    expect(src.peek()).toBe(b)
  })
})

describe('validateUiTimeouts (COMPONENT-41)', () => {
  it.each([0, -1, 1.5, Number.NaN])('rejects %s', (v) => {
    expect(() => validateUiTimeouts({ launchTimeoutMs: v })).toThrow(
      /launchTimeoutMs must be a positive integer/,
    )
    expect(() => validateUiTimeouts({ uiSetupTimeoutMs: v })).toThrow(
      /uiSetupTimeoutMs must be a positive integer/,
    )
  })

  it('accepts unset and positive integers', () => {
    expect(() => validateUiTimeouts({})).not.toThrow()
    expect(() => validateUiTimeouts({ launchTimeoutMs: 1, uiSetupTimeoutMs: 45_000 })).not.toThrow()
  })
})
