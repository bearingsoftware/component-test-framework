import type { Page } from '@playwright/test'

/**
 * Abstract base page object. All element interaction uses `data-testid` attributes.
 * Consumers extend this for each page in their application.
 *
 * @example
 * ```typescript
 * export class LoginPage extends BasePage {
 *   get url() { return '/login' }
 * }
 * ```
 */
export abstract class BasePage {
  constructor(
    protected page: Page,
    protected baseUrl: string,
  ) {}

  /** The path portion of the page URL (e.g. "/login"). */
  abstract get url(): string

  /** Navigate to this page. */
  async navigate(): Promise<void> {
    await this.page.goto(`${this.baseUrl}${this.url}`)
  }

  /** Click an element by its data-testid attribute. */
  async clickElement(testId: string): Promise<void> {
    await this.page.getByTestId(testId).click()
  }

  /** Get the text content of an element by its data-testid attribute. */
  async getElementValue(testId: string): Promise<string> {
    const el = this.page.getByTestId(testId)
    // For input elements, return the input value; otherwise return text content
    const tagName = await el.evaluate((node) => node.tagName.toLowerCase())
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
      return await el.inputValue()
    }
    return (await el.textContent()) ?? ''
  }

  /** Fill an input element by its data-testid attribute. */
  async fillElement(testId: string, value: string): Promise<void> {
    await this.page.getByTestId(testId).fill(value)
  }

  /** Check whether an element is visible on the page. */
  async isVisible(testId: string): Promise<boolean> {
    return await this.page.getByTestId(testId).isVisible()
  }

  /** Wait for an element to appear on the page. */
  async waitForElement(testId: string, timeout = 5000): Promise<void> {
    await this.page.getByTestId(testId).waitFor({ state: 'visible', timeout })
  }

  /** Wait for an element to be hidden or removed from the page. */
  async waitForHidden(testId: string, timeout = 5000): Promise<void> {
    await this.page.getByTestId(testId).waitFor({ state: 'hidden', timeout })
  }

  /** Hover over an element by its data-testid attribute. */
  async hoverElement(testId: string): Promise<void> {
    await this.page.getByTestId(testId).hover()
  }

  /** Select an option from a select element by its data-testid. */
  async selectOption(testId: string, value: string): Promise<void> {
    await this.page.getByTestId(testId).selectOption(value)
  }
}
