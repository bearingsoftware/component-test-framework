import { Given, When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'assert'
import type { Page } from '@playwright/test'
import type { ComponentTestWorld } from '../support/world'
import { eventually, holdsFor, waitTimeout } from '../support/eventually'
import { countRows } from '../support/db'
import { describeRequests, type RequestFilter } from '../clients/wiremock-client'

/** Options for {@link registerWaitingSteps}. Pass the same object you give `registerHooks`. */
export interface WaitingStepOptions {
  /** How long each step waits before failing, in ms. */
  waitTimeout?: number
  /** Used to derive the wait when `waitTimeout` isn't set: 1s less than this. */
  defaultStepTimeout?: number
}

// Headroom between a step's own wait and its Cucumber timeout, so the step
// fails with what it was waiting for rather than "function timed out".
const STEP_HEADROOM = 1_000
// For steps that watch a window of a length the feature file sets, the
// Cucumber timeout is turned off; the step's own waits bound it.
const NO_STEP_TIMEOUT = -1
// How long "no further requests" waits for the count to stop moving before
// starting its window, and how far apart the two reads are.
const SETTLE_READ_GAP = 2_000

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
 * Every step waits up to the same budget, `waitTimeout`, and gets a Cucumber
 * timeout 1s longer, so a failure says what it was waiting for.
 */
export function registerWaitingSteps(options: WaitingStepOptions = {}): void {
  const budget = waitTimeout(options)
  const step = { timeout: budget + STEP_HEADROOM }

  // --- UI (Playwright) ---

  Then(
    'the {word} page should eventually be displayed',
    step,
    async function (this: ComponentTestWorld, pageName: string) {
      const page = requirePage(this)
      const path = pageUrl(this, pageName)
      await eventually(
        () =>
          assert.ok(
            page.url().includes(path),
            `Expected URL to contain "${path}", got "${page.url()}"`,
          ),
        { timeout: budget, interval: 100 },
      )
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
      await requirePage(this).getByTestId(testId).waitFor({ state: 'hidden', timeout: budget })
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
      { timeout: budget, interval: 500 },
    )
  }

  Then(
    'the {word} API eventually receives {int} {word} request(s) to {string}',
    step,
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
    step,
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

  // Something has stopped calling the API. Waits for the count to stop moving
  // (two reads SETTLE_READ_GAP apart that agree), so a request already in
  // flight isn't mistaken for a new one, then requires no new requests for
  // the window. At least one request must have arrived before the window.
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
      await eventually(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, SETTLE_READ_GAP))
          const next = await count(this, path, filter)
          const moved = next !== settled
          settled = next
          assert.ok(!moved, `${describeRequests(path, filter)} count still changing`)
        },
        { timeout: budget, interval: 0 },
      )
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
    step,
    async function (this: ComponentTestWorld, table: string, expected: number, predicate: string) {
      await eventually(
        async () => {
          const actual = await countRows(this, table, predicate)
          assert.ok(
            actual >= expected,
            `expected at least ${expected} row(s) in ${table} matching "${predicate}", got ${actual}`,
          )
        },
        { timeout: budget, interval: 500 },
      )
    },
  )

  When(
    'I wait for exactly {int} record(s) in {word} matching {string}',
    step,
    async function (this: ComponentTestWorld, expected: number, table: string, predicate: string) {
      await eventually(
        async () => {
          const actual = await countRows(this, table, predicate)
          assert.equal(actual, expected, `last count: ${actual}`)
        },
        {
          timeout: budget,
          interval: 500,
          description: `Timed out waiting for exactly ${expected} record(s) in ${table} WHERE ${predicate}`,
        },
      )
    },
  )
}
