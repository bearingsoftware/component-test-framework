import * as fs from 'fs'
import * as path from 'path'
import { Before, Then } from '@cucumber/cucumber'
import type { ITestCaseHookParameter } from '@cucumber/cucumber'
import type { Page, Route } from '@playwright/test'
import type { ComponentTestWorld } from '../support/world'
import { requireOptional } from './optional'

/**
 * An `onScenarioFailed` hook that saves the page as it stood when the
 * scenario failed: a full-page screenshot and the HTML, named after the
 * scenario, in `dir`. Also logs the page's URL. A failure to capture is
 * logged, not thrown, so it can't hide the scenario's own failure.
 *
 * @example
 * registerHooks({ ...options, hooks: { onScenarioFailed: saveFailureArtifacts('playwright-report') } })
 */
export function saveFailureArtifacts(
  dir: string,
): (world: ComponentTestWorld, scenario: ITestCaseHookParameter) => Promise<void> {
  return async (world, scenario) => {
    const page = world.page
    if (!page) return
    const name = scenario.pickle.name
    // The pickle id keeps Outline rows, and scenarios that share a name,
    // from overwriting each other's files.
    const safe = `${name.replace(/[^\w-]+/g, '_').slice(0, 60)}-${scenario.pickle.id.slice(0, 8)}`
    console.error(`[failure] scenario "${name}" — page url = ${page.url()}`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      await page.screenshot({ path: path.join(dir, `${safe}.png`), fullPage: true })
      fs.writeFileSync(path.join(dir, `${safe}.html`), await page.content())
    } catch (err) {
      console.error(`[failure] could not capture page state: ${(err as Error).message}`)
    }
  }
}

/**
 * Give the page a virtual WebAuthn authenticator, through Chrome's DevTools
 * protocol, so `navigator.credentials.create()` and `.get()` succeed without
 * hardware. It acts as a built-in platform authenticator that verifies the
 * user. Chromium only.
 */
export async function addVirtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
}

/**
 * Give scenarios tagged `tag` a virtual WebAuthn authenticator (see
 * {@link addVirtualAuthenticator}). Call it after `registerHooks`, whose @ui
 * hook opens the page.
 */
export function registerWebAuthnTag(tag = '@webauthn'): void {
  Before({ tags: tag }, async function (this: ComponentTestWorld) {
    if (this.page) await addVirtualAuthenticator(this.page)
  })
}

/** A route to block: abort it, or answer it without the network. */
export interface BlockedRoute {
  /** A Playwright URL glob or regular expression, e.g. `**\/*.tile.openstreetmap.org/**`. */
  url: string | RegExp
  /** How to answer instead. Omit to abort the request. */
  fulfill?: { status?: number; contentType?: string; body?: string }
}

/** Abort or answer the given requests on the page, so it doesn't reach the network for them. */
export async function blockRoutes(page: Page, routes: BlockedRoute[]): Promise<void> {
  for (const blocked of routes) {
    await page.route(blocked.url, (route: Route) =>
      blocked.fulfill ? route.fulfill(blocked.fulfill) : route.abort(),
    )
  }
}

/**
 * Block routes in scenarios tagged `tag`, for third parties the page calls
 * that aren't under test. Call it after `registerHooks`, whose @ui hook opens
 * the page. Scenarios can still override a blocked route with their own,
 * which Playwright gives priority.
 */
export function registerRouteBlocks(tag: string, routes: BlockedRoute[]): void {
  Before({ tags: tag }, async function (this: ComponentTestWorld) {
    if (this.page) await blockRoutes(this.page, routes)
  })
}

/** Options for {@link registerAccessibilitySteps}. */
export interface AccessibilityOptions {
  /** axe rule tags to run. Default `wcag2a` and `wcag2aa`. */
  tags?: string[]
  /** axe rules to skip, e.g. `color-contrast` while a known issue is open. */
  disableRules?: string[]
  /** Impacts that fail the step. Default `serious` and `critical`. */
  failOn?: string[]
}

let accessibilityRegistered = false

/**
 * Register `Then the {word} page should have no serious accessibility
 * violations`: an axe scan of the page as it stands, failing on violations
 * of the given impacts and listing each with the elements involved.
 *
 * Needs `@axe-core/playwright`, loaded when the step first runs.
 */
export function registerAccessibilitySteps(options: AccessibilityOptions = {}): void {
  if (accessibilityRegistered) {
    console.warn(
      "[component-test-framework] registerAccessibilitySteps was called twice; the first call's options apply.",
    )
    return
  }
  accessibilityRegistered = true
  const failOn = options.failOn ?? ['serious', 'critical']

  Then(
    'the {word} page should have no serious accessibility violations',
    { timeout: 30_000 },
    async function (this: ComponentTestWorld, _pageName: string) {
      if (!this.page) throw new Error('No Playwright page available')
      const { default: AxeBuilder } = requireOptional<typeof import('@axe-core/playwright')>(
        '@axe-core/playwright',
        'The accessibility step',
      )
      let builder = new AxeBuilder({ page: this.page }).withTags(
        options.tags ?? ['wcag2a', 'wcag2aa'],
      )
      if (options.disableRules?.length) builder = builder.disableRules(options.disableRules)
      const { violations } = await builder.analyze()
      const failing = violations.filter((v) => failOn.includes(String(v.impact)))
      if (failing.length > 0) {
        const detail = failing
          .map(
            (v) =>
              `${v.id} (${String(v.impact)}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
          )
          .join('\n')
        throw new Error(`accessibility violations:\n${detail}`)
      }
    },
  )
}
