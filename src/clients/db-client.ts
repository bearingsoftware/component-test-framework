import type { Pool, QueryResult, QueryResultRow } from 'pg'

/**
 * pg, loaded on first use rather than when this module is imported, so a
 * suite without a database never loads it.
 */
function pg(): typeof import('pg') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('pg') as typeof import('pg')
}

/**
 * Thin wrapper around pg.Pool for test database operations:
 * seeding data, running assertions, and cleaning up between scenarios.
 */
export class DbClient {
  private pool: Pool
  /** Set once a DELETE cleanup has been refused by a foreign key; see cleanTables. */
  private cascadeNeeded = false
  /** Discovered tables per schema and keep list, for the run. */
  private discovered = new Map<string, string[]>()

  constructor(connectionString: string) {
    this.pool = new (pg().Pool)({ connectionString })
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
   * The base tables of `schema` (partitions excluded) except those in `keep`,
   * read from the catalog. Not cached; see {@link cleanDiscovered}.
   */
  async discoverTables(schema: string, keep: string[] = []): Promise<string[]> {
    const { rows } = await this.pool.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        ORDER BY c.relname`,
      [schema],
    )
    const skip = new Set(keep)
    const tables = rows.map((r) => r.relname).filter((t) => !skip.has(t))
    const fks = await this.pool.query<{ child: string; parent: string }>(
      `SELECT child.relname AS child, parent.relname AS parent
         FROM pg_constraint k
         JOIN pg_class child ON child.oid = k.conrelid
         JOIN pg_class parent ON parent.oid = k.confrelid
         JOIN pg_namespace n ON n.oid = child.relnamespace
        WHERE k.contype = 'f' AND n.nspname = $1 AND parent.relnamespace = child.relnamespace
        ORDER BY child.relname, parent.relname`,
      [schema],
    )
    const found = new Set(tables)
    const conflicts = fks.rows.filter((r) => skip.has(r.child) && found.has(r.parent))
    if (conflicts.length > 0) {
      const pairs = conflicts.map((r) => `${r.child} -> ${r.parent}`).join(', ')
      throw new Error(
        `cleanupTables: kept table(s) reference discovered tables (${pairs}). Emptying the referenced ` +
          `table would also empty the kept one. Remove the kept table from keep so it is cleaned, or drop the foreign key.`,
      )
    }
    return tables
  }

  /**
   * Empty every discovered table in one `TRUNCATE ... RESTART IDENTITY CASCADE`,
   * which needs no foreign-key order. The list is cached for the run, but an
   * empty result is not (the service under test may apply its schema after the
   * first hook), and a table that has gone missing (SQLSTATE 42P01) triggers one
   * re-discovery. Discovery throws when a kept table in the schema references a discovered one; CASCADE is
   * only a safety net for references from other schemas. Retries on deadlock like {@link cleanTables}.
   */
  async cleanDiscovered(
    { schema, keep = [] }: { schema: string; keep?: string[] },
    opts?: { maxAttempts?: number; baseDelayMs?: number },
  ): Promise<void> {
    const maxAttempts = opts?.maxAttempts ?? 4
    const baseDelayMs = opts?.baseDelayMs ?? 50
    const key = JSON.stringify([schema, keep])
    let rediscovered = false
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let tables = this.discovered.get(key)
      if (!tables) {
        tables = await this.discoverTables(schema, keep)
        if (tables.length === 0) return
        this.discovered.set(key, tables)
      }
      try {
        await this.pool.query(
          `TRUNCATE ${tables.map(qualified(schema)).join(', ')} RESTART IDENTITY CASCADE`,
        )
        return
      } catch (err) {
        if (isUndefinedTable(err) && !rediscovered) {
          rediscovered = true
          this.discovered.delete(key)
          attempt--
          continue
        }
        if (!isDeadlock(err) || attempt === maxAttempts) throw err
        const delay = baseDelayMs * 2 ** (attempt - 1)
        console.warn(
          `[component-test-framework] cleanup deadlock on attempt ${attempt}/${maxAttempts}; retrying in ${delay}ms`,
        )
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  /** The tables of `schema` among `tables` that have at least one row, in the given order. */
  async nonEmptyTables(schema: string, tables: string[]): Promise<string[]> {
    if (tables.length === 0) return []
    const sql = tables
      .map((t, i) => `SELECT ${i} AS i WHERE EXISTS (SELECT 1 FROM ${qualified(schema)(t)})`)
      .join(' UNION ALL ')
    const { rows } = await this.pool.query<{ i: number }>(sql)
    return rows
      .map((r) => r.i)
      .sort((a, b) => a - b)
      .map((i) => tables[i])
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

  /**
   * Insert one row, quoting the column names so they keep their case. {@link seed}
   * writes them as given, so Postgres folds them to lower case.
   */
  async insertRow(table: string, row: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(row)
    const names = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ')
    const params = columns.map((_, i) => `$${i + 1}`).join(', ')
    if (columns.length === 0) {
      await this.pool.query(`INSERT INTO ${table} DEFAULT VALUES`)
      return
    }
    await this.pool.query(
      `INSERT INTO ${table} (${names}) VALUES (${params})`,
      columns.map((c) => row[c]),
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

/** Detect Postgres undefined-table errors (SQLSTATE 42P01). */
function isUndefinedTable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  return (err as { code?: unknown }).code === '42P01'
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function qualified(schema: string): (table: string) => string {
  return (table) => `${quoteIdent(schema)}.${quoteIdent(table)}`
}
