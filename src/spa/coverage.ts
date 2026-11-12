import { defineAdapter, registerAdapter } from '../support/adapter'
import type { Adapter } from '../support/adapter'
import {
  createCoverageCollector,
  type CoverageCollector,
  type CoverageCollectorOptions,
  type CoverageRun,
} from './coverage-collector'

export { createCoverageCollector }
export type { CoverageCollector, CoverageCollectorOptions, CoverageRun }

/**
 * Create a coverage collector and write its reports after the run. Pass the
 * returned `collect` to `registerHooks` as `hooks.beforePageClose`.
 *
 * @example
 * const coverage = registerCoverage({ outDir: path.resolve(__dirname, '..', 'coverage') })
 * registerHooks({ ...options, hooks: { beforePageClose: (world) => coverage.collect(world.page!) } })
 */
export function registerCoverage(options: CoverageCollectorOptions): CoverageCollector {
  return registerAdapter(coverageAdapter(options))
}

/** {@link registerCoverage} as an adapter. State is the collector. */
export function coverageAdapter(options: CoverageCollectorOptions): Adapter<CoverageCollector> {
  return defineAdapter<CoverageCollector>({
    name: `coverage:${options.outDir}`,
    setup: () => createCoverageCollector(options),
    afterAll: (_ctx, collector) => collector.write(),
    afterAllTimeout: 15_000,
  })
}
