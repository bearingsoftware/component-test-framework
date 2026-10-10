import { strict as assert } from 'assert'

export interface PartialMatchOptions {
  /**
   * When true, a `null` or `undefined` in `expected` matches any value. When
   * false (the default), it must match exactly.
   */
  nullMatchesAnything?: boolean
}

/**
 * Assert that `actual` contains everything in `expected`. Objects match when
 * every key in `expected` matches; extra keys in `actual` are ignored. Arrays
 * must be the same length and match element by element. Anything else must be
 * strictly equal. Failures name the path, e.g. `items[2].status`.
 */
export function assertPartialMatch(
  actual: unknown,
  expected: unknown,
  options: PartialMatchOptions = {},
): void {
  match(actual, expected, '', options)
}

function match(
  actual: unknown,
  expected: unknown,
  path: string,
  options: PartialMatchOptions,
): void {
  const at = path || 'root'
  if (expected === null || expected === undefined) {
    if (!options.nullMatchesAnything) assert.equal(actual, expected, `Mismatch at ${at}`)
    return
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `Expected array at ${at}`)
    assert.equal(actual.length, expected.length, `Array length mismatch at ${at}`)
    expected.forEach((item, i) => match(actual[i], item, `${path}[${i}]`, options))
    return
  }
  if (typeof expected === 'object') {
    assert.ok(
      typeof actual === 'object' && actual !== null,
      `Expected object at ${at}, got ${actual === null ? 'null' : typeof actual}`,
    )
    for (const [key, value] of Object.entries(expected)) {
      match((actual as Record<string, unknown>)[key], value, path ? `${path}.${key}` : key, options)
    }
    return
  }
  assert.equal(actual, expected, `Mismatch at ${at}`)
}
