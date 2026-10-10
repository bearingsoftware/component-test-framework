import type { ComponentTestWorld } from './world'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export function requireDb(world: ComponentTestWorld): NonNullable<ComponentTestWorld['db']> {
  if (!world.db) {
    throw new Error('DbClient is not configured — set databaseUrl on FrameworkConfig')
  }
  return world.db
}

/** Reject anything but a plain SQL identifier before it's interpolated into a query. */
export function assertSafeTableName(table: string): void {
  if (!IDENTIFIER.test(table)) {
    throw new Error(`unsafe table name: ${table}`)
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
  const result = await requireDb(world).query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}${where}`,
  )
  return Number(result.rows[0]?.count ?? '0')
}
