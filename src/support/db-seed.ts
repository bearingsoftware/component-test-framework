import * as fs from 'fs'
import * as path from 'path'
import type { ComponentTestWorld } from './world'
import { assertSafeTableName, requireDb } from './db'

type Row = Record<string, unknown>

/** The rows of a Gherkin data table: the header row names the columns, an empty cell is NULL. */
export function rowsFromTable(table: string[][]): Row[] {
  const [header, ...body] = table
  if (!header || header.length === 0) throw new Error('the seed table needs a header row')
  return body.map((cells) => {
    if (cells.length !== header.length) {
      throw new Error(`seed row has ${cells.length} cells, the header has ${header.length}`)
    }
    return Object.fromEntries(
      header.map((column, i) => [column, cells[i] === '' ? null : cells[i]]),
    )
  })
}

/** Parse `{ "<table>": [ {row}, … ], … }`, keeping the key order. */
export function parseSeedJson(text: string, file: string): [string, Row[]][] {
  const data: unknown = JSON.parse(text)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${file}: expected an object of table names to row arrays`)
  }
  return Object.entries(data).map(([table, rows]) => {
    if (!Array.isArray(rows) || rows.some((r) => typeof r !== 'object' || r === null)) {
      throw new Error(`${file}: "${table}" must be an array of row objects`)
    }
    return [table, rows as Row[]]
  })
}

export async function seedTable(
  world: ComponentTestWorld,
  table: string,
  rows: Row[],
): Promise<void> {
  assertSafeTableName(table)
  const db = requireDb(world)
  for (const row of rows) await db.insertRow(table, row)
}

/** Seed from a `.json` or `.sql` file under the fixtures directory. */
export async function seedFromFile(world: ComponentTestWorld, name: string): Promise<void> {
  const db = requireDb(world)
  const root = path.resolve(world.config.fixturesDir)
  const file = path.resolve(root, name)
  if (!file.startsWith(root + path.sep)) {
    throw new Error(`seed file outside the fixtures directory: ${name}`)
  }
  if (!fs.existsSync(file)) throw new Error(`Seed file not found: ${file}`)
  const text = fs.readFileSync(file, 'utf-8')
  const ext = path.extname(file).toLowerCase()
  if (ext === '.sql') {
    await db.query(text)
  } else if (ext === '.json') {
    for (const [table, rows] of parseSeedJson(text, name)) await seedTable(world, table, rows)
  } else {
    throw new Error(`Seed file must be .json or .sql: ${name}`)
  }
}
