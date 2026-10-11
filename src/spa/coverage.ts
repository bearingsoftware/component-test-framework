/* eslint-disable @typescript-eslint/no-require-imports */
import * as fs from 'fs'
import * as path from 'path'
import { AfterAll } from '@cucumber/cucumber'
import type { Page } from '@playwright/test'
import type { CoverageMapData } from 'istanbul-lib-coverage'

/** Options for {@link createCoverageCollector}. */
export interface CoverageCollectorOptions {
  /** Where the reports go, e.g. `<suite>/coverage`. Raw data goes to `{outDir}/../.nyc_output/out.json`. */
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
  const { createCoverageMap } =
    require('istanbul-lib-coverage') as typeof import('istanbul-lib-coverage')
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

  function write(): void {
    if (counts.collected === 0) {
      if (options.onNothingCollected === 'throw') {
        throw new Error(
          `[coverage] No coverage was collected from any page (${counts.missed} missed). ` +
            'Refusing to report a silent 0%: is the SPA built with coverage instrumentation?',
        )
      }
      return
    }
    const { createContext } = require('istanbul-lib-report') as typeof import('istanbul-lib-report')
    const { create } = require('istanbul-reports') as typeof import('istanbul-reports')

    fs.mkdirSync(options.outDir, { recursive: true })
    // .nyc_output for tooling that expects it; the reports are what gates read.
    const nycOutput = path.join(options.outDir, '..', '.nyc_output')
    fs.mkdirSync(nycOutput, { recursive: true })
    fs.writeFileSync(path.join(nycOutput, 'out.json'), JSON.stringify(map.toJSON()))

    const context = createContext({ dir: options.outDir, coverageMap: map })
    for (const reporter of options.reporters ?? DEFAULT_REPORTERS) {
      create(reporter as Parameters<typeof create>[0]).execute(context)
    }
  }

  return { collect, write, counts }
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
