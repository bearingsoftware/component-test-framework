import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadWorkerFiles, withLock, writeFileAtomic } from './coverage-files'

const WRITERS = 4
const ROUNDS = 40
const PAYLOAD_SIZE = 2_000_000
const FILES = path.join(__dirname, 'coverage-files.ts')

// COVERAGE_PLAIN_WRITE swaps in a plain writeFileSync, the old behaviour.
const WRITER_SCRIPT = `
  const fs = require('fs')
  const path = require('path')
  const { writeFileAtomic } = require(process.argv[1])
  const [, , dir, id, size, rounds] = process.argv
  const file = path.join(dir, 'worker-run-' + id + '.json')
  const data = JSON.stringify({ blob: 'x'.repeat(Number(size)) })
  const write = process.env.COVERAGE_PLAIN_WRITE ? (f, d) => fs.writeFileSync(f, d) : writeFileAtomic
  for (let i = 0; i < Number(rounds); i++) write(file, data)
`

function runWriter(dir: string, id: number, plain: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    if (plain) env.COVERAGE_PLAIN_WRITE = '1'
    const child = spawn(
      process.execPath,
      ['-e', WRITER_SCRIPT, FILES, dir, String(id), String(PAYLOAD_SIZE), String(ROUNDS)],
      { stdio: ['ignore', 'inherit', 'inherit'], env },
    )
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`writer ${id} exited ${code}`)),
    )
  })
}

/** Poll the directory while the writers run; return how many reads saw a partial file. */
async function partialReads(dir: string, plain: boolean): Promise<number> {
  const state = { done: false }
  const writers = Promise.all(
    Array.from({ length: WRITERS }, (_, id) => runWriter(dir, id, plain)),
  ).finally(() => {
    state.done = true
  })
  let partial = 0
  while (!state.done) {
    for (let id = 0; id < WRITERS; id++) {
      let text: string
      try {
        text = fs.readFileSync(path.join(dir, `worker-run-${id}.json`), 'utf-8')
      } catch {
        continue
      }
      try {
        JSON.parse(text)
      } catch {
        partial++
      }
    }
    await new Promise((r) => setImmediate(r))
  }
  await writers
  return partial
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cov-files-'))
}

describe('writeFileAtomic', () => {
  it('never exposes a partial file to a concurrent reader', async () => {
    const dir = tmpDir()
    try {
      expect(await partialReads(dir, false)).toBe(0)
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('the stress test does see partial files with a plain writeFileSync', async () => {
    const dir = tmpDir()
    try {
      expect(await partialReads(dir, true)).toBeGreaterThan(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('leaves the old content and no temp file when the write fails', () => {
    const dir = tmpDir()
    try {
      const file = path.join(dir, 'out.json')
      writeFileAtomic(file, 'old')
      fs.mkdirSync(path.join(dir, 'blocked'))
      expect(() => writeFileAtomic(path.join(dir, 'blocked'), 'new')).toThrow()
      expect(fs.readFileSync(file, 'utf-8')).toBe('old')
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('loadWorkerFiles', () => {
  it('skips temp files and deletes files from other runs', () => {
    const dir = tmpDir()
    try {
      fs.writeFileSync(path.join(dir, 'worker-old-0.json'), '{"n":0}')
      fs.writeFileSync(path.join(dir, 'worker-new-1.json'), '{"n":1}')
      fs.writeFileSync(path.join(dir, '.worker-new-2.json.1.abc.tmp'), '{ not json')
      expect(loadWorkerFiles(dir, 'new')).toEqual([{ n: 1 }])
      expect(fs.readdirSync(dir).sort()).toEqual([
        '.worker-new-2.json.1.abc.tmp',
        'worker-new-1.json',
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('withLock', () => {
  it('releases on return and on throw', () => {
    const dir = tmpDir()
    try {
      const lock = path.join(dir, '.lock')
      expect(
        withLock(lock, () => {
          expect(fs.existsSync(lock)).toBe(true)
          return 7
        }),
      ).toBe(7)
      expect(fs.existsSync(lock)).toBe(false)
      expect(() =>
        withLock(lock, () => {
          throw new Error('boom')
        }),
      ).toThrow('boom')
      expect(fs.existsSync(lock)).toBe(false)
      fs.mkdirSync(lock)
      expect(() => withLock(lock, () => 1, 100, 60_000)).toThrow(/Timed out/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not remove a lock a stale-breaker has since re-taken', () => {
    const dir = tmpDir()
    try {
      const lock = path.join(dir, '.lock')
      withLock(lock, () => {
        fs.rmSync(lock, { recursive: true, force: true })
        fs.mkdirSync(lock)
        fs.writeFileSync(path.join(lock, 'owner'), 'someone-else')
      })
      expect(fs.readFileSync(path.join(lock, 'owner'), 'utf-8')).toBe('someone-else')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('waits longer than its deadline before treating a lock as stale', () => {
    const dir = tmpDir()
    try {
      const lock = path.join(dir, '.lock')
      fs.mkdirSync(lock)
      const old = new Date(Date.now() - 40_000)
      fs.utimesSync(lock, old, old)
      expect(() => withLock(lock, () => 1, 100)).toThrow(/Timed out/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
