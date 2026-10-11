import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Page } from '@playwright/test'
import { createCoverageCollector } from './coverage'

/** istanbul coverage for one file with two statements, the first run `hits` times. */
const fileCoverage = (hits: number) => ({
  '/src/app.ts': {
    path: '/src/app.ts',
    statementMap: {
      '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
      '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
    },
    fnMap: {},
    branchMap: {},
    s: { '0': hits, '1': 0 },
    f: {},
    b: {},
  },
})

/** A stand-in for a Playwright page: its URL, whether it loads, and what __coverage__ holds. */
function fakePage(options: { url?: string; loads?: boolean; coverage?: unknown }): Page {
  return {
    url: () => options.url ?? 'http://localhost:3100/dashboard',
    waitForLoadState: vi.fn(async () => {
      if (options.loads === false) throw new Error('timeout')
    }),
    waitForFunction: vi.fn(async () => {
      if (options.coverage === undefined) throw new Error('timeout')
      return { jsonValue: async () => options.coverage }
    }),
  } as unknown as Page
}

describe('coverage collector (COMPONENT-10)', () => {
  let dir: string
  let outDir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-coverage-'))
    outDir = path.join(dir, 'coverage')
  })

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('merges coverage across pages and writes the reports gates read', async () => {
    // Without text-summary, which prints to stdout.
    const collector = createCoverageCollector({
      outDir,
      reporters: ['lcovonly', 'html', 'json-summary'],
    })
    await collector.collect(fakePage({ coverage: fileCoverage(1) }))
    await collector.collect(fakePage({ coverage: fileCoverage(2) }))
    collector.write()

    expect(collector.counts).toEqual({ collected: 2, missed: 0 })
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'coverage-summary.json'), 'utf8'))
    expect(summary.total.statements).toMatchObject({ total: 2, covered: 1, pct: 50 })
    // Paths are left as istanbul writes them; downstream scripts rewrite them.
    expect(fs.readFileSync(path.join(outDir, 'lcov.info'), 'utf8')).toMatch(/^SF:.*src\/app\.ts$/m)
    expect(fs.existsSync(path.join(outDir, 'index.html'))).toBe(true)
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.nyc_output', 'out.json'), 'utf8'))
    expect(raw['/src/app.ts'].s['0']).toBe(3)
  })

  it('skips a page that never opened the app', async () => {
    const collector = createCoverageCollector({ outDir })
    await collector.collect(fakePage({ url: 'about:blank' }))
    expect(collector.counts).toEqual({ collected: 0, missed: 0 })
  })

  it('fails a page with no coverage by default, saying what it saw', async () => {
    const collector = createCoverageCollector({ outDir, loadTimeoutMs: 10, evalTimeoutMs: 10 })
    await expect(collector.collect(fakePage({}))).rejects.toThrow(
      /window.__coverage__ never appeared at http:\/\/localhost:3100\/dashboard\. .*points at the build.*Refusing to report a silent 0%/,
    )
    await expect(collector.collect(fakePage({ loads: false }))).rejects.toThrow(
      /never finished loading within 10 ms/,
    )
  })

  it('can warn about a page with no coverage and carry on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const collector = createCoverageCollector({
      outDir,
      onMissingSample: 'warn',
      evalTimeoutMs: 10,
    })
    await collector.collect(fakePage({}))
    expect(collector.counts).toEqual({ collected: 0, missed: 1 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('never appeared'))
    warn.mockRestore()
  })

  it('writes nothing when nothing was collected, or refuses to if asked', () => {
    createCoverageCollector({ outDir }).write()
    expect(fs.existsSync(outDir)).toBe(false)
    expect(() => createCoverageCollector({ outDir, onNothingCollected: 'throw' }).write()).toThrow(
      /No coverage was collected from any page.*silent 0%/,
    )
  })
})

