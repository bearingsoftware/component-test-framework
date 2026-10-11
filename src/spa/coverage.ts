import { AfterAll } from '@cucumber/cucumber'
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
  const collector = createCoverageCollector(options)
  AfterAll({ timeout: 15_000 }, function () {
    collector.write()
  })
  return collector
}
