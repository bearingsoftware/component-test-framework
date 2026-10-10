import { Given, When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'assert'
import type { ComponentTestWorld } from '../../support/world'
import type { BasePage } from '../../pages/base.page'
import { eventually, waitTimeout } from '../../support/eventually'

/** Resolve a page object from the world's page registry by name. */
export function getPage(world: ComponentTestWorld, pageName: string): BasePage {
  const page = world.pageRegistry.get(pageName)
  if (!page) {
    throw new Error(
      `Unknown page "${pageName}". Registered pages: ${[...world.pageRegistry.keys()].join(', ')}`,
    )
  }
  return page
}

Given('I navigate to the {word} page', async function (this: ComponentTestWorld, pageName: string) {
  const pageObj = getPage(this, pageName)
  await pageObj.navigate()
})

When(
  'I click on the {word} on the {word} page, then save the value of {word}',
  async function (
    this: ComponentTestWorld,
    clickTestId: string,
    pageName: string,
    saveTestId: string,
  ) {
    const pageObj = getPage(this, pageName)
    await pageObj.clickElement(clickTestId)
    const value = await pageObj.getElementValue(saveTestId)
    this.saveUIValue(`click:${clickTestId}`, saveTestId, value)
  },
)

When(
  'I click on the {word} on the {word} page',
  async function (this: ComponentTestWorld, testId: string, pageName: string) {
    const pageObj = getPage(this, pageName)
    await pageObj.clickElement(testId)
  },
)

When(
  'I fill {word} with {string} on the {word} page',
  async function (this: ComponentTestWorld, testId: string, value: string, pageName: string) {
    const pageObj = getPage(this, pageName)
    await pageObj.fillElement(testId, value)
  },
)

When(
  'I save the value of {word} on the {word} page',
  async function (this: ComponentTestWorld, testId: string, pageName: string) {
    const pageObj = getPage(this, pageName)
    const value = await pageObj.getElementValue(testId)
    this.saveUIValue(`save:${testId}`, testId, value)
  },
)

Then(
  'the saved value {word} should be {string}',
  function (this: ComponentTestWorld, testId: string, expected: string) {
    const actual = this.getSavedValue(testId)
    assert.equal(actual, expected, `Saved value for "${testId}"`)
  },
)

Then(
  'the saved value {word} should not be empty',
  function (this: ComponentTestWorld, testId: string) {
    const actual = this.getSavedValue(testId)
    assert.ok(
      actual && actual.trim().length > 0,
      `Expected saved value "${testId}" to not be empty`,
    )
  },
)

// COMPONENT-6: the assertions below wait, up to the configured wait timeout,
// rather than checking once. An SPA renders after its fetches resolve and
// navigates client-side, so a single check races it. Each passes as soon as
// the condition holds, so a page that's already right is no slower.

Then(
  'I should see {word} on the {word} page',
  async function (this: ComponentTestWorld, testId: string, pageName: string) {
    const timeout = waitTimeout(this.config)
    try {
      await getPage(this, pageName).waitForElement(testId, timeout)
    } catch (err) {
      throw new Error(
        `Expected element "${testId}" to be visible on ${pageName} within ${timeout}ms: ${(err as Error).message}`,
      )
    }
  },
)

Then(
  'I should not see {word} on the {word} page',
  async function (this: ComponentTestWorld, testId: string, pageName: string) {
    const timeout = waitTimeout(this.config)
    try {
      await getPage(this, pageName).waitForHidden(testId, timeout)
    } catch (err) {
      throw new Error(
        `Expected element "${testId}" to NOT be visible on ${pageName} within ${timeout}ms: ${(err as Error).message}`,
      )
    }
  },
)

Then(
  'the {word} page should be displayed',
  async function (this: ComponentTestWorld, pageName: string) {
    const pageObj = getPage(this, pageName)
    const page = this.page
    assert.ok(page, 'No Playwright page available')
    await eventually(
      () => {
        const url = page.url()
        assert.ok(
          url.includes(pageObj.url),
          `Expected URL to contain "${pageObj.url}", got "${url}"`,
        )
      },
      { timeout: waitTimeout(this.config), interval: 100 },
    )
  },
)
