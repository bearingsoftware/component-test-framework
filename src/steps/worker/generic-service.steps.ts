import { When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'assert'
import { loadFixture } from '../../support/fixtures'
import { requireApiBaseUrl } from '../../support/config'
import type { ComponentTestWorld } from '../../support/world'

When(
  'the service {word} is called with the request {word} it returns the response {word}',
  async function (
    this: ComponentTestWorld,
    service: string,
    requestFile: string,
    responseFile: string,
  ) {
    const op = this.operationMap[service]
    if (!op) {
      throw new Error(`Unknown service/operation "${service}"`)
    }

    const fixture = loadFixture('requests', requestFile, this.config.fixturesDir) as Record<
      string,
      unknown
    >
    const { _pathParams, _queryParams, ...body } = fixture

    let resolvedPath = op.path
    if (_pathParams) {
      for (const [key, value] of Object.entries(_pathParams as Record<string, string>)) {
        resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(value))
      }
    }

    let queryString = ''
    if (_queryParams) {
      queryString = '?' + new URLSearchParams(_queryParams as Record<string, string>).toString()
    }

    const url = `${requireApiBaseUrl(this.config)}${resolvedPath}${queryString}`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`
    }

    const hasBody = !['GET', 'DELETE', 'HEAD'].includes(op.method.toUpperCase())
    const res = await fetch(url, {
      method: op.method,
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
    })

    const responseBody = res.status === 204 ? null : await res.json().catch(() => null)
    const responseHeaders: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })
    this.trackCall(service, requestFile, {
      status: res.status,
      body: responseBody,
      headers: responseHeaders,
    })

    // Compare with expected response fixture
    const expected = loadFixture('responses', responseFile, this.config.fixturesDir)
    assertDeepPartialMatch(responseBody, expected)
  },
)

Then(
  'the request to the service {word} with request {word} was called {int} time(s)',
  function (this: ComponentTestWorld, service: string, requestFile: string, count: number) {
    const actual = this.getCallCount(service, requestFile)
    assert.equal(
      actual,
      count,
      `Expected ${count} calls to ${service}:${requestFile}, got ${actual}`,
    )
  },
)

Then(
  'the total calls to the service {word} should be {int}',
  function (this: ComponentTestWorld, service: string, count: number) {
    let total = 0
    for (const [key, val] of this.callCounts.entries()) {
      if (key.startsWith(`${service}:`)) {
        total += val
      }
    }
    assert.equal(total, count, `Expected ${count} total calls to ${service}, got ${total}`)
  },
)

/**
 * Poll the database for a new record in a table, retrying until found or timeout.
 */
When(
  'I wait for a new record in {word} matching {string}',
  async function (this: ComponentTestWorld, table: string, whereClause: string) {
    assert.ok(this.db, 'Database client not configured')

    const maxWait = 30_000
    const interval = 500
    const start = Date.now()

    while (Date.now() - start < maxWait) {
      const result = await this.db.query(`SELECT * FROM ${table} WHERE ${whereClause} LIMIT 1`)
      if (result.rows.length > 0) {
        this.lastResponse = { status: 200, body: result.rows[0], headers: {} }
        return
      }
      await new Promise((resolve) => setTimeout(resolve, interval))
    }

    throw new Error(`Timed out waiting for record in ${table} WHERE ${whereClause}`)
  },
)

/**
 * Poll until `count` rows matching the predicate exist. The predicate is
 * interpolated verbatim, so callers must not pass untrusted input — this is
 * meant for feature-file authored assertions only.
 */
When(
  'I wait for {int} record(s) in {word} matching {string}',
  async function (this: ComponentTestWorld, count: number, table: string, whereClause: string) {
    assert.ok(this.db, 'Database client not configured')

    const maxWait = 30_000
    const interval = 500
    const start = Date.now()

    while (Date.now() - start < maxWait) {
      const result = await this.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${whereClause}`,
      )
      const actual = Number(result.rows[0]?.count ?? '0')
      if (actual >= count) return
      await new Promise((resolve) => setTimeout(resolve, interval))
    }

    throw new Error(`Timed out waiting for ${count} record(s) in ${table} WHERE ${whereClause}`)
  },
)

Then('the {word} table is empty', async function (this: ComponentTestWorld, table: string) {
  assert.ok(this.db, 'Database client not configured')
  const result = await this.db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}`,
  )
  const actual = Number(result.rows[0]?.count ?? '0')
  assert.equal(actual, 0, `expected ${table} to be empty, has ${actual} row(s)`)
})

function assertDeepPartialMatch(actual: unknown, expected: unknown, path = ''): void {
  if (expected === null || expected === undefined) {
    return
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `Expected array at ${path || 'root'}`)
    assert.equal((actual as unknown[]).length, expected.length, `Length mismatch at ${path}`)
    for (let i = 0; i < expected.length; i++) {
      assertDeepPartialMatch((actual as unknown[])[i], expected[i], `${path}[${i}]`)
    }
    return
  }
  if (typeof expected === 'object') {
    assert.ok(typeof actual === 'object' && actual !== null, `Expected object at ${path}`)
    for (const key of Object.keys(expected as Record<string, unknown>)) {
      assertDeepPartialMatch(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
      )
    }
    return
  }
  assert.equal(actual, expected, `Mismatch at ${path || 'root'}`)
}