describe('coverage under --parallel (COMPONENT-11)', () => {
  let dir: string
  let outDir: string
  const reporters = ['json-summary']
  const asWorker = (id: number) =>
    Object.assign(process.env, {
      CUCUMBER_PARALLEL: 'true',
      CUCUMBER_WORKER_ID: String(id),
      CUCUMBER_TOTAL_WORKERS: '2',
    })
  const summary = () =>
    JSON.parse(fs.readFileSync(path.join(outDir, 'coverage-summary.json'), 'utf-8')).total
      .statements
  const runFiles = () =>
    fs.readdirSync(path.join(dir, '.nyc_output', '.workers')).filter((f) => f.startsWith('worker-'))

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-coverage-'))
    outDir = path.join(dir, 'coverage')
  })

  afterEach(() => {
    delete process.env.CUCUMBER_PARALLEL
    delete process.env.CUCUMBER_WORKER_ID
    delete process.env.CUCUMBER_TOTAL_WORKERS
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("merges every worker's coverage into one report, and drops an earlier run's files", async () => {
    fs.mkdirSync(path.join(dir, '.nyc_output', '.workers'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.nyc_output', '.workers', 'worker-1-0.json'), '{}')

    // Worker 0 covers the first statement, worker 1 the same file with the
    // second statement too.
    const second = fileCoverage(0)
    second['/src/app.ts'].s = { '0': 0, '1': 4 }

    asWorker(0)
    const first = createCoverageCollector({ outDir, reporters })
    await first.collect(fakePage({ coverage: fileCoverage(2) }))
    first.write()
    expect(summary()).toMatchObject({ covered: 1, total: 2 })

    asWorker(1)
    const other = createCoverageCollector({ outDir, reporters })
    await other.collect(fakePage({ coverage: second }))
    other.write()
    expect(summary()).toMatchObject({ covered: 2, total: 2 })

    const merged = JSON.parse(fs.readFileSync(path.join(dir, '.nyc_output', 'out.json'), 'utf-8'))
    expect(merged['/src/app.ts'].s).toEqual({ '0': 2, '1': 4 })
    expect(runFiles().sort()).toEqual([
      `worker-${process.ppid}-0.json`,
      `worker-${process.ppid}-1.json`,
    ])
  })

  it('refuses a silent 0% only once every worker has reported nothing', () => {
    asWorker(0)
    createCoverageCollector({ outDir, reporters, onNothingCollected: 'throw' }).write()
    asWorker(1)
    expect(() =>
      createCoverageCollector({ outDir, reporters, onNothingCollected: 'throw' }).write(),
    ).toThrow(/No coverage was collected from any page/)
  })

  it("doesn't fail a run where only some workers had @ui scenarios", async () => {
    asWorker(0)
    createCoverageCollector({ outDir, reporters, onNothingCollected: 'throw' }).write()
    asWorker(1)
    const withUi = createCoverageCollector({ outDir, reporters, onNothingCollected: 'throw' })
    await withUi.collect(fakePage({ coverage: fileCoverage(1) }))
    expect(() => withUi.write()).not.toThrow()
    expect(summary()).toMatchObject({ covered: 1 })
  })
})

describe('coverage from a runner other than Cucumber (COMPONENT-17)', () => {
  let dir: string
  let outDir: string
  const reporters = ['json-summary']

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-coverage-'))
    outDir = path.join(dir, 'coverage')
  })

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("merges the workers named by run, and drops another run's files", async () => {
    const workers = path.join(dir, '.nyc_output', '.workers')
    fs.mkdirSync(workers, { recursive: true })
    fs.writeFileSync(path.join(workers, 'worker-old.run-0.json'), '{}')

    const second = fileCoverage(0)
    second['/src/app.ts'].s = { '0': 0, '1': 3 }
    const first = createCoverageCollector({ outDir, reporters })
    await first.collect(fakePage({ coverage: fileCoverage(1) }))
    first.write({ key: 'run.1', worker: 0, workers: 2 })
    const other = createCoverageCollector({ outDir, reporters })
    await other.collect(fakePage({ coverage: second }))
    other.write({ key: 'run.1', worker: 7, workers: 2 })

    const merged = JSON.parse(fs.readFileSync(path.join(dir, '.nyc_output', 'out.json'), 'utf-8'))
    expect(merged['/src/app.ts'].s).toEqual({ '0': 1, '1': 3 })
    expect(fs.readdirSync(workers).sort()).toEqual(['worker-run.1-0.json', 'worker-run.1-7.json'])
  })

  it('refuses a run key that would make a bad file name', () => {
    const collector = createCoverageCollector({ outDir, reporters })
    expect(() => collector.write({ key: '../x', worker: 0, workers: 1 })).toThrow(/run key/)
  })
})
