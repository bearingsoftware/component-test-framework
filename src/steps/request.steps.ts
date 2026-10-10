import { Given, When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'assert'
import type { ComponentTestWorld } from '../support/world'
import { sendOperation } from '../support/requests'
import { adoptTokens, jwtClaims, login, requestLogin } from '../support/auth'
import { rawRequest } from './api/raw-api.steps'
import { valueAt } from '../utils/json-path'

function lastResponse(world: ComponentTestWorld): NonNullable<ComponentTestWorld['lastResponse']> {
  if (!world.lastResponse) throw new Error('No response recorded')
  return world.lastResponse
}

/** The `id` of the last response body, which several steps below need. */
function lastResponseId(world: ComponentTestWorld): unknown {
  const id = (lastResponse(world).body as { id?: unknown } | null)?.id
  if (id === undefined || id === null) {
    throw new Error('No `id` field on the last response body')
  }
  return id
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
  )
}

let registered = false

/**
 * Register opt-in steps for requests, saved values, authentication and
 * response assertions, worded to match the steps secure-repo and joule-genie
 * wrote for themselves.
 *
 * Like {@link registerWaitingSteps}, they aren't registered on import, because
 * a suite that still defines its own copy would then have two matching
 * definitions, and Cucumber fails every step that matches both. Delete your
 * copies, then call this once in your support setup, after `registerHooks`.
 *
 * Values are kept with `world.remember` and read with `world.recall`, so a
 * suite's own steps can share them. The login steps need `auth.loginPath` in
 * the options given to `registerHooks`.
 */
