import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { chromium, type Browser, type Page } from '@playwright/test'

type Fn = (this: unknown, ...args: unknown[]) => unknown

// Capture steps and Before hooks so they can be run without Cucumber.
const registry = vi.hoisted(() => ({
  steps: new Map<string, Fn>(),
  before: [] as { tags?: string; fn: Fn }[],
}))

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const step = (expression: string, optionsOrFn: unknown, maybeFn?: Fn) =>
    void registry.steps.set(
      expression,
      (typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn) as Fn,
    )
  const before = (options: { tags?: string }, fn: Fn) =>
    void registry.before.push({ tags: options.tags, fn })
  return { ...actual, Then: step, Before: before }
})

import {
  blockRoutes,
  registerAccessibilitySteps,
  registerRouteBlocks,
  registerWebAuthnTag,
  saveFailureArtifacts,
} from './browser'

const scenario = (name: string) => ({ pickle: { name } }) as never

describe('failure artefacts (COMPONENT-10)', () => {
  it('saves a screenshot and the HTML, named after the scenario', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-failure-'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const page = {
      url: () => 'http://localhost:3100/login',
      screenshot: vi.fn(async ({ path: file }: { path: string }) => fs.writeFileSync(file, 'png')),
      content: async () => '<html>login</html>',
    }
    await saveFailureArtifacts(dir)({ page } as never, scenario('Log in: wrong "password"'))

    expect(fs.readdirSync(dir).sort()).toEqual([
      'Log_in_wrong_password_.html',
      'Log_in_wrong_password_.png',
    ])
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }))
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('page url = http://localhost:3100/login'),
    )
    errors.mockRestore()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('logs rather than throws when the page cannot be captured', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const page = {
      url: () => 'x',
      screenshot: async () => {
        throw new Error('page closed')
      },
    }
    await saveFailureArtifacts(os.tmpdir())({ page } as never, scenario('x'))
    expect(errors).toHaveBeenCalledWith('[failure] could not capture page state: page closed')
    errors.mockRestore()
  })
})

describe('browser helpers (COMPONENT-10)', () => {
  it('blocks routes by aborting, or answers them', async () => {
    const handlers: { url: unknown; handle: (route: unknown) => unknown }[] = []
    const page = {
      route: async (url: unknown, handle: (route: unknown) => unknown) =>
        void handlers.push({ url, handle }),
    }
    await blockRoutes(page as unknown as Page, [
      { url: '**/*.tile.openstreetmap.org/**' },
      {
        url: 'https://api.postcodes.io/**',
        fulfill: { status: 404, contentType: 'application/json', body: '{}' },
      },
    ])
    const route = { abort: vi.fn(), fulfill: vi.fn() }
    handlers[0].handle(route)
    handlers[1].handle(route)
    expect(route.abort).toHaveBeenCalledTimes(1)
    expect(route.fulfill).toHaveBeenCalledWith({
      status: 404,
      contentType: 'application/json',
      body: '{}',
    })
  })

  it('registers tagged hooks for route blocks and WebAuthn', () => {
    registerRouteBlocks('@solar', [{ url: '**/tiles/**' }])
    registerWebAuthnTag()
    expect(registry.before.map((h) => h.tags)).toEqual(['@solar', '@webauthn'])
  })
})

describe('accessibility step (COMPONENT-10)', () => {
  let browser: Browser | null = null

  beforeAll(async () => {
    registerAccessibilitySteps({ disableRules: ['color-contrast'] })
    try {
      browser = await chromium.launch()
    } catch {
      browser = null
    }
  })

  afterAll(async () => browser?.close())

  const check = async (html: string) => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    await page.setContent(html)
    try {
      return await registry.steps
        .get('the {word} page should have no serious accessibility violations')!
        .call({ page }, 'home')
    } finally {
      await context.close()
    }
  }

  it('passes an accessible page and fails one with serious violations, naming them', async (ctx) => {
    if (!browser) ctx.skip()
    await check(
      '<html lang="en"><head><title>Home</title></head><body><main><h1>Hi</h1></main></body></html>',
    )
    await expect(
      check(
        '<html lang="en"><head><title>Home</title></head><body><main><img src="x.png"></main></body></html>',
      ),
    ).rejects.toThrow(/accessibility violations:\nimage-alt \(critical\): img/)
  })
})
