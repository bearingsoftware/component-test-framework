import { describe, expect, it, vi } from 'vitest'
import { DbClient } from './db-client'

// We don't have a real Postgres in unit tests, so we stub the pg.Pool
// behind DbClient via spying on `query`. The retry logic is the only
// thing we're exercising here — the underlying SQL is opaque.
function makeClient(): DbClient {
  // The constructor builds a pg.Pool from the connection string. The
  // string is never actually dialled because every test replaces the
  // `pool.query` method before cleanTables runs.
  const c = new DbClient('postgres://stub/stub')
  return c
}

class PgDeadlockError extends Error {
  code = '40P01'
}

describe('DbClient.cleanTables deadlock retry', () => {
  it('returns after a clean first attempt', async () => {
    const c = makeClient()
    const query = vi.fn().mockResolvedValue({ rowCount: 0 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).pool = { query }

    await c.cleanTables(['users'])
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('retries on deadlock then succeeds', async () => {
    const c = makeClient()
    const query = vi
      .fn()
      .mockRejectedValueOnce(new PgDeadlockError('deadlock detected'))
      .mockRejectedValueOnce(new PgDeadlockError('deadlock detected'))
      .mockResolvedValueOnce({ rowCount: 0 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).pool = { query }

    await c.cleanTables(['users', 'integrations'], { baseDelayMs: 1 })
    expect(query).toHaveBeenCalledTimes(3)
  })

  it('throws when deadlocks exhaust all attempts', async () => {
    const c = makeClient()
    const query = vi.fn().mockRejectedValue(new PgDeadlockError('deadlock detected'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).pool = { query }

    await expect(c.cleanTables(['users'], { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow(
      /deadlock detected/,
    )
    expect(query).toHaveBeenCalledTimes(3)
  })

  it('does not retry on non-deadlock errors', async () => {
    const c = makeClient()
    const err = Object.assign(new Error('syntax error'), { code: '42601' })
    const query = vi.fn().mockRejectedValue(err)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).pool = { query }

    await expect(c.cleanTables(['users'])).rejects.toThrow(/syntax error/)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('no-ops on an empty table list', async () => {
    const c = makeClient()
    const query = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).pool = { query }

    await c.cleanTables([])
    expect(query).not.toHaveBeenCalled()
  })
})

// SECREPO-608: TRUNCATE rewrites every table and index file and flushes them.
// Measured against a stock postgres:16 on 19 near-empty tables it costs 270ms
// against DELETE's 6.5ms, which made the per-scenario cleanup 75% of one
// consumer's suite and its 5s timeouts the top cause of CI failures.
class PgForeignKeyError extends Error {
  code = '23503'
}

describe('DbClient.cleanTables cleanup strategy', () => {
  function stub(c: DbClient, query: ReturnType<typeof vi.fn>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).pool = { query }
  }

  it('deletes rather than truncates', async () => {
    const c = makeClient()
    const query = vi.fn().mockResolvedValue({ rowCount: 0 })
    stub(c, query)

    await c.cleanTables(['findings', 'users'])

    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toBe('DELETE FROM findings; DELETE FROM users')
  })

  it('falls back to TRUNCATE CASCADE when a foreign key outside the list blocks the delete', async () => {
    const c = makeClient()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const query = vi
      .fn()
      .mockRejectedValueOnce(new PgForeignKeyError('update or delete on table "users" violates'))
      .mockResolvedValue({ rowCount: 0 })
    stub(c, query)

    await c.cleanTables(['users'])

    expect(query.mock.calls.map((call) => String(call[0]).split(' ')[0])).toEqual([
      'DELETE',
      'TRUNCATE',
    ])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/cleanupTables/)
    warn.mockRestore()
  })

  it('stops trying to delete once a foreign key has forced the fallback', async () => {
    const c = makeClient()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const query = vi
      .fn()
      .mockRejectedValueOnce(new PgForeignKeyError('violates foreign key constraint'))
      .mockResolvedValue({ rowCount: 0 })
    stub(c, query)

    await c.cleanTables(['users'])
    query.mockClear()
    await c.cleanTables(['users'])

    expect(query).toHaveBeenCalledTimes(1)
    expect(String(query.mock.calls[0][0]).split(' ')[0]).toBe('TRUNCATE')
    vi.restoreAllMocks()
  })

  it('retries a deadlocked delete without falling back', async () => {
    const c = makeClient()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const query = vi
      .fn()
      .mockRejectedValueOnce(new PgDeadlockError('deadlock detected'))
      .mockResolvedValue({ rowCount: 0 })
    stub(c, query)

    await c.cleanTables(['users'], { baseDelayMs: 1 })

    expect(query.mock.calls.map((call) => String(call[0]).split(' ')[0])).toEqual([
      'DELETE',
      'DELETE',
    ])
    vi.restoreAllMocks()
  })
})
