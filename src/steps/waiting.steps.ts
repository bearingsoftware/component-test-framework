import { Given, When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'assert'
import type { Page } from '@playwright/test'
import type { ComponentTestWorld } from '../support/world'
import { eventually, holdsFor, serviceWaitTimeout, waitTimeout } from '../support/eventually'
import { assertSafeTableName, countRows } from '../support/db'
import { describeRequests, type RequestFilter } from '../clients/wiremock-client'

/** Options for {@link registerWaitingSteps}. Pass the same object you give `registerHooks`. */
export interface WaitingStepOptions {
  /** How long the UI steps wait before failing, in ms. */
  waitTimeout?: number
  /** Used to derive the UI wait when `waitTimeout` isn't set: 1s less than this. */
  defaultStepTimeout?: number
  /** How long the WireMock and database steps wait, in ms. Default 30s. */
  serviceWaitTimeout?: number
}

// Headroom between a step's own wait and its Cucumber timeout, so the step
// fails with what it was waiting for rather than "function timed out".
const STEP_HEADROOM = 1_000
// For steps that watch a window of a length the feature file sets, the
// Cucumber timeout is turned off; the step's own waits bound it.
const NO_STEP_TIMEOUT = -1
// "No further requests" first waits for the count to stop moving: up to
// SETTLE_READS reads, SETTLE_READ_GAP apart, until two agree. If it never
// settles it carries on with the last count, as the step it replaces did.
const SETTLE_READ_GAP = 2_000
const SETTLE_READS = 7

function requirePage(world: ComponentTestWorld): Page {
  if (!world.page) throw new Error('No Playwright page available')
  return world.page
}

function pageUrl(world: ComponentTestWorld, pageName: string): string {
  const pageObj = world.pageRegistry.get(pageName)
  if (!pageObj) {
    throw new Error(
      `Unknown page "${pageName}". Registered pages: ${[...world.pageRegistry.keys()].join(', ')}`,
    )
  }
  return pageObj.url
}

/**
 * Register opt-in waiting steps, worded to match the steps several consumer
 * suites wrote for themselves: "I should eventually see …", "the X API
 * eventually receives …", "the X table contains at least …" and so on.
 *
 * They aren't registered on import, because a suite that still defines its
 * own copy would then have two matching definitions, and Cucumber fails every
 * step that matches both. Delete your copies, then call this once in your
 * support setup:
 *
 * ```typescript
 * const options = { ...loadConfig(), waitTimeout: 10_000 }
 * registerHooks(options)
 * registerWaitingSteps(options)
 * ```
 *
 * UI steps wait up to `waitTimeout`; WireMock and database steps, which wait
 * on background work, up to `serviceWaitTimeout` (30s by default). Each step
 * gets a Cucumber timeout 1s longer than its wait, so a failure says what it
 * was waiting for.
 */
export function registerWaitingSteps(options: WaitingStepOptions = {}): void {
  const budget = waitTimeout(options)
  const step = { timeout: budget + STEP_HEADROOM }
  const serviceBudget = serviceWaitTimeout(options)
  const serviceStep = { timeout: serviceBudget + STEP_HEADROOM }

  // --- UI (Playwright) ---

  Then(
    'the {word} page should eventually be displayed',
    step,
    async function (this: ComponentTestWorld, pageName: string) {
      const page = requirePage(this)
      const path = pageUrl(this, pageName)
      // The URL must end with the page's path, not just contain it, so a
      // longer path such as /household/invite doesn't pass for /household.
      try {
        await page.waitForURL(`**${path}`, { timeout: budget })
      } catch {
        throw new Error(
          `Expected URL to end with "${path}" within ${budget}ms, got "${page.url()}"`,
        )
      }
    },
  )

  Then(
    'the URL should contain {string}',
    step,
    async function (this: ComponentTestWorld, fragment: string) {
      const page = requirePage(this)
      await eventually(
        () =>
          assert.ok(
            page.url().includes(fragment),
            `Expected URL to contain "${fragment}", got "${page.url()}"`,
          ),
        { timeout: budget, interval: 100 },
      )
    },
  )

  Then(
    'I should eventually see {word} on the {word} page',
    step,
    async function (this: ComponentTestWorld, testId: string, _pageName: string) {
      await requirePage(this).getByTestId(testId).waitFor({ state: 'visible', timeout: budget })
    },
  )

  Then(
    'I should eventually not see {word} on the {word} page',
    step,
    async function (this: ComponentTestWorld, testId: string, _pageName: string) {
      // Removed from the page, not just hidden.
      await requirePage(this).getByTestId(testId).waitFor({ state: 'detached', timeout: budget })
    },
  )

  Then(
    'I should still see {word} on the {word} page',
    async function (this: ComponentTestWorld, testId: string, _pageName: string) {
      const visible = await requirePage(this).getByTestId(testId).isVisible()
      assert.ok(visible, `testid "${testId}" not visible (expected to remain on page)`)
    },
  )

  Then(
    'I should eventually see {word} containing {string} on the {word} page',
    step,
    async function (this: ComponentTestWorld, testId: string, text: string, _pageName: string) {
      const element = requirePage(this).getByTestId(testId)
      await eventually(
        async () => {
          const actual = (await element.textContent()) ?? ''
          assert.ok(
            actual.includes(text),
            `testid "${testId}" text is "${actual}", want it to contain "${text}"`,
          )
        },
        { timeout: budget, interval: 100 },
      )
    },
  )

  Then(
    '{word} on the {word} page should eventually read {string}',
    step,
    async function (this: ComponentTestWorld, testId: string, _pageName: string, text: string) {
      const element = requirePage(this).getByTestId(testId)
      await eventually(
        async () => {
          const actual = ((await element.textContent()) ?? '').trim()
          assert.equal(actual, text, `testid "${testId}" reads "${actual}", want "${text}"`)
        },
        { timeout: budget, interval: 100 },
      )
    },
  )

  Then(
    'the {word} on the {word} page should have value {string}',
    step,
    async function (this: ComponentTestWorld, testId: string, _pageName: string, want: string) {
      const element = requirePage(this).getByTestId(testId)
      await eventually(
        async () => {
          const got = await element.inputValue({ timeout: 100 })
          assert.equal(got, want, `testid "${testId}" value = "${got}", want "${want}"`)
        },
        { timeout: budget, interval: 100 },
      )
    },
  )

  When(
    'I hover over {word} on the {word} page',
    step,
    async function (this: ComponentTestWorld, testId: string, _pageName: string) {
      await requirePage(this).getByTestId(testId).hover({ timeout: budget })
    },
  )

  When(
    'I select {string} from {word} on the {word} page',
    step,
    async function (this: ComponentTestWorld, value: string, testId: string, _pageName: string) {
      await requirePage(this).getByTestId(testId).selectOption(value, { timeout: budget })
    },
  )

  // window.confirm() blocks until handled, so the handler is registered before
  // the action that opens it, and handles only the next dialog.
  Given('I accept the next confirm dialog', function (this: ComponentTestWorld) {
    requirePage(this).once('dialog', (dialog) => void dialog.accept())
  })

  Given('I dismiss the next confirm dialog', function (this: ComponentTestWorld) {
    requirePage(this).once('dialog', (dialog) => void dialog.dismiss())
  })

  // --- WireMock ---

  const count = (world: ComponentTestWorld, path: string, filter: RequestFilter) =>
    world.wiremock.getRequestCount(path, filter)

  async function eventuallyReceives(
    world: ComponentTestWorld,
    expected: number,
    path: string,
    filter: RequestFilter,
  ): Promise<number> {
    return eventually(
      async () => {
        const actual = await count(world, path, filter)
        assert.ok(
          actual >= expected,
          `expected at least ${expected} ${describeRequests(path, filter)} request(s), got ${actual}`,
        )
        return actual
      },
      { timeout: serviceBudget, interval: 500 },
    )
  }

  Then(
    'the {word} API eventually receives {int} {word} request(s) to {string}',
    serviceStep,
    async function (
      this: ComponentTestWorld,
      _provider: string,
      expected: number,
      method: string,
      path: string,
    ) {
      await eventuallyReceives(this, expected, path, { method })
    },
  )

  Then(
    'the {word} API eventually receives {int} {word} request(s) to {string} whose body matches {string}',
    serviceStep,
    async function (
      this: ComponentTestWorld,
      _provider: string,
      expected: number,
      method: string,
      path: string,
      bodyJsonPath: string,
    ) {
      await eventuallyReceives(this, expected, path, { method, bodyJsonPath })
    },
  )

  // Reaches `expected`, then stays there for the window: something that
  // should happen once isn't being repeated.
  Then(
    'the {word} API receives exactly {int} {word} request(s) to {string} whose body matches {string} over {int} seconds',
    { timeout: NO_STEP_TIMEOUT },
    async function (
      this: ComponentTestWorld,
      _provider: string,
      expected: number,
      method: string,
      path: string,
      bodyJsonPath: string,
      seconds: number,
    ) {
      const filter = { method, bodyJsonPath }
      await eventuallyReceives(this, expected, path, filter)
      await holdsFor(
        async () => {
          const actual = await count(this, path, filter)
          assert.equal(
            actual,
            expected,
            `${actual} ${describeRequests(path, filter)} request(s), want exactly ${expected}`,
          )
        },
        { duration: seconds * 1_000, interval: 500, description: `over ${seconds}s` },
      )
    },
  )

  // Something has stopped calling the API. First lets the count stop moving
  // (see SETTLE_READS), so a request already in flight isn't mistaken for a
  // new one, then requires no new requests for the window. At least one
  // request must have arrived before the window.
  Then(
    'the {word} API receives no further {word} requests to {string} for {int} seconds',
    { timeout: NO_STEP_TIMEOUT },
    async function (
      this: ComponentTestWorld,
      _provider: string,
      method: string,
      path: string,
      seconds: number,
    ) {
      const filter = { method }
      let settled = await count(this, path, filter)
      for (let read = 1; read < SETTLE_READS; read++) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_READ_GAP))
        const next = await count(this, path, filter)
        if (next === settled) break
        settled = next
      }
      assert.ok(
        settled > 0,
        `expected at least one ${describeRequests(path, filter)} request before checking for further ones`,
      )
      await holdsFor(
        async () => {
          const now = await count(this, path, filter)
          assert.equal(
            now,
            settled,
            `${now - settled} further ${describeRequests(path, filter)} request(s) in ${seconds}s`,
          )
        },
        { duration: seconds * 1_000, interval: 500 },
      )
    },
  )

  // --- Database ---

  Then(
    'the {word} table contains at least {int} row(s) matching {string}',
    serviceStep,
    async function (this: ComponentTestWorld, table: string, expected: number, predicate: string) {
      assertSafeTableName(table)
      await eventually(
        async () => {
          const actual = await countRows(this, table, predicate)
          assert.ok(
            actual >= expected,
            `expected at least ${expected} row(s) in ${table} matching "${predicate}", got ${actual}`,
          )
        },
        { timeout: serviceBudget, interval: 500 },
      )
    },
  )

  When(
    'I wait for exactly {int} record(s) in {word} matching {string}',
    serviceStep,
    async function (this: ComponentTestWorld, expected: number, table: string, predicate: string) {
      assertSafeTableName(table)
      await eventually(
        async () => {
          const actual = await countRows(this, table, predicate)
          assert.equal(actual, expected, `last count: ${actual}`)
        },
        {
          timeout: serviceBudget,
          interval: 500,
          description: `Timed out waiting for exactly ${expected} record(s) in ${table} WHERE ${predicate}`,
        },
      )
    },
  )
}
