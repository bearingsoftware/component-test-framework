import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { DbClient } from './db-client'
import { postgresAdapter } from '../adapters/postgres'
import { DEFAULT_KEEP_TABLES } from '../support/cleanup-tables'

// Against a real Postgres: DATABASE_URL. Skipped without it.
const url = process.env.DATABASE_URL as string

describe.skipIf(!url)('DbClient table discovery (COMPONENT-37)', () => {
  const schema = `ctf_disc_${process.pid}_${Date.now()}`
  const keep = [...DEFAULT_KEEP_TABLES, 'lookup']
  const q = (t: string, s = schema) => `"${s}"."${t}"`
  let admin: Client
  let db: DbClient

  const count = async (t: string, s = schema) =>
    Number((await admin.query(`SELECT count(*) AS n FROM ${q(t, s)}`)).rows[0].n)

  beforeAll(async () => {
    admin = new Client({ connectionString: url })
    await admin.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`
      CREATE TABLE ${q('parents')} (id serial PRIMARY KEY, name text);
      CREATE TABLE ${q('children')} (id serial PRIMARY KEY, parent_id int REFERENCES ${q('parents')} (id));
      CREATE TABLE ${q('lookup')} (id serial PRIMARY KEY);
      CREATE TABLE ${q('goose_db_version')} (id serial PRIMARY KEY);
      CREATE VIEW ${q('parents_view')} AS SELECT * FROM ${q('parents')};
    `)
    db = new DbClient(url)
  })

  afterAll(async () => {
    await db?.close()
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin?.end()
  })

  it('discovers base tables and leaves out views and keep', async () => {
    expect(await db.discoverTables(schema, keep)).toEqual(['children', 'parents'])
  })

  it('truncates with foreign keys, restarts identity and keeps the kept tables', async () => {
    await admin.query(`
      INSERT INTO ${q('parents')} (name) VALUES ('a'), ('b');
      INSERT INTO ${q('children')} (parent_id) VALUES (1), (2);
      INSERT INTO ${q('lookup')} DEFAULT VALUES;
      INSERT INTO ${q('goose_db_version')} DEFAULT VALUES;
    `)
    await db.cleanDiscovered({ schema, keep })
    expect(await count('parents')).toBe(0)
    expect(await count('children')).toBe(0)
    expect(await count('lookup')).toBe(1)
    expect(await count('goose_db_version')).toBe(1)
    const { rows } = await admin.query(
      `INSERT INTO ${q('parents')} (name) VALUES ('c') RETURNING id`,
    )
    expect(rows[0].id).toBe(1)
    await admin.query(`DELETE FROM ${q('parents')}`)
  })

  it('re-discovers when a cached table has gone missing', async () => {
    const fresh = new DbClient(url)
    try {
      await admin.query(`CREATE TABLE ${q('temp_gone')} (id int)`)
      await fresh.cleanDiscovered({ schema, keep })
      await admin.query(`DROP TABLE ${q('temp_gone')}`)
      await expect(fresh.cleanDiscovered({ schema, keep })).resolves.toBeUndefined()
    } finally {
      await fresh.close()
    }
  })

  it('discovers tables created after an empty first discovery', async () => {
    const late = `${schema}_late`
    await admin.query(`CREATE SCHEMA "${late}"`)
    const fresh = new DbClient(url)
    try {
      await fresh.cleanDiscovered({ schema: late })
      await admin.query(
        `CREATE TABLE ${q('late', late)} (id int); INSERT INTO ${q('late', late)} VALUES (1)`,
      )
      await fresh.cleanDiscovered({ schema: late })
      expect(await count('late', late)).toBe(0)
    } finally {
      await fresh.close()
      await admin.query(`DROP SCHEMA "${late}" CASCADE`)
    }
  })

  it('names the non-empty tables', async () => {
    await admin.query(
      `INSERT INTO ${q('parents')} (name) VALUES ('x'); INSERT INTO ${q('children')} (parent_id) VALUES (1)`,
    )
    expect(await db.nonEmptyTables(schema, ['children', 'goose_db_version', 'parents'])).toEqual([
      'children',
      'goose_db_version',
      'parents',
    ])
    await db.cleanDiscovered({ schema, keep })
    expect(await db.nonEmptyTables(schema, ['children', 'parents'])).toEqual([])
  })

  describe('postgresAdapter assertEmptyAtStart', () => {
    // Two scenarios on one adapter instance; returns the first scenario's outcome.
    const scenarios = async (assertEmptyAtStart: boolean) => {
      const adapter = postgresAdapter({
        url,
        cleanupTables: { discover: true, schema, keep: ['lookup'], assertEmptyAtStart },
      })
      const state = adapter.setup!({} as never)
      try {
        await adapter.beforeScenario!({} as never, state)
        await adapter.beforeScenario!({} as never, state)
      } finally {
        await state.close()
      }
    }

    it('fails the first scenario naming the non-empty tables', async () => {
      await admin.query(
        `INSERT INTO ${q('parents')} (name) VALUES ('x'); INSERT INTO ${q('children')} (parent_id) VALUES (1)`,
      )
      await expect(scenarios(true)).rejects.toThrow(
        /before the first scenario: children, parents\./,
      )
    })

    it('passes on empty tables, and does nothing unless asked', async () => {
      await admin.query(`INSERT INTO ${q('parents')} (name) VALUES ('x')`)
      await expect(scenarios(false)).resolves.toBeUndefined()
      await admin.query(`DELETE FROM ${q('children')}; DELETE FROM ${q('parents')}`)
      await expect(scenarios(true)).resolves.toBeUndefined()
    })
  })
})
