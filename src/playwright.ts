// `@bearingsoftware/component-test-framework/playwright`: page objects and the
// UI steps. Registers nothing on import; Playwright is loaded when the first
// @ui scenario starts.
export { BasePage } from './pages/base.page'
export { registerUiSteps } from './steps/register'
