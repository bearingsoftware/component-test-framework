import { Given } from '@cucumber/cucumber'
import type { DataTable } from '@cucumber/cucumber'
import type { ComponentTestWorld } from '../../support/world'
import { rowsFromTable, seedFromFile, seedTable } from '../../support/db-seed'

/**
 * Insert the table's rows, in order. The header row names the columns; an
 * empty cell is NULL. The `cleanupTables` cleanup removes them, so list the
 * table there.
 */
Given(
  'the {word} table contains:',
  async function (this: ComponentTestWorld, table: string, data: DataTable) {
    await seedTable(this, table, rowsFromTable(data.raw()))
  },
)

/** Seed from a `.json` ({ table: [rows] }) or `.sql` file, relative to `fixturesDir`. */
Given(
  'the database is seeded from {string}',
  async function (this: ComponentTestWorld, file: string) {
    await seedFromFile(this, file)
  },
)
