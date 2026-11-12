import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { exec } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client } from 'pg'
import { runMigrations } from './migrations'
import { postgresAdapter } from '../adapters/postgres'
import { prepareWorkerDatabase } from './worker-database'

// Against a real Postgres: DATABASE_URL, which CI's reference job sets.
// Without it these tests are skipped. They create their own databases.
const base = process.env.DATABASE_URL

function urlFor(name: string): string {
  const url = new URL(base as string)
  url.pathname = `/${name}`
  return url.toString()
}

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: urlFor('postgres') })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

describe.skipIf(!base)('runMigrations against Postgres (COMPONENT-24)', () => {
  const run = `ctf_mig_${process.pid}_${Date.now()}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-mig-'))
  const script = path.join(dir, 'migrate.js')
  const log = path.join(dir, 'log.txt')
  const sourceDb = `${run}_src`
  const databases = [sourceDb, `${sourceDb}_w1`]

  beforeAll(async () => {
    // Idempotent, and slow enough that two unserialised runs would overlap.
    fs.writeFileSync(
      script,
      `const { Client } = require(${JSON.stringify(require.resolve('pg'))})
const fs = require('fs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  const id = process.pid
  fs.appendFileSync(process.env.MIG_LOG, 'start ' + id + ' ' + Date.now() + '\\n')
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  await c.query('CREATE TABLE IF NOT EXISTS widgets (id serial PRIMARY KEY, name text)')
  await sleep(Number(process.env.MIG_SLEEP ?? 0))
  await c.end()
  fs.appendFileSync(process.env.MIG_LOG, 'end ' + id + ' ' + Date.now() + '\\n')
})().catch((e) => { console.error(e.message); process.exit(3) })
`,
    )
    await admin((c) => c.query(`CREATE DATABASE "${sourceDb}"`))
  })

  afterAll(async () => {
    await admin(async (c) => {
      for (const db of databases) await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const options = (sleepMs = 0) => ({
    command: `node "${script}"`,
    env: { MIG_LOG: log, MIG_SLEEP: String(sleepMs) },
  })

  const count = async (database: string, sql: string) => {
    const c = new Client({ connectionString: urlFor(database) })
    await c.connect()
    try {
      return Number((await c.query(sql)).rows[0].n)
    } finally {
      await c.end()
    }
  }

  /** The [start, end] of each run in the log, in ms. */
  const intervals = () => {
    const runs = new Map<string, { start?: number; end?: number }>()
    for (const line of fs.readFileSync(log, 'utf-8').trim().split('\n')) {
      const [kind, id, at] = line.split(' ')
      runs.set(id, { ...runs.get(id), [kind]: Number(at) })
    }
    return [...runs.values()] as { start: number; end: number }[]
  }

  it('creates a table, and a second run is a no-op', async () => {
    const url = urlFor(sourceDb)
    await runMigrations(url, options())
    const tables = `SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'widgets'`
    expect(await count(sourceDb, tables)).toBe(1)
    await runMigrations(url, options())
    expect(await count(sourceDb, tables)).toBe(1)
  })

  it('serialises concurrent runs, where unlocked runs overlap', async () => {
    fs.writeFileSync(log, '')
    const url = urlFor(sourceDb)
    await Promise.all([
      runMigrations(url, options(500)),
      runMigrations(url, options(500)),
      runMigrations(url, options(500)),
    ])
    const locked = intervals().sort((a, b) => a.start - b.start)
    expect(locked).toHaveLength(3)
    for (let i = 1; i < locked.length; i++) {
      expect(locked[i].start).toBeGreaterThanOrEqual(locked[i - 1].end)
    }

    // Control: the same command without the lock does overlap, so the
    // check above can tell the difference.
    fs.writeFileSync(log, '')
    const env = { ...process.env, DATABASE_URL: url, MIG_LOG: log, MIG_SLEEP: '500' }
    await Promise.all(
      [1, 2].map(
        () =>
          new Promise<void>((resolve, reject) =>
            exec(`node "${script}"`, { env }, (err) => (err ? reject(err) : resolve())),
          ),
      ),
    )
    const unlocked = intervals().sort((a, b) => a.start - b.start)
    expect(unlocked[1].start).toBeLessThan(unlocked[0].end)
  })

  it('reports the exit code and output of a failing command, without the password', async () => {
    const url = urlFor(sourceDb)
    const secret = new URL(url).password
    const failing = {
      command: `echo "connecting with $DATABASE_URL"; echo oops >&2; exit 7`,
    }
    const err = await runMigrations(url, failing).then(
      () => undefined,
      (e: Error) => e,
    )
    expect(err?.message).toMatch(/exit code 7/)
    expect(err?.message).toContain('echo "connecting with $DATABASE_URL"')
    expect(err?.message).toContain('oops')
    if (secret) expect(err?.message).not.toContain(secret)
  })

  it('times out a command that runs too long', async () => {
    await expect(
      runMigrations(urlFor(sourceDb), { command: 'sleep 5', timeoutMs: 200 }),
    ).rejects.toThrow(/timed out after 200ms/)
  })

  it('gives up waiting for the lock with a message that names it', async () => {
    const url = urlFor(sourceDb)
    const holder = runMigrations(url, options(1500))
    await new Promise((resolve) => setTimeout(resolve, 300))
    await expect(runMigrations(url, options(), { lockTimeoutMs: 400 })).rejects.toThrow(
      /waiting for the migrations lock "ctf-migrations:/,
    )
    await holder
  })

  it('keeps the lock through the copy: two workers, each migrating while connected to the template', async () => {
    const tpl = `${run}_two`
    databases.push(tpl, `${tpl}_w1`, `${tpl}_w2`)
    await admin((c) => c.query(`CREATE DATABASE "${tpl}"`))
    const source = urlFor(tpl)
    const worker = (id: string) => {
      const mine = { ...options(3000) }
      return runMigrations(source, mine, {
        whileLocked: () => {
          // prepareWorkerDatabase reads the worker id when called, so set it just before.
          Object.assign(process.env, {
            CUCUMBER_PARALLEL: 'true',
            CUCUMBER_WORKER_ID: id,
            CUCUMBER_TOTAL_WORKERS: '2',
          })
          return prepareWorkerDatabase(source, { templateBusyTimeoutMs: 1000 })
        },
      })
    }
    try {
      // Each command holds a connection to the template for 3s. If the lock
      // were released before the copy, the other worker's command would hold
      // the template during this copy, which gives up after 1s.
      await Promise.all([worker('1'), worker('2')])
    } finally {
      delete process.env.CUCUMBER_PARALLEL
      delete process.env.CUCUMBER_WORKER_ID
      delete process.env.CUCUMBER_TOTAL_WORKERS
    }
    const tables = `SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'widgets'`
    expect(await count(`${tpl}_w1`, tables)).toBe(1)
    expect(await count(`${tpl}_w2`, tables)).toBe(1)
  }, 30_000)

  it('migrates the template before the adapter copies it for the worker', async () => {
    Object.assign(process.env, {
      CUCUMBER_PARALLEL: 'true',
      CUCUMBER_WORKER_ID: '1',
      CUCUMBER_TOTAL_WORKERS: '2',
    })
    try {
      const fresh = `${run}_tpl`
      databases.push(fresh, `${fresh}_w1`)
      await admin((c) => c.query(`CREATE DATABASE "${fresh}"`))
      const adapter = postgresAdapter({
        url: urlFor(`${fresh}_w1`),
        workerDatabase: { sourceUrl: urlFor(fresh) },
        migrations: options(),
      })
      await adapter.beforeAll?.call(adapter, {} as never, undefined as never)
      const tables = `SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'widgets'`
      expect(await count(fresh, tables)).toBe(1)
      expect(await count(`${fresh}_w1`, tables)).toBe(1)
    } finally {
      delete process.env.CUCUMBER_PARALLEL
      delete process.env.CUCUMBER_WORKER_ID
      delete process.env.CUCUMBER_TOTAL_WORKERS
    }
  })
})
