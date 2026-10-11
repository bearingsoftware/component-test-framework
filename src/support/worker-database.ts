import type { Client } from 'pg'
import { workerDatabaseUrl } from './worker'

/** Options for {@link prepareWorkerDatabase}. */
export interface WorkerDatabaseOptions {
  /**
   * The database each worker's copy is cloned from. Default: the database in
   * the URL, which should be migrated (and seeded, if the suite relies on
   * that) before the run, and have no open connections while workers clone it.
   */
  template?: string
  /** A database to connect to while creating the copy. Default `postgres`. */
  maintenanceDatabase?: string
  /**
   * How long to keep retrying while the template is in use (another session
   * connected to it), in ms. Default 15s.
   */
  templateBusyTimeoutMs?: number
}

const prepared = new Map<string, Promise<string>>()

/**
 * Create this worker's database, a fresh copy of the template, and return
 * its URL. When not running in parallel it does nothing and returns `url`.
 *
 * It runs once per worker, however often it's called, so a service's
 * `beforeStart` and `registerHooks` can both await it: whichever runs first
 * creates the database, and the other waits for it. A copy left by an
 * earlier run is dropped first. It needs Postgres 13 or later.
 */
export function prepareWorkerDatabase(
  url: string,
  options: WorkerDatabaseOptions = {},
): Promise<string> {
  const target = workerDatabaseUrl(url)
  if (target === url) return Promise.resolve(url)
  let pending = prepared.get(target)
  if (!pending) {
    pending = cloneDatabase(url, target, options)
    prepared.set(target, pending)
    // A failed attempt isn't remembered, so a later call can try again.
    pending.catch(() => prepared.delete(target))
  }
  return pending
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || 'postgres'
}

/** Quote a name as a Postgres identifier. */
function identifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

async function cloneDatabase(
  url: string,
  target: string,
  options: WorkerDatabaseOptions,
): Promise<string> {
  const template = options.template ?? databaseName(url)
  const name = databaseName(target)
  const maintenance = new URL(url)
  maintenance.pathname = `/${encodeURIComponent(options.maintenanceDatabase ?? 'postgres')}`

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require('pg') as typeof import('pg')
  const client: Client = new pg.Client({ connectionString: maintenance.toString() })
  await client.connect()
  try {
    await client.query(`DROP DATABASE IF EXISTS ${identifier(name)} WITH (FORCE)`)
    const deadline = Date.now() + (options.templateBusyTimeoutMs ?? 15_000)
    for (let delay = 100; ; delay = Math.min(delay * 2, 1_000)) {
      try {
        await client.query(`CREATE DATABASE ${identifier(name)} TEMPLATE ${identifier(template)}`)
        return target
      } catch (err) {
        // 55006, object_in_use: something is connected to the template.
        if ((err as { code?: string }).code !== '55006' || Date.now() + delay > deadline) {
          const hint =
            (err as { code?: string }).code === '55006'
              ? ` Something is still connected to "${template}": nothing may use the template database while workers copy it.`
              : ''
          throw new Error(
            `Could not create worker database "${name}" from "${template}": ${(err as Error).message}.${hint}`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  } finally {
    await client.end()
  }
}
