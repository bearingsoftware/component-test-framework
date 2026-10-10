import type { ComponentTestWorld } from './world'
import { StopRetrying } from './eventually'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

// The errors below throw StopRetrying: retrying can't fix them, so a wait
// that hits one fails at once instead of polling until it times out.

export function requireDb(world: ComponentTestWorld): NonNullable<ComponentTestWorld['db']> {
  if (!world.db) {
    throw new StopRetrying('DbClient is not configured — set databaseUrl on FrameworkConfig')
  }
  return world.db
}

/** Reject anything but a plain SQL identifier before it's interpolated into a query. */
export function assertSafeTableName(table: string): void {
  if (!IDENTIFIER.test(table)) {
    throw new StopRetrying(`unsafe table name: ${table}`)
  }
}

/**
 * Run a query, turning a failure (a syntax error in a predicate, a missing
 * table) into {@link StopRetrying}.
 */
export async function queryOnce<T extends Record<string, unknown>>(
  world: ComponentTestWorld,
  sql: string,
): Promise<T[]> {
  const db = requireDb(world)
  try {
    return (await db.query<T>(sql)).rows
  } catch (err) {
    throw new StopRetrying(`query failed: ${(err as Error).message}\n  ${sql}`)
  }
}

/**
 * Count rows in `table`, optionally filtered by a SQL predicate. The predicate
 * is interpolated verbatim, so it must come from project-authored feature
 * files, never from untrusted input.
 */
export async function countRows(
  world: ComponentTestWorld,
  table: string,
  predicate?: string,
): Promise<number> {
  assertSafeTableName(table)
  const where = predicate ? ` WHERE ${predicate}` : ''
  const rows = await queryOnce<{ count: string }>(
    world,
    `SELECT COUNT(*)::text AS count FROM ${table}${where}`,
  )
  return Number(rows[0]?.count ?? '0')
}
