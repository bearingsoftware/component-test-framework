import { describe, it, expect } from 'vitest'
import { valueAt } from './json-path'

describe('valueAt (COMPONENT-7)', () => {
  const body = { user: { name: 'a' }, items: [{ id: 'i-0' }, { id: 'i-1' }] }

  it('reads dot paths and array elements either way', () => {
    expect(valueAt(body, 'user.name')).toBe('a')
    expect(valueAt(body, 'items[1].id')).toBe('i-1')
    expect(valueAt(body, 'items.0.id')).toBe('i-0')
    expect(valueAt([5, 6], '[1]')).toBe(6)
  })

  it('returns undefined for a missing last key', () => {
    expect(valueAt(body, 'user.age')).toBeUndefined()
  })

  it('names where a path runs through a non-object', () => {
    expect(() => valueAt(body, 'user.name.first')).toThrow(
      'Cannot resolve path "user.name.first" — hit string at "first"',
    )
  })
})
