import { describe, it, expect, vi } from 'vitest'
import type { Browser } from '@playwright/test'

import { launchBudget, launchUi, loadPlaywright, reuseBrowser } from './hooks'

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
    await expect(launchUi(20, { ...deps, getBrowser: never })).rejects.toThrow(
      /browserForWorker.*20ms.*connected: false/,
    )
  })

  it('names newPage and the connected flag when it hangs', async () => {
    const { deps } = harness(fakeBrowser(true, async () => ctx(never)))
    await expect(launchUi(20, deps)).rejects.toThrow(/newPage.*connected: true/)
  })

  it('relaunches once when newContext hangs, then succeeds', async () => {
    const hung = fakeBrowser(true, never)
    const good = fakeBrowser(true, async () => ctx())
    const { deps, getBrowser } = harness(hung, [good])
    const got = await launchUi(20, deps)
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
    const got = await launchUi(20, deps)
    expect(got.browser).toBe(good)
  })

  it('fails after a single retry when newContext hangs again', async () => {
    const a = fakeBrowser(true, never)
    const b = fakeBrowser(true, never)
    const { deps, getBrowser } = harness(a, [b, fakeBrowser(true, async () => ctx())])
    await expect(launchUi(20, deps)).rejects.toThrow(/newContext.*connected: true/)
    expect(getBrowser).toHaveBeenCalledTimes(2)
  })

  it('logs timings through the ctf debug channel', async () => {
    const { deps } = harness(fakeBrowser(true, async () => ctx()))
    const lines: string[] = []
    await launchUi(1000, { ...deps, log: (m) => lines.push(m) })
    expect(lines.join('\n')).toMatch(/newPage took \d+ms/)
  })

  it('launchBudget derives 40% of the step timeout, floor 5s, overridable', () => {
    expect(launchBudget({})).toBe(12_000)
    expect(launchBudget({ defaultStepTimeout: 60_000 })).toBe(24_000)
    expect(launchBudget({ defaultStepTimeout: 5_000 })).toBe(5_000)
    expect(launchBudget({ launchTimeoutMs: 123 })).toBe(123)
  })
})
