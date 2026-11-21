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

  it('throws when a kept table references a discovered one', async () => {
    await admin.query(
      `CREATE TABLE ${q('kept_child')} (id serial PRIMARY KEY, p int REFERENCES ${q('parents')} (id))`,
    )
    const fresh = new DbClient(url)
    try {
      await expect(
        fresh.cleanDiscovered({ schema, keep: [...keep, 'kept_child'] }),
      ).rejects.toThrow(
        new RegExp(`${schema}\\.kept_child -> ${schema}\\.parents[\\s\\S]*drop the foreign key`),
      )
      await expect(fresh.cleanDiscovered({ schema, keep })).resolves.toBeUndefined()
    } finally {
      await fresh.close()
      await admin.query(`DROP TABLE ${q('kept_child')}`)
    }
  })

  it('truncates a discovered table with a self-reference', async () => {
    await admin.query(`
      CREATE TABLE ${q('tree')} (id serial PRIMARY KEY, up int REFERENCES ${q('tree')} (id));
      INSERT INTO ${q('tree')} (up) VALUES (NULL);
      INSERT INTO ${q('tree')} (up) VALUES (1);
    `)
    const fresh = new DbClient(url)
    try {
      await fresh.cleanDiscovered({ schema, keep })
      expect(await count('tree')).toBe(0)
    } finally {
      await fresh.close()
      await admin.query(`DROP TABLE ${q('tree')}`)
    }
  })

  it('throws, and touches nothing, when a table in another schema references a discovered one', async () => {
    const other = `${schema}_other`
    await admin.query(`
      CREATE SCHEMA "${other}";
      CREATE TABLE ${q('foreign_child', other)} (p int REFERENCES ${q('parents')} (id));
      INSERT INTO ${q('parents')} (name) VALUES ('x');
      INSERT INTO ${q('foreign_child', other)} VALUES (1);
    `)
    const fresh = new DbClient(url)
    try {
      await expect(fresh.cleanDiscovered({ schema, keep })).rejects.toThrow(
        new RegExp(`${other}\\.foreign_child -> ${schema}\\.parents[\\s\\S]*drop the foreign key`),
      )
      expect(await count('foreign_child', other)).toBe(1)
      expect(await count('parents')).toBe(1)
    } finally {
      await fresh.close()
      await admin.query(
        `DROP SCHEMA "${other}" CASCADE; TRUNCATE ${q('parents')} RESTART IDENTITY CASCADE`,
      )
    }
  })

  describe('inheritance and partitions', () => {
    const other = `${schema}_inh`
    const fresh = () => new DbClient(url)
    beforeAll(async () => {
      await admin.query(`CREATE SCHEMA "${other}"`)
    })
    afterAll(async () => {
      await admin.query(`DROP SCHEMA "${other}" CASCADE`)
    })

    it('throws on an INHERITS child, including a chain, in another schema', async () => {
      await admin.query(`
        CREATE TABLE ${q('base')} (id int);
        CREATE TABLE ${q('mid')} () INHERITS (${q('base')});
        CREATE TABLE ${q('leaf', other)} () INHERITS (${q('mid')});
        INSERT INTO ${q('leaf', other)} VALUES (1);
      `)
      const c = fresh()
      try {
        await expect(c.cleanDiscovered({ schema, keep })).rejects.toThrow(
          new RegExp(`${other}\\.leaf inherits ${schema}\\.mid`),
        )
        expect(await count('leaf', other)).toBe(1)
      } finally {
        await c.close()
        await admin.query(
          `DROP TABLE ${q('leaf', other)}; DROP TABLE ${q('mid')}; DROP TABLE ${q('base')}`,
        )
      }
    })

    it('throws on a partition in another schema', async () => {
      await admin.query(`
        CREATE TABLE ${q('events')} (id int) PARTITION BY RANGE (id);
        CREATE TABLE ${q('events_far', other)} PARTITION OF ${q('events')} FOR VALUES FROM (0) TO (10);
      `)
      const c = fresh()
      try {
        await expect(c.cleanDiscovered({ schema, keep })).rejects.toThrow(
          new RegExp(`${other}\\.events_far inherits ${schema}\\.events`),
        )
      } finally {
        await c.close()
        await admin.query(`DROP TABLE ${q('events')}`)
      }
    })

    it('still empties same-schema partitions', async () => {
      await admin.query(`
        CREATE TABLE ${q('metrics')} (id int) PARTITION BY RANGE (id);
        CREATE TABLE ${q('metrics_a')} PARTITION OF ${q('metrics')} FOR VALUES FROM (0) TO (10);
        INSERT INTO ${q('metrics')} VALUES (1);
      `)
      const c = fresh()
      try {
        await c.cleanDiscovered({ schema, keep })
        expect(await count('metrics_a')).toBe(0)
      } finally {
        await c.close()
        await admin.query(`DROP TABLE ${q('metrics')}`)
      }
    })
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
