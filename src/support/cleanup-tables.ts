import type { DiscoverTablesOptions } from '../types'

/** Migration bookkeeping tables, never emptied by discovery. */
export const DEFAULT_KEEP_TABLES = [
  'schema_migrations',
  'schema_migration',
  'goose_db_version',
  'flyway_schema_history',
  'knex_migrations',
  'knex_migrations_lock',
  'gorp_migrations',
  '_prisma_migrations',
  '__drizzle_migrations',
  'alembic_version',
  'django_migrations',
  'atlas_schema_revisions',
  '_sqlx_migrations',
  '__diesel_schema_migrations',
  'SequelizeMeta',
  '__EFMigrationsHistory',
  'refinery_schema_history',
]

export type CleanupPlan =
  | { kind: 'list'; tables: string[] }
  | { kind: 'discover'; schema: string; keep: string[]; assertEmptyAtStart: boolean }

/** Normalise `cleanupTables`, throwing on a malformed discovery object. */
export function parseCleanupTables(
  value: string[] | DiscoverTablesOptions | undefined,
): CleanupPlan | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return { kind: 'list', tables: value }
  if (typeof value !== 'object' || value === null || value.discover !== true) {
    throw new Error('cleanupTables must be a list of table names or { discover: true, … }')
  }
  const { schema = 'public', keep = [], assertEmptyAtStart = false } = value
  if (typeof schema !== 'string' || schema === '') {
    throw new Error('cleanupTables.schema must be a non-empty string')
  }
  if (!Array.isArray(keep) || keep.some((t) => typeof t !== 'string')) {
    throw new Error('cleanupTables.keep must be a list of table names')
  }
  return {
    kind: 'discover',
    schema,
    keep: [...DEFAULT_KEEP_TABLES, ...keep],
    assertEmptyAtStart: Boolean(assertEmptyAtStart),
  }
}
