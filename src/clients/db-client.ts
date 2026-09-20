import { Pool } from 'pg'
import type { QueryResult, QueryResultRow } from 'pg'

/**
 * Thin wrapper around pg.Pool for test database operations:
 * seeding data, running assertions, and cleaning up between scenarios.
 */
export class DbClient {
  private pool: Pool
  /** Set once a DELETE cleanup has been refused by a foreign key; see cleanTables. */
  private cascadeNeeded = false

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
   * Empty the given tables between scenarios, children before parents.
   *
   * DELETE, not TRUNCATE. TRUNCATE creates a new file for every table and
   * index and flushes them at commit, which costs far more than removing a
   * handful of rows: measured against a stock postgres:16 on 19 near-empty
   * tables, 270ms against DELETE's 6.5ms. In secure-repo that made this hook
   * 75% of the suite's runtime and its 5s timeouts the biggest single cause
   * of CI failures (SECREPO-608).
   *
   * Falls back to TRUNCATE ... CASCADE when a foreign key from a table the
   * caller did not list blocks the delete. CASCADE empties those children
   * for free, which is what the list was relying on; DELETE cannot. The
   * fallback warns once, names the fix, and is then used for the rest of the
   * run rather than paying a failed DELETE per scenario.
   *
   * Retries on Postgres deadlock (SQLSTATE 40P01). When a long-running
   * service under test holds row locks via active queries, cleanup can race
   * with the service's own locks and produce a circular wait. PG picks a
   * victim; if it picks us, the After-hook fails and the next scenario
   * inherits orphan locks. Retry with exponential backoff resolves the rare
   * deadlock without restructuring the harness to stop the service under
   * test per scenario.
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
  async cleanTables(
    tables: string[],
    opts?: { maxAttempts?: number; baseDelayMs?: number },
  ): Promise<void> {
    if (tables.length === 0) return
    const maxAttempts = opts?.maxAttempts ?? 4
    const baseDelayMs = opts?.baseDelayMs ?? 50

    const deleteSql = tables.map((t) => `DELETE FROM ${t}`).join('; ')
    const truncateSql = `TRUNCATE ${tables.join(', ')} CASCADE`

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const sql = this.cascadeNeeded ? truncateSql : deleteSql
      try {
        await this.pool.query(sql)
        return
      } catch (err) {
        if (isForeignKeyViolation(err) && !this.cascadeNeeded) {
          this.cascadeNeeded = true
          console.warn(
            `[component-test-framework] cleanup DELETE hit a foreign key from a table outside cleanupTables; ` +
              `falling back to TRUNCATE CASCADE for the rest of this run. List the referencing table in ` +
              `cleanupTables (children first) to keep the faster path: ${String(err)}`,
          )
          continue
        }
        if (!isDeadlock(err) || attempt === maxAttempts) {
          throw err
        }
        const delay = baseDelayMs * 2 ** (attempt - 1)
        console.warn(
          `[component-test-framework] cleanup deadlock on attempt ${attempt}/${maxAttempts}; retrying in ${delay}ms`,
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

/** Detect Postgres foreign-key violations (SQLSTATE 23503). */
function isForeignKeyViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  return (err as { code?: unknown }).code === '23503'
}

/** Detect Postgres deadlock errors (SQLSTATE 40P01). */
function isDeadlock(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return code === '40P01'
}
