// `@bearingsoftware/component-test-framework/preset`: a Cucumber profile for
// cucumber.js. It loads nothing else from the package, so it's safe to
// require from cucumber.js, outside a Cucumber run.

/** A Cucumber profile, as cucumber.js exports it. */
export type CucumberProfile = Record<string, unknown>

/**
 * The Cucumber profile every suite here uses: TypeScript support files under
 * `support/` (and `pages/` for UI suites), features under `features/`,
 * progress and summary output, and an exit when the run ends, so an open
 * handle such as a database pool can't hold the process. Pass anything to
 * change or add.
 *
 * @example
 * // cucumber.js
 * const { cucumberPreset } = require('@bearingsoftware/component-test-framework/preset')
 * module.exports = { default: cucumberPreset({ tags: 'not @pending' }) }
 */
export function cucumberPreset(overrides: CucumberProfile = {}): CucumberProfile {
  return {
    requireModule: ['ts-node/register'],
    require: ['support/**/*.ts', 'pages/**/*.ts'],
    paths: ['features/**/*.feature'],
    format: ['progress-bar', 'summary'],
    forceExit: true,
    ...overrides,
  }
}
