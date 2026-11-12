import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client } from 'pg'
import { runMigrations } from '../support/migrations'
import { postgresAdapter } from './postgres'

// The signal file of the second worker's migration command: once it exists,
// that command is connected to the template.
const state = vi.hoisted(() => ({ signal: '' }))

// Worker A's copy starts only once worker B's command has connected to the
// template, or after 1.5s if it never can. With the lock held through the
// copy, B can't start, so A copies after the wait. If the lock is let go
// first, B connects, and A's copy finds the template in use.
vi.mock('../support/worker-database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../support/worker-database')>()
  const fsm = await import('fs')
  return {
    ...actual,
    prepareWorkerDatabase: async (url: string, options?: object) => {
      for (let i = 0; i < 30 && !fsm.existsSync(state.signal); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return actual.prepareWorkerDatabase(url, { ...options, templateBusyTimeoutMs: 500 })
    },
  }
})

// Against a real Postgres: DATABASE_URL. Skipped without it.
const base = process.env.DATABASE_URL

function urlFor(name: string): string {
  const url = new URL(base as string)
  url.pathname = `/${name}`
  return url.toString()
}

describe.skipIf(!base)('postgresAdapter migrations and copy (COMPONENT-24)', () => {
  const run = `ctf_adp_${process.pid}_${Date.now()}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-adp-'))
  const script = path.join(dir, 'migrate.js')
  const release = path.join(dir, 'release')
  const signal = path.join(dir, 'signal')

  const admin = async <T>(fn: (c: Client) => Promise<T>) => {
    const c = new Client({ connectionString: urlFor('postgres') })
    await c.connect()
    try {
      return await fn(c)
    } finally {
      await c.end()
    }
  }

  beforeAll(async () => {
    state.signal = signal
    fs.writeFileSync(
      script,
      `const { Client } = require(${JSON.stringify(require.resolve('pg'))})
const fs = require('fs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  await c.query('CREATE TABLE IF NOT EXISTS widgets (id serial PRIMARY KEY)')
  if (process.env.HOLD) {
    fs.writeFileSync(${JSON.stringify(signal)}, 'connected')
    for (let i = 0; !fs.existsSync(${JSON.stringify(release)}) && i < 600; i++) await sleep(50)
  }
  await c.end()
})().catch((e) => { console.error(e.message); process.exit(3) })
`,
    )
    await admin((c) => c.query(`CREATE DATABASE "${run}_tpl"`))
  })

  afterAll(async () => {
    await admin(async (c) => {
      for (const db of [`${run}_tpl`, `${run}_tpl_w1`]) {
        await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
      }
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('copies under the lock, so a second worker cannot hold the template during the copy', async () => {
    Object.assign(process.env, {
      CUCUMBER_PARALLEL: 'true',
      CUCUMBER_WORKER_ID: '1',
      CUCUMBER_TOTAL_WORKERS: '2',
    })
    const source = urlFor(`${run}_tpl`)
    const command = `node "${script}"`
    try {
      const adapter = postgresAdapter({
        url: urlFor(`${run}_tpl_w1`),
        workerDatabase: { sourceUrl: source },
        migrations: { command },
      })
      const a = adapter.beforeAll?.call(adapter, {} as never, undefined as never) as Promise<void>
      await new Promise((resolve) => setTimeout(resolve, 300))
      // Worker B: connects to the template and holds it until released.
      const b = runMigrations(source, { command, env: { HOLD: '1' } })
      try {
        await a
      } finally {
        fs.writeFileSync(release, 'go')
        await b.catch(() => {})
      }
    } finally {
      delete process.env.CUCUMBER_PARALLEL
      delete process.env.CUCUMBER_WORKER_ID
      delete process.env.CUCUMBER_TOTAL_WORKERS
    }
    const c = new Client({ connectionString: urlFor(`${run}_tpl_w1`) })
    await c.connect()
    const { rows } = await c.query(
      `SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'widgets'`,
    )
    await c.end()
    expect(Number(rows[0].n)).toBe(1)
  }, 30_000)
})
