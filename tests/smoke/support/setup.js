// Smoke test for the built package (npm run build first): the core entry
// point, the register…Steps functions and the lifecycle hooks, under a real
// Cucumber run rather than mocks.
const assert = require('assert')
const path = require('path')
const { Given, Then } = require('@cucumber/cucumber')
const core = require('../../../dist/core')

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

Given('a response with status {int}', function (status) {
  this.lastResponse = { status, body: null, headers: {} }
})

Then('the afterReset hook has run for this scenario', function () {
  assert.equal(this.recall('afterReset'), true)
})
