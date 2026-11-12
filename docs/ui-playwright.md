# UI steps (Playwright)

Tag scenarios with `@ui` to activate Playwright browser lifecycle. All element interaction uses `data-testid` attributes.

| Step | Description |
|---|---|
| `Given I navigate to the {word} page` | Navigate to a registered page |
| `When I click on the {word} on the {word} page, then save the value of {word}` | Click element, save another element's value |
| `When I click on the {word} on the {word} page` | Click an element |
| `When I fill {word} with {string} on the {word} page` | Type into an input |
| `When I save the value of {word} on the {word} page` | Save an element's current value |
| `Then the saved value {word} should be {string}` | Assert a previously saved value |
| `Then the saved value {word} should not be empty` | Assert a saved value is non-empty |
| `Then I should see {word} on the {word} page` | Wait for an element to be visible |
| `Then I should not see {word} on the {word} page` | Wait for an element to be hidden or removed |
| `Then the {word} page should be displayed` | Wait for the URL to contain the page's path |

Example:

```gherkin
@ui
Scenario: Login and view dashboard
  Given I navigate to the login page
  When I fill login-email with "test@example.com" on the login page
  And I fill login-password with "SecurePass123!" on the login page
  And I click on the login-submit on the login page
  Then the dashboard page should be displayed
  And I should see dashboard-battery-level on the dashboard page
```

## Page Object Model

Create page objects by extending `BasePage`. Register them in the world during setup:

```typescript
import { BasePage } from '@bearingsoftware/component-test-framework/playwright'
import type { Page } from '@playwright/test'

export class LoginPage extends BasePage {
  constructor(page: Page, baseUrl: string) {
    super(page, baseUrl)
  }
  get url() { return '/login' }
}

export class DashboardPage extends BasePage {
  constructor(page: Page, baseUrl: string) {
    super(page, baseUrl)
  }
  get url() { return '/' }
}
```

Register pages in a Before hook:

```typescript
import { Before } from '@cucumber/cucumber'
import type { ComponentTestWorld } from '@bearingsoftware/component-test-framework/core'
import { LoginPage } from '../pages/login.page'
import { DashboardPage } from '../pages/dashboard.page'

Before({ tags: '@ui' }, function (this: ComponentTestWorld) {
  const baseUrl = this.config.webBaseUrl!
  this.pageRegistry.set('login', new LoginPage(this.page!, baseUrl))
  this.pageRegistry.set('dashboard', new DashboardPage(this.page!, baseUrl))
})
```
