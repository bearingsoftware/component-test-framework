import * as fs from 'fs'
import * as path from 'path'
import { AfterAll } from '@cucumber/cucumber'
import type { Page } from '@playwright/test'
import type { CoverageMap, CoverageMapData } from 'istanbul-lib-coverage'
import { isMainThread } from 'worker_threads'
import { requireOptional } from './optional'
import { currentWorker } from '../support/worker'

/** Options for {@link createCoverageCollector}. */
export interface CoverageCollectorOptions {
  /**
   * Where the reports go, e.g. `<suite>/coverage`. Raw data goes to
   * `{outDir}/../.nyc_output/out.json`. Under `--parallel`, each worker also
   * saves its own coverage there, and the reports merge every worker's.
   */
  outDir: string
  /** istanbul reporters. Default lcovonly, html, json-summary and text-summary. */
  reporters?: string[]
  /** How long to wait for the document to load before reading coverage, in ms. Default 6000. */
  loadTimeoutMs?: number
  /** How long to wait, after that, for the instrumented bundle to run, in ms. Default 6000. */
  evalTimeoutMs?: number
  /**
   * A page with an app loaded but no `window.__coverage__`: `throw` (default)
   * fails the scenario; `warn` logs it, counts it, and carries on.
   */
  onMissingSample?: 'throw' | 'warn'
  /**
   * No coverage collected by the end of the run: `skip` (default) writes
   * nothing; `throw` fails, so a broken setup can't report a silent 0%.
   */
  onNothingCollected?: 'skip' | 'throw'
}

/** Collects browser-side istanbul coverage across a run. */
export interface CoverageCollector {
  /** Read `window.__coverage__` from the page and merge it in. Call before the page closes. */
  collect: (page: Page) => Promise<void>
  /** Write the reports. Call once, after the run. */
  write: () => void
  /** Pages coverage was read from, and pages where it was missing (with `onMissingSample: 'warn'`). */
  readonly counts: { collected: number; missed: number }
}

const DEFAULT_REPORTERS = ['lcovonly', 'html', 'json-summary', 'text-summary']

/**
 * Collect coverage from an SPA built with istanbul instrumentation (for
 * example vite-plugin-istanbul), which exposes `window.__coverage__`.
 * Wire `collect` to `hooks.beforePageClose` and `write` to an AfterAll, or
 * use {@link registerCoverage}, which does both.
 *
 * Needs `istanbul-lib-coverage`, `istanbul-lib-report` and `istanbul-reports`,
 * loaded when the collector is created.
 */
