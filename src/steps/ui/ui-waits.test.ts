import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'

type StepFn = (this: unknown, ...args: unknown[]) => unknown

// Capture step definitions by expression so the real steps run against a
// real browser without a Cucumber runtime.
const steps = vi.hoisted(() => new Map<string, StepFn>())

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (expression: string, optionsOrFn: unknown, maybeFn?: StepFn) => {
    steps.set(expression, (typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn) as StepFn)
  }
  return { ...actual, Given: register, When: register, Then: register }
})

import './generic-ui.steps'
import { registerWaitingSteps } from '../waiting.steps'
import { BasePage } from '../../pages/base.page'

const BUDGET = 3_000
const DELAY = 400

// Everything changes DELAY ms after load, as an SPA does once its fetches
// resolve: an element appears, one disappears, text and an input value
// change, and the app navigates client-side.
const PAGE = `<!doctype html>
<div data-testid="spinner">Loading</div>
<div data-testid="count">0 items</div>
<input data-testid="lat" value="">
<select data-testid="unit"><option>kWh</option><option>MWh</option></select>
<button data-testid="delete" onclick="window.confirmed = confirm('Sure?')">Delete</button>
<span data-testid="tip" onmouseover="this.textContent = 'hovered'">tip</span>
<script>
  setTimeout(() => {
    document.querySelector('[data-testid=spinner]').remove()
    document.querySelector('[data-testid=count]').textContent = '3 items'
    document.querySelector('[data-testid=lat]').value = '51.5'
    const ready = document.createElement('div')
    ready.dataset.testid = 'ready'
    ready.textContent = 'Readings loaded'
    document.body.append(ready)
    history.pushState({}, '', '/dashboard')
  }, ${DELAY})
</script>`

class DashboardPage extends BasePage {
  get url() {
    return '/dashboard'
  }
}

describe('UI steps wait for the page (COMPONENT-6)', () => {
  // Skipped, rather than failed, where Chromium can't be launched.
  let browserAvailable = false
  const uiIt = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async (ctx) => {
        if (!browserAvailable) ctx.skip()
        await fn()
      },
      timeout,
    )

  let server: http.Server
  let baseUrl: string
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let world: Record<string, unknown>

  const run = (expression: string, ...args: unknown[]) => {
    const step = steps.get(expression)
    if (!step) throw new Error(`Step not registered: ${expression}`)
    return step.apply(world, args)
  }

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    registerWaitingSteps({ waitTimeout: BUDGET })
    try {
      browser = await chromium.launch()
      browserAvailable = true
    } catch (err) {
      console.warn(`Skipping browser tests: ${(err as Error).message.split('\n')[0]}`)
    }
  })

  afterAll(async () => {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
  })

  beforeEach(async () => {
    if (!browserAvailable) return
    context = await browser.newContext()
    page = await context.newPage()
    await page.goto(`${baseUrl}/`)
    world = {
      page,
      config: { waitTimeout: BUDGET },
      pageRegistry: new Map([['dashboard', new DashboardPage(page, baseUrl)]]),
    }
  })

  afterEach(async () => {
    await context?.close()
  })

  describe('existing steps', () => {
    uiIt('I should see … waits for the element to appear', async () => {
      await run('I should see {word} on the {word} page', 'ready', 'dashboard')
    })

    uiIt('I should not see … waits for the element to go', async () => {
      await run('I should not see {word} on the {word} page', 'spinner', 'dashboard')
    })

    uiIt('the … page should be displayed waits for client-side navigation', async () => {
      await run('the {word} page should be displayed', 'dashboard')
    })

    uiIt('still fails, with a clear message, when the element never appears', async () => {
      world.config = { waitTimeout: 500 }
      await expect(
        run('I should see {word} on the {word} page', 'missing', 'dashboard'),
      ).rejects.toThrow(/Expected element "missing" to be visible on dashboard within 500ms/)
    })
  })

  describe('opt-in steps', () => {
    uiIt('the … page should eventually be displayed', async () => {
      await run('the {word} page should eventually be displayed', 'dashboard')
    })

    uiIt('the URL should contain …', async () => {
      await run('the URL should contain {string}', '/dash')
    })

    uiIt('I should eventually see / not see …', async () => {
      await run('I should eventually see {word} on the {word} page', 'ready', 'dashboard')
      await run('I should eventually not see {word} on the {word} page', 'spinner', 'dashboard')
    })

    uiIt('I should eventually see … containing …', async () => {
      await run(
        'I should eventually see {word} containing {string} on the {word} page',
        'ready',
        'loaded',
        'dashboard',
      )
    })

    uiIt('… should eventually read …', async () => {
      await run(
        '{word} on the {word} page should eventually read {string}',
        'count',
        'dashboard',
        '3 items',
      )
    })

    uiIt('the … should have value …', async () => {
      await run(
        'the {word} on the {word} page should have value {string}',
        'lat',
        'dashboard',
        '51.5',
      )
    })

    // Each read is bounded, so a missing element fails with the step's own
    // message within the wait, not after Playwright's 30s action timeout.
    uiIt(
      'fails text waits within the budget when the element never appears',
      async () => {
        const started = Date.now()
        await expect(
          run(
            '{word} on the {word} page should eventually read {string}',
            'missing',
            'dashboard',
            'x',
          ),
        ).rejects.toThrow(/timed out after 3000ms/)
        await expect(
          run(
            'I should eventually see {word} containing {string} on the {word} page',
            'missing',
            'x',
            'dashboard',
          ),
        ).rejects.toThrow(/timed out after 3000ms/)
        expect(Date.now() - started).toBeLessThan(10_000)
      },
      15_000,
    )

    uiIt('I should still see … checks without waiting', async () => {
      await run('I should still see {word} on the {word} page', 'count', 'dashboard')
      await expect(
        run('I should still see {word} on the {word} page', 'ready', 'dashboard'),
      ).rejects.toThrow(/not visible/)
    })

    uiIt('I hover over … and I select … from …', async () => {
      await run('I hover over {word} on the {word} page', 'tip', 'dashboard')
      expect(await page.getByTestId('tip').textContent()).toBe('hovered')
      await run('I select {string} from {word} on the {word} page', 'MWh', 'unit', 'dashboard')
      expect(await page.getByTestId('unit').inputValue()).toBe('MWh')
    })

    uiIt('I accept / dismiss the next confirm dialog', async () => {
      await run('I accept the next confirm dialog')
      await page.getByTestId('delete').click()
      expect(
        await page.evaluate(() => (globalThis as unknown as { confirmed: boolean }).confirmed),
      ).toBe(true)

      await run('I dismiss the next confirm dialog')
      await page.getByTestId('delete').click()
      expect(
        await page.evaluate(() => (globalThis as unknown as { confirmed: boolean }).confirmed),
      ).toBe(false)
    })
  })
})
