import { spawn } from 'child_process'
import type { Client } from 'pg'

/** Options for {@link runMigrations}, and the `migrations` option of the config and the Postgres adapter. */
export interface MigrationsOptions {
  /**
   * A shell command that migrates the database named by `$DATABASE_URL`, for
   * example `migrate -path ./migrations -database "$DATABASE_URL" up`. It must
   * be idempotent: under `--parallel` every worker runs it, one at a time.
   */
  command: string
  /** Working directory of the command. Default `process.cwd()`. */
  cwd?: string
  /** Merged over `process.env`. `DATABASE_URL` is always the target database. */
  env?: Record<string, string>
  /** How long the command may run, in ms. Default 120_000. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const OUTPUT_LINES = 40

/** The URL with its password replaced, safe to print. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return url
  }
}

/** `text` with the URL's password, as written in the URL or decoded, replaced. */
export function redactPassword(text: string, url: string): string {
  let password: string
  try {
    password = new URL(url).password
  } catch {
    return text
  }
  if (!password) return text
  let result = text
  for (const form of new Set([password, decodeURIComponent(password)])) {
    if (form) result = result.split(form).join('***')
  }
  return result
}

/** The server database an advisory lock for migrating `url`'s database is taken in. */
function lockDatabase(name: string): string {
  return name === 'postgres' ? 'template1' : 'postgres'
}

/**
 * Run the migrations command against `databaseUrl`, one process at a time
 * across the server: it holds a Postgres advisory lock, keyed on the database
 * name, while the command runs. The lock is taken on a maintenance database,
 * not on `databaseUrl`'s own, and released before this returns, so nothing is
 * left connected to a database that is about to be copied as a template.
 */
export async function runMigrations(
  databaseUrl: string,
  options: MigrationsOptions,
): Promise<void> {
  const parsed = new URL(databaseUrl)
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'postgres'
  const maintenance = new URL(databaseUrl)
  maintenance.pathname = `/${encodeURIComponent(lockDatabase(name))}`

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require('pg') as typeof import('pg')
  const lock: Client = new pg.Client({ connectionString: maintenance.toString() })
  await lock.connect()
  try {
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`ctf-migrations:${name}`])
    await runMigrationCommand(databaseUrl, options)
  } finally {
    // Closing the connection releases the lock.
    await lock.end()
  }
}

export function runMigrationCommand(
  databaseUrl: string,
  options: MigrationsOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, {
      shell: true,
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env, DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a timeout kills what the shell started too.
      detached: true,
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    }, timeoutMs)

    const fail = (what: string) => {
      const tail = output.trimEnd().split('\n').slice(-OUTPUT_LINES).join('\n')
      reject(
        new Error(
          redactPassword(`Migrations failed (${what}): ${options.command}\n${tail}`, databaseUrl),
        ),
      )
    }
    child.on('error', (err) => {
      clearTimeout(timer)
      output += `${err.message}\n`
      fail('could not start')
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) return fail(`timed out after ${timeoutMs}ms`)
      if (code === 0) return resolve()
      fail(code === null ? `killed by ${signal}` : `exit code ${code}`)
    })
  })
}
