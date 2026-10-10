import { Then } from '@cucumber/cucumber'
import { strict as assert } from 'assert'
import type { ComponentTestWorld } from '../../support/world'
import { eventually, waitTimeout } from '../../support/eventually'
import { assertSafeTableName, countRows } from '../../support/db'

/**
 * Assert that `table` contains exactly `expected` rows matching the SQL
 * predicate, waiting up to the configured wait timeout for it to settle
 * there (COMPONENT-6). The predicate is interpolated verbatim into the WHERE
 * clause, so callers must not pass untrusted input — this step is intended
 * for feature files authored by the project, not for data-driven parameters.
 *
 * Table names are validated against a strict identifier pattern before
 * interpolation as defence-in-depth.
 */
Then(
  'the {word} table contains {int} row(s) matching {string}',
  async function (this: ComponentTestWorld, table: string, expected: number, predicate: string) {
    assertSafeTableName(table)
    await eventually(
      async () => {
        const actual = await countRows(this, table, predicate)
        assert.equal(
          actual,
          expected,
          `expected ${expected} row(s) in ${table} matching "${predicate}", got ${actual}`,
        )
      },
      { timeout: waitTimeout(this.config) },
    )
  },
)
