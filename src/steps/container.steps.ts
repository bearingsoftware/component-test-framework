import { When } from '@cucumber/cucumber'
import { restartContainer, startContainer, stopContainer } from '../container'

let registered = false

/**
 * Register the container steps:
 *
 * - `the {string} container is restarted`
 * - `the {string} container is stopped`
 * - `the {string} container is started`
 *
 * They use the docker CLI and wait for no readiness; call `restartContainer`
 * or `startContainer` from your own step to wait for one. Calling this twice
 * registers nothing more.
 */
export function registerContainerSteps(): void {
  if (registered) return
  registered = true

  When('the {string} container is restarted', { timeout: 120_000 }, async function (name: string) {
    await restartContainer(name)
  })

  When('the {string} container is stopped', { timeout: 120_000 }, async function (name: string) {
    await stopContainer(name)
  })

  When('the {string} container is started', { timeout: 120_000 }, async function (name: string) {
    await startContainer(name)
  })
}
