import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type StepFn = (this: unknown, ...args: unknown[]) => unknown

// Capture step definitions by expression so the real step functions can run
// without a Cucumber runtime.
const steps = vi.hoisted(() => new Map<string, StepFn>())

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (expression: string, optionsOrFn: unknown, maybeFn?: StepFn) =>
    steps.set(expression, (typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn) as StepFn)
  return { ...actual, Given: register, When: register, Then: register }
})

import { CucumberExpression, ParameterTypeRegistry } from '@cucumber/cucumber-expressions'
import { DbClient } from '../clients/db-client'
import './common/db-assertion.steps'
import './common/db-seed.steps'
import './worker/generic-service.steps'

const registry = new ParameterTypeRegistry()
const matching = (text: string) =>
  [...steps.keys()].filter((e) => new CucumberExpression(e, registry).match(text))

describe('the seed steps (COMPONENT-24)', () => {
  it('are registered', () => {
    expect(steps.has('the {word} table contains:')).toBe(true)
    expect(steps.has('the database is seeded from {string}')).toBe(true)
  })

  it.each([
    ['the orders table contains:', 'the {word} table contains:'],
    ['the database is seeded from "seed/orders.json"', 'the database is seeded from {string}'],
    [
      'the orders table contains 2 rows matching "sku = \'A\'"',
      'the {word} table contains {int} row(s) matching {string}',
    ],
    [
      'the orders table contains 1 row matching "x"',
      'the {word} table contains {int} row(s) matching {string}',
    ],
    ['the orders table is empty', 'the {word} table is empty'],
    [
      'I wait for 2 records in orders matching "x = 1"',
      'I wait for {int} record(s) in {word} matching {string}',
    ],
    [
      'I wait for a new record in orders matching "x = 1"',
      'I wait for a new record in {word} matching {string}',
    ],
  ])('%s matches exactly one definition', (text, expression) => {
    expect(matching(text)).toEqual([expression])
  })
})

const url = process.env.DATABASE_URL

describe.skipIf(!url)('seeding against Postgres (COMPONENT-24)', () => {
  const table = `ctf_seed_${process.pid}_${Date.now()}`
  const second = `${table}_b`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-seed-'))
  let db: DbClient
  let world: { db: DbClient; config: { fixturesDir: string } }

  const rows = async (name: string) =>
    Number((await db.query(`SELECT count(*) AS n FROM ${name}`)).rows[0].n)
  const run = (expression: string, ...args: unknown[]) =>
    (steps.get(expression) as StepFn).apply(world, args)

  beforeAll(async () => {
    db = new DbClient(url as string)
    world = { db, config: { fixturesDir: dir } }
    await db.query(
      `CREATE TABLE ${table} (id serial PRIMARY KEY, sku text NOT NULL, qty integer, "orderRef" text)`,
    )
    await db.query(`CREATE TABLE ${second} (id serial PRIMARY KEY, label text)`)
    fs.mkdirSync(path.join(dir, 'seed'))
    fs.writeFileSync(
      path.join(dir, 'seed', 'rows.json'),
      JSON.stringify({
        [table]: [
          { sku: 'J1', qty: 3, orderRef: 'r1' },
          { sku: 'J2', qty: null },
        ],
        [second]: [{ label: 'x' }],
      }),
    )
    fs.writeFileSync(
      path.join(dir, 'seed', 'rows.sql'),
      `INSERT INTO ${table} (sku, qty) VALUES ('S1', 1);\nINSERT INTO ${second} (label) VALUES ('a'), ('b');`,
    )
  })

  afterAll(async () => {
    await db.query(`DROP TABLE IF EXISTS ${table}, ${second}`)
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('seeds from a data table, with NULL for an empty cell and quoted column names', async () => {
    const data = {
      raw: () => [
        ['sku', 'qty', 'orderRef'],
        ['T1', '5', 'ref-1'],
        ['T2', '', ''],
      ],
    }
    await run('the {word} table contains:', table, data)
    expect(await rows(table)).toBe(2)
    const nulls = await db.query(
      `SELECT count(*) AS n FROM ${table} WHERE qty IS NULL AND "orderRef" IS NULL`,
    )
    expect(Number(nulls.rows[0].n)).toBe(1)
    await db.query(`DELETE FROM ${table}`)
  })

  it('seeds from a JSON fixture, every table in key order', async () => {
    await run('the database is seeded from {string}', 'seed/rows.json')
    expect(await rows(table)).toBe(2)
    expect(await rows(second)).toBe(1)
    await db.query(`DELETE FROM ${table}; DELETE FROM ${second}`)
  })

  it('seeds from a SQL fixture, as one multi-statement query', async () => {
    await run('the database is seeded from {string}', 'seed/rows.sql')
    expect(await rows(table)).toBe(1)
    expect(await rows(second)).toBe(2)
  })

  it('cleans what it seeded through cleanTables', async () => {
    await db.cleanTables([table, second])
    expect(await rows(table)).toBe(0)
    expect(await rows(second)).toBe(0)
  })

  it('refuses an unsafe table name, a missing file and a path outside the fixtures directory', async () => {
    await expect(
      run('the {word} table contains:', 'x; DROP TABLE y', { raw: () => [['a'], ['1']] }),
    ).rejects.toThrow(/unsafe table name/)
    await expect(run('the database is seeded from {string}', 'seed/none.json')).rejects.toThrow(
      /not found/,
    )
    await expect(run('the database is seeded from {string}', '../x.sql')).rejects.toThrow(
      /outside the fixtures directory/,
    )
  })
})
