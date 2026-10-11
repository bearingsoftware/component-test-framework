// Smoke test for the built package (npm run build first): the core entry
// point, the register…Steps functions and the lifecycle hooks, under a real
// Cucumber run rather than mocks.
const assert = require('assert')
const path = require('path')
const { Given, Then } = require('@cucumber/cucumber')
const core = require('../../../dist/core')
// The root import registers every step group as it loads. Using it alongside
// the core entry point's register…Steps calls must not register any step
// twice, which Cucumber would report as ambiguous.
require('../../../dist/index')

core.registerHooks({
  fixturesDir: path.join(__dirname, '..'),
  hooks: {
    afterReset: (world) => world.remember('afterReset', true),
  },
})

// Twice: the second call must register nothing, or every step in the group
// would be ambiguous.
core.registerResponseSteps()
core.registerResponseSteps()

// An adapter entry point with opt-in steps, likewise.
const mailpit = require('../../../dist/mailpit')
mailpit.registerMailpitSteps()
mailpit.registerMailpitSteps()
assert.equal(typeof mailpit.MailpitClient, 'function')

Given('a response with status {int}', function (status) {
  this.lastResponse = { status, body: null, headers: {} }
})

Then('the afterReset hook has run for this scenario', function () {
  assert.equal(this.recall('afterReset'), true)
})
