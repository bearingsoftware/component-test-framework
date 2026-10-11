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
    const collector = createCoverageCollector({ outDir })
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