export function registerRequestSteps(): void {
  // A second registration would make every one of these steps ambiguous.
  if (registered) return
  registered = true

  // --- Saving values ---

  Given('I capture the id as {word}', function (this: ComponentTestWorld, name: string) {
    this.remember(name, lastResponseId(this))
  })

  Given(
    'I capture {word} from the last response as {word}',
    function (this: ComponentTestWorld, path: string, name: string) {
      const value = valueAt(lastResponse(this).body, path)
      if (value === undefined) throw new Error(`Nothing at "${path}" in the last response`)
      this.remember(name, value)
    },
  )

  // --- Requests with saved and captured values ---

  When(
    'I send the request {word} to the {word} operation with {word} saved as {word}',
    async function (
      this: ComponentTestWorld,
      requestFile: string,
      operationId: string,
      placeholder: string,
      name: string,
    ) {
      await sendOperation(this, operationId, {
        requestFile,
        pathParams: { [placeholder]: this.recall(name) },
      })
    },
  )

  When(
    'I send the request {word} to the {word} operation with saved id {word}',
    async function (
      this: ComponentTestWorld,
      requestFile: string,
      operationId: string,
      name: string,
    ) {
      await sendOperation(this, operationId, { requestFile, pathParams: { id: this.recall(name) } })
    },
  )

  // "… with oid from last response", "… with sid from last response" and so
  // on: fills the named placeholder with the last response's id. A regular
  // expression rather than {word}, so it doesn't also match "with id from last
  // response", which the framework already defines.
  When(
    /^I send the request (\S+) to the (\S+) operation with (?!id )(\w+) from last response$/,
    async function (
      this: ComponentTestWorld,
      requestFile: string,
      operationId: string,
      placeholder: string,
    ) {
      await sendOperation(this, operationId, {
        requestFile,
        pathParams: { [placeholder]: lastResponseId(this) },
      })
    },
  )

  When(
    'I send the request {word} to the {word} operation with {word} {word} and {word} from last response',
    async function (
      this: ComponentTestWorld,
      requestFile: string,
      operationId: string,
      savedPlaceholder: string,
      name: string,
      placeholder: string,
    ) {
      await sendOperation(this, operationId, {
        requestFile,
        pathParams: { [savedPlaceholder]: this.recall(name), [placeholder]: lastResponseId(this) },
      })
    },
  )

  When(
    'I send an authed {word} to {string} with body {string}',
    async function (this: ComponentTestWorld, method: string, path: string, body: string) {
      await rawRequest(this, method.toUpperCase(), path, {
        headers: { Authorization: `Bearer ${this.accessToken ?? ''}` },
        body,
        contentType: 'application/json',
      })
    },
  )

  // --- Authentication ---

  When(
    'I log in as {string} with password {string}',
    async function (this: ComponentTestWorld, username: string, password: string) {
      await login(this, username, password)
    },
  )

  // Doesn't throw on a failed login, and records the response, so a scenario
  // can assert that someone can't sign in.
  When(
    'I attempt to log in as {string} with password {string}',
    async function (this: ComponentTestWorld, username: string, password: string) {
      this.lastResponse = await requestLogin(this.config, username, password)
    },
  )

  When('I remember the current token as {word}', function (this: ComponentTestWorld, name: string) {
    if (!this.accessToken) throw new Error('No current token to remember')
    this.remember(`token:${name}`, this.accessToken)
  })

  When('I use the remembered token {word}', function (this: ComponentTestWorld, name: string) {
    this.accessToken = this.recall<string>(`token:${name}`)
  })

  When('I adopt the tokens from the last response', function (this: ComponentTestWorld) {
    adoptTokens(this, lastResponse(this).body)
  })

  // --- Response assertions ---

  Then('the response body contains {string}', function (this: ComponentTestWorld, text: string) {
    const body = JSON.stringify(this.lastResponse?.body ?? '')
    assert.ok(body.includes(text), `response body lacks ${JSON.stringify(text)}: ${body}`)
  })

  Then(
    'the response body does not contain {string}',
    function (this: ComponentTestWorld, text: string) {
      const body = JSON.stringify(this.lastResponse?.body ?? '')
      assert.ok(!body.includes(text), `response body contains ${JSON.stringify(text)}: ${body}`)
    },
  )

  Then(
    'the response header {word} contains {string}',
    function (this: ComponentTestWorld, name: string, want: string) {
      const got = this.lastResponse?.headers?.[name.toLowerCase()]
      assert.ok(
        got !== undefined && got.includes(want),
        `header ${name} = ${JSON.stringify(got)}, want it to contain ${JSON.stringify(want)}`,
      )
    },
  )

  Then(
    'the response body at {word} should be a non-empty string',
    function (this: ComponentTestWorld, path: string) {
      const value = valueAt(lastResponse(this).body, path)
      assert.ok(
        typeof value === 'string' && value.length > 0,
        `expected response body at ${path} to be non-empty string, got: ${JSON.stringify(value)}`,
      )
    },
  )

  Then(
    'the response body at {word} should not be empty',
    function (this: ComponentTestWorld, path: string) {
      const value = valueAt(lastResponse(this).body, path)
      assert.ok(
        !isEmpty(value),
        `expected non-empty value at ${path}, got ${JSON.stringify(value)}`,
      )
    },
  )

  Then(
    'the response body should contain {int} items',
    function (this: ComponentTestWorld, count: number) {
      const body = lastResponse(this).body
      assert.ok(Array.isArray(body), `expected array response body, got ${typeof body}`)
      assert.equal(body.length, count, `expected ${count} items, got ${body.length}`)
    },
  )

  Then(
    'the response body should not have {word}',
    function (this: ComponentTestWorld, key: string) {
      const body = lastResponse(this).body
      if (body && typeof body === 'object' && key in body) {
        throw new Error(
          `expected no ${key}, got ${JSON.stringify((body as Record<string, unknown>)[key])}`,
        )
      }
    },
  )

  Then(
    'the token at {word} in the response has claim {word} equal to {string}',
    function (this: ComponentTestWorld, path: string, claim: string, want: string) {
      const token = valueAt(lastResponse(this).body, path)
      assert.ok(typeof token === 'string' && token, `No token at "${path}" in the last response`)
      const got = jwtClaims(token)[claim]
      assert.equal(
        String(got),
        want,
        `token claim ${claim} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
      )
    },
  )

  // --- Debugging ---

  // Writes the last response to stderr, so CI logs show what the server said.
  Then('I dump the last response', function (this: ComponentTestWorld) {
    const r = this.lastResponse
    process.stderr.write(
      r
        ? `DEBUG: status=${r.status} body=${JSON.stringify(r.body)}\n`
        : 'DEBUG: no lastResponse recorded\n',
    )
  })
}
