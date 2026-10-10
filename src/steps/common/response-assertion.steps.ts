import { Then } from '@cucumber/cucumber'
import { strict as assert } from 'assert'
import { loadFixture } from '../../support/fixtures'
import type { ComponentTestWorld } from '../../support/world'
import { assertPartialMatch } from '../../utils/match'
import { valueAt } from '../../utils/json-path'

Then(
  'the response status should be {int}',
  function (this: ComponentTestWorld, expectedStatus: number) {
    assert.ok(this.lastResponse, 'No response recorded')
    assert.equal(this.lastResponse.status, expectedStatus)
  },
)

Then(
  'the response body should match {word}',
  function (this: ComponentTestWorld, fixtureFile: string) {
    assert.ok(this.lastResponse, 'No response recorded')
    const expected = loadFixture('responses', fixtureFile, this.config.fixturesDir) as Record<
      string,
      unknown
    >
    assertPartialMatch(this.lastResponse.body as Record<string, unknown>, expected)
  },
)

Then(
  'the response body at {word} should equal {string}',
  function (this: ComponentTestWorld, jsonPath: string, expected: string) {
    assert.ok(this.lastResponse, 'No response recorded')
    const actual = valueAt(this.lastResponse.body, jsonPath)
    assert.equal(String(actual), expected)
  },
)

Then(
  'the response body at {word} should be an integer',
  function (this: ComponentTestWorld, jsonPath: string) {
    assert.ok(this.lastResponse, 'No response recorded')
    const actual = valueAt(this.lastResponse.body, jsonPath)
    assert.ok(
      Number.isInteger(actual),
      `Expected integer at ${jsonPath}, got ${typeof actual}: ${actual}`,
    )
  },
)

Then(
  'the response body at {word} should contain {int} items',
  function (this: ComponentTestWorld, jsonPath: string, count: number) {
    assert.ok(this.lastResponse, 'No response recorded')
    const actual = valueAt(this.lastResponse.body, jsonPath)
    assert.ok(Array.isArray(actual), `Expected array at ${jsonPath}`)
    assert.equal(actual.length, count)
  },
)

Then(
  'the response should contain header {word} with value {string}',
  function (this: ComponentTestWorld, header: string, expected: string) {
    assert.ok(this.lastResponse, 'No response recorded')
    const actual = this.lastResponse.headers[header.toLowerCase()]
    assert.equal(actual, expected)
  },
)

Then(
  'the response should contain header {word}',
  function (this: ComponentTestWorld, header: string) {
    assert.ok(this.lastResponse, 'No response recorded')
    const actual = this.lastResponse.headers[header.toLowerCase()]
    assert.ok(actual !== undefined, `Expected header "${header}" to be present`)
  },
)
