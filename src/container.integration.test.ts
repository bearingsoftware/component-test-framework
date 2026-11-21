// Live: starts a busybox container named ctf39-*. Runs only when `docker info` succeeds.
import { spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { restartContainer, startContainer, stopContainer } from './container'

const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
const NAME = `ctf39-it-${process.pid}`
const PORT = 57440

describe.skipIf(!dockerUp)('container control against Docker', () => {
  afterAll(() => {
    spawnSync('docker', ['rm', '--force', NAME], { stdio: 'ignore' })
  })

  it('stops, starts and restarts a container, waiting on a TCP port', async () => {
    const run = spawnSync(
      'docker',
      [
        'run',
        '--detach',
        '--name',
        NAME,
        '--publish',
        `127.0.0.1:${PORT}:${PORT}`,
        'busybox',
        'sh',
        '-c',
        `while true; do nc -l -p ${PORT} >/dev/null 2>&1; done`,
      ],
      { encoding: 'utf8' },
    )
    expect(run.status, run.stderr).toBe(0)
    const readiness = { tcp: { host: '127.0.0.1', port: PORT }, timeoutMs: 60_000 }

    await stopContainer(NAME)
    await startContainer(NAME, { readiness })
    await restartContainer(NAME, { readiness })

    const state = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', NAME], {
      encoding: 'utf8',
    })
    expect(state.stdout.trim()).toBe('true')
  }, 120_000)
})
