import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'

const WORKER_FILE = /^worker-([\w.]+)-\d+\.json$/

/** Write `data` so readers see the old file or the whole new one, never half: a temp file in the same directory, then a rename. */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  )
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/** Files of `key`'s run parsed; files from other runs are deleted. Temp files never match. */
export function loadWorkerFiles<T>(dir: string, key: string): T[] {
  const saves: T[] = []
  for (const file of fs.readdirSync(dir)) {
    const match = WORKER_FILE.exec(file)
    if (!match) continue
    if (match[1] !== key) {
      fs.rmSync(path.join(dir, file), { force: true })
      continue
    }
    saves.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as T)
  }
  return saves
}

/**
 * Run `fn` holding a lock directory, so only one worker writes the reports at
 * a time. A lock older than `staleMs` belongs to a dead worker; `staleMs` must
 * exceed `deadlineMs`, or a live waiter would break a live holder's lock.
 */
export function withLock<T>(lock: string, fn: () => T, deadlineMs = 30_000, staleMs = 60_000): T {
  const deadline = Date.now() + deadlineMs
  const pause = new Int32Array(new SharedArrayBuffer(4))
  const token = randomBytes(8).toString('hex')
  for (;;) {
    try {
      fs.mkdirSync(lock)
      fs.writeFileSync(path.join(lock, 'owner'), token)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
      if (age > staleMs) fs.rmSync(lock, { recursive: true, force: true })
      else if (Date.now() > deadline) throw new Error(`[coverage] Timed out waiting for ${lock}`)
      else Atomics.wait(pause, 0, 0, 50)
    }
  }
  try {
    return fn()
  } finally {
    // A stale-breaker may have taken the lock since; it is theirs to remove.
    let owner: string | undefined
    try {
      owner = fs.readFileSync(path.join(lock, 'owner'), 'utf-8')
    } catch {
      owner = undefined
    }
    if (owner === token) fs.rmSync(lock, { recursive: true, force: true })
  }
}
