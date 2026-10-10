import { describe, it, expect } from 'vitest'
import { assertPartialMatch } from './match'

describe('assertPartialMatch (COMPONENT-6)', () => {
  const actual = { id: 1, user: { name: 'a', role: 'admin' }, tags: ['x', 'y'], deleted: null }

  it('ignores keys the expectation leaves out', () => {
    expect(() => assertPartialMatch(actual, { user: { name: 'a' } })).not.toThrow()
  })

  it('names the path of a mismatch', () => {
    expect(() => assertPartialMatch(actual, { user: { role: 'viewer' } })).toThrow(
      /Mismatch at user\.role/,
    )
    expect(() => assertPartialMatch(actual, { tags: ['x', 'z'] })).toThrow(/Mismatch at tags\[1\]/)
  })

  it('requires arrays to be the same length', () => {
    expect(() => assertPartialMatch(actual, { tags: ['x'] })).toThrow(
      /Array length mismatch at tags/,
    )
  })

  it('requires null to match null by default', () => {
    expect(() => assertPartialMatch(actual, { deleted: null })).not.toThrow()
    expect(() => assertPartialMatch(actual, { id: null })).toThrow(/Mismatch at id/)
  })

  it('can treat null as matching anything', () => {
    expect(() =>
      assertPartialMatch(actual, { id: null }, { nullMatchesAnything: true }),
    ).not.toThrow()
  })
})