export function createCoverageCollector(options: CoverageCollectorOptions): CoverageCollector {
  const { createCoverageMap } = requireOptional<typeof import('istanbul-lib-coverage')>(
    'istanbul-lib-coverage',
    'Coverage collection',
  )
  const map = createCoverageMap({})
  const counts = { collected: 0, missed: 0 }
  const loadTimeout = options.loadTimeoutMs ?? 6_000
  const evalTimeout = options.evalTimeoutMs ?? 6_000

  async function collect(page: Page): Promise<void> {
    const url = page.url()
    // A scenario that never opened the app has no coverage to give.
    if (!url || url === 'about:blank') return

    // Two budgets, because they fail for different reasons and the error
    // should say which: loading the document, then running the bundle. A
    // reload just before the page closes otherwise leaves a document whose
    // bundle hasn't run yet (JG-716).
    const started = Date.now()
    let loaded = true
    await page.waitForLoadState('load', { timeout: loadTimeout }).catch(() => {
      loaded = false
    })
    const loadMs = Date.now() - started

    const coverage = (await page
      .waitForFunction(
        () => (globalThis as unknown as { __coverage__?: unknown }).__coverage__,
        undefined,
        {
          timeout: evalTimeout,
        },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => undefined)) as CoverageMapData | undefined

    if (!coverage) {
      // Let what was observed point at the likely cause, rather than
      // asserting one.
      const likely = !loaded
        ? `the document never finished loading within ${loadTimeout} ms: a stalled page, a very slow host, or one closed under the hook`
        : loadMs < 1_000
          ? `the document loaded in ${loadMs} ms yet no instrumented module ran, which points at the build: check the bundle contains '__coverage__'`
          : `the document took ${loadMs} ms to load, so the host was slow rather than the build being wrong`
      const message =
        `[coverage] window.__coverage__ never appeared at ${url}. Waited ${Date.now() - started} ms: ` +
        `document load ${loaded ? `reached in ${loadMs} ms` : `NOT reached in ${loadTimeout} ms`}, ` +
        `then ${evalTimeout} ms for the instrumented bundle to run. On this evidence, ${likely}.`
      if (options.onMissingSample === 'warn') {
        counts.missed++
        console.warn(message)
        return
      }
      throw new Error(`${message} Refusing to report a silent 0%.`)
    }
    map.merge(coverage)
    counts.collected++
  }

  function nothingCollected(missed: number): void {
    if (options.onNothingCollected === 'throw') {
      throw new Error(
        `[coverage] No coverage was collected from any page (${missed} missed). ` +
          'Refusing to report a silent 0%: is the SPA built with coverage instrumentation?',
      )
    }
  }

  function report(merged: CoverageMap): void {
    const { createContext } = requireOptional<typeof import('istanbul-lib-report')>(
      'istanbul-lib-report',
      'The coverage report',
    )
    const { create } = requireOptional<typeof import('istanbul-reports')>(
      'istanbul-reports',
      'The coverage report',
    )

    fs.mkdirSync(options.outDir, { recursive: true })
    // .nyc_output for tooling that expects it; the reports are what gates read.
    fs.writeFileSync(path.join(nycOutput, 'out.json'), JSON.stringify(merged.toJSON()))

    const context = createContext({ dir: options.outDir, coverageMap: merged })
    for (const reporter of options.reporters ?? DEFAULT_REPORTERS) {
      create(reporter as Parameters<typeof create>[0]).execute(context)
    }
  }

  const nycOutput = path.join(options.outDir, '..', '.nyc_output')

  function write(): void {
    const worker = currentWorker()
    if (!worker.parallel) {
      if (counts.collected === 0) return nothingCollected(counts.missed)
      fs.mkdirSync(nycOutput, { recursive: true })
      return report(map)
    }

    // Under --parallel each worker has only its own scenarios' coverage. It
    // saves that to a file of its own, then, holding a lock, merges every
    // worker's file from this run and rewrites the reports. Whichever
    // worker finishes last writes the report with everyone's coverage. The
    // workers' files go in a folder of their own: nyc reads every .json
    // directly in .nyc_output as raw coverage, which these aren't.
    const workers = path.join(nycOutput, '.workers')
    fs.mkdirSync(workers, { recursive: true })
    const run = runKey()
    const mine: WorkerCoverage = { counts, coverage: map.toJSON() }
    fs.writeFileSync(path.join(workers, `worker-${run}-${worker.id}.json`), JSON.stringify(mine))
    withLock(path.join(workers, '.lock'), () => {
      const merged = createCoverageMap({})
      const totals = { collected: 0, missed: 0 }
      let reported = 0
      for (const file of fs.readdirSync(workers)) {
        const match = /^worker-(\d+)-\d+\.json$/.exec(file)
        if (!match) continue
        if (match[1] !== run) {
          // Left by an earlier run.
          fs.rmSync(path.join(workers, file), { force: true })
          continue
        }
        const saved = JSON.parse(
          fs.readFileSync(path.join(workers, file), 'utf-8'),
        ) as WorkerCoverage
        merged.merge(saved.coverage)
        totals.collected += saved.counts.collected
        totals.missed += saved.counts.missed
        reported++
      }
      if (totals.collected > 0) report(merged)
      // Only once every worker has reported can the run have collected nothing.
      else if (reported >= worker.total) nothingCollected(totals.missed)
    })
  }

  return { collect, write, counts }
}

/** What each worker saves under --parallel. */
interface WorkerCoverage {
  counts: { collected: number; missed: number }
  coverage: CoverageMapData
}

/**
 * Identifies the run, so files a previous run left behind are told apart:
 * the coordinator's pid. Cucumber 13's workers are threads of the
 * coordinator; earlier versions' are its child processes.
 */
function runKey(): string {
  return String(isMainThread ? process.ppid : process.pid)
}

/** Run `fn` holding a lock directory, so only one worker writes the reports at a time. */
function withLock(lock: string, fn: () => void): void {
  const deadline = Date.now() + 30_000
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // A lock older than the deadline was left by a worker that died holding it.
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
      if (age > 30_000) fs.rmSync(lock, { recursive: true, force: true })
      else if (Date.now() > deadline) throw new Error(`[coverage] Timed out waiting for ${lock}`)
      else Atomics.wait(pause, 0, 0, 50)
    }
  }
  try {
    fn()
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

/**
 * Create a coverage collector and write its reports after the run. Pass the
 * returned `collect` to `registerHooks` as `hooks.beforePageClose`.
 *
 * @example
 * const coverage = registerCoverage({ outDir: path.resolve(__dirname, '..', 'coverage') })
 * registerHooks({ ...options, hooks: { beforePageClose: (world) => coverage.collect(world.page!) } })
 */
export function registerCoverage(options: CoverageCollectorOptions): CoverageCollector {
  const collector = createCoverageCollector(options)
  AfterAll({ timeout: 15_000 }, function () {
    collector.write()
  })
  return collector
}
