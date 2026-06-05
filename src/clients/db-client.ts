import { Pool } from 'pg'
import type { QueryResult, QueryResultRow } from 'pg'

/**
 * Thin wrapper around pg.Pool for test database operations:
 * seeding data, running assertions, and cleaning up between scenarios.
 */
export class DbClient {
  private pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString })
  }

  /** Execute a SQL query with optional parameters. */
  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, params)
  }

  /**
   * Truncate one or more tables with CASCADE.
   *
   * Retries on Postgres deadlock (SQLSTATE 40P01). When a long-running
   * service under test holds row locks via active queries, the
   * AccessExclusiveLock TRUNCATE needs can race with the service's
   * RowExclusiveLock + cascading FK locks and produce a circular wait.
   * PG picks a victim; if it picks us, the After-hook fails and the
   * next scenario inherits orphan locks. Retry with exponential backoff
   * resolves the rare deadlock without restructuring the harness to
   * stop the service under test per scenario.
   *
   * Configuration:
   *  - `maxAttempts`: total tries (default 4). Anything past attempt 1
   *    is a rare event; 4 covers worst-case CI contention storms.
   *  - `baseDelayMs`: first retry waits this long; each subsequent
   *    retry doubles (50, 100, 200ms). Total worst-case added wait
   *    on a 4-retry trip is 350ms.
   *
   * Non-deadlock errors (SQL syntax, perms, etc.) surface immediately
   * — only `40P01` triggers the retry path.
   */
  async truncateTables(
    tables: string[],
    opts?: { maxAttempts?: number; baseDelayMs?: number },
  ): Promise<void> {
    if (tables.length === 0) return
    const maxAttempts = opts?.maxAttempts ?? 4
    const baseDelayMs = opts?.baseDelayMs ?? 50

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.pool.query(`TRUNCATE ${tables.join(', ')} CASCADE`)
        return
      } catch (err) {
        if (!isDeadlock(err) || attempt === maxAttempts) {
          throw err
        }
        const delay = baseDelayMs * 2 ** (attempt - 1)
        console.warn(
          `[component-test-framework] TRUNCATE deadlock on attempt ${attempt}/${maxAttempts}; retrying in ${delay}ms`,
        )
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  /**
   * Bulk insert rows into a table.
   * @param table - Table name
   * @param rows - Array of objects where keys are column names
   */
  async seed(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return

    const columns = Object.keys(rows[0])
    const placeholders = rows.map(
      (_, rowIdx) =>
        `(${columns.map((_, colIdx) => `$${rowIdx * columns.length + colIdx + 1}`).join(', ')})`,
    )
    const values = rows.flatMap((row) => columns.map((col) => row[col]))

    await this.pool.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders.join(', ')}`,
      values,
    )
  }

  /** Close the connection pool. */
  async close(): Promise<void> {
    await this.pool.end()
  }
}

/** Detect Postgres deadlock errors (SQLSTATE 40P01). */
function isDeadlock(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return code === '40P01'
}
