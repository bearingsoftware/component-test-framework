import { describe, it, expect } from 'vitest'
import { DEFAULT_KEEP_TABLES, parseCleanupTables } from './cleanup-tables'

describe('parseCleanupTables', () => {
  it('leaves an unset value unset', () => {
    expect(parseCleanupTables(undefined)).toBeUndefined()
  })

  it('keeps a list as it is', () => {
    expect(parseCleanupTables(['a', 'b'])).toEqual({ kind: 'list', tables: ['a', 'b'] })
  })

  it('defaults discovery to public, the migration tables and no guard', () => {
    expect(parseCleanupTables({ discover: true })).toEqual({
      kind: 'discover',
      schema: 'public',
      keep: DEFAULT_KEEP_TABLES,
      assertEmptyAtStart: false,
    })
  })

  it('adds keep to the default migration tables', () => {
    const plan = parseCleanupTables({
      discover: true,
      schema: 'app',
      keep: ['lookup'],
      assertEmptyAtStart: true,
    })
    expect(plan).toMatchObject({ kind: 'discover', schema: 'app', assertEmptyAtStart: true })
    expect(plan?.kind === 'discover' && plan.keep).toEqual([...DEFAULT_KEEP_TABLES, 'lookup'])
  })

  it.each([
    [{ discover: false }, /list of table names or/],
    [{ discover: true, schema: '' }, /schema/],
    [{ discover: true, keep: 'x' }, /keep/],
    [{ discover: true, keep: [1] }, /keep/],
  ])('rejects %j', (value, message) => {
    expect(() => parseCleanupTables(value as never)).toThrow(message)
  })
})

describe('default keep list', () => {
  it.each([
    '_sqlx_migrations',
    '__diesel_schema_migrations',
    'SequelizeMeta',
    '__EFMigrationsHistory',
    'refinery_schema_history',
  ])('includes %s', (name) => {
    expect(DEFAULT_KEEP_TABLES).toContain(name)
  })
})
