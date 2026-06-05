import { describe, expect, it, vi } from 'vitest'
import { DbClient } from './db-client'

// We don't have a real Postgres in unit tests, so we stub the pg.Pool
// behind DbClient via spying on `query`. The retry logic is the only
// thing we're exercising here — the underlying SQL is opaque.
function makeClient(): DbClient {
  // The constructor builds a pg.Pool from the connection string. The
  // string is never actually dialled because every test replaces the
  // `pool.query` method before truncateTables runs.
  const c = new DbClient('postgres://stub/stub')
  return c
}

class PgDeadlockError extends Error {
  code = '40P01'
}

describe('DbClient.truncateTables deadlock retry', () => {
  it('returns after a clean first attempt', async () => {
    const c = makeClient()
    const query = vi.fn().mockResolvedValue({ rowCount: 0 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).pool = { query }

    await c.truncateTables(['users'])
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

    await c.truncateTables(['users', 'integrations'], { baseDelayMs: 1 })
    expect(query).toHaveBeenCalledTimes(3)
  })

  it('throws when deadlocks exhaust all attempts', async () => {
    const c = makeClient()
    const query = vi.fn().mockRejectedValue(new PgDeadlockError('deadlock detected'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).pool = { query }

    await expect(c.truncateTables(['users'], { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow(
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

    await expect(c.truncateTables(['users'])).rejects.toThrow(/syntax error/)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('no-ops on an empty table list', async () => {
    const c = makeClient()
    const query = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).pool = { query }

    await c.truncateTables([])
    expect(query).not.toHaveBeenCalled()
  })
})
