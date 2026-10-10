import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'

type HookFn = (this: unknown) => unknown
interface Hook {
  options: { tags?: string; timeout?: number }
  fn: HookFn
}

// Capture the hooks registerServiceUnderTest registers, so the test can run them.
const hooks = vi.hoisted(() => ({
  beforeAll: [] as Hook[],
  afterAll: [] as Hook[],
  before: [] as Hook[],
  after: [] as Hook[],
}))

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (into: Hook[]) => (options: Hook['options'], fn: HookFn) =>
    into.push({ options, fn })
  return {
    ...actual,
    BeforeAll: register(hooks.beforeAll),
    AfterAll: register(hooks.afterAll),
    Before: register(hooks.before),
    After: register(hooks.after),
  }
})

import {
  registerServiceUnderTest,
  spawnServiceUnderTest,
  startService,
  stopServices,
  type ServiceOptions,
} from './process'

const FAKE_SERVICE = path.join(__dirname, '__fixtures__', 'fake-service.cjs')

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

const marker = async (port: number) => (await fetch(`http://127.0.0.1:${port}/health`)).text()

const exited = (child: { exitCode: number | null; signalCode: string | null } | null) =>
  child !== null && (child.exitCode !== null || child.signalCode !== null)

describe('service lifecycle (COMPONENT-8)', () => {
  let dir: string
  let port: number
  let started: { stop: () => Promise<void> }[]

  /** Options for the fake service on a fresh port, logging to a temp file. */
  const options = (extra: Partial<ServiceOptions> = {}): ServiceOptions => ({
    name: 'fake',
    cwd: dir,
    cmd: process.execPath,
    args: [FAKE_SERVICE],
    env: { ...process.env, PORT: String(port), MARKER: 'first' },
    logFile: path.join(dir, 'service.log'),
    readyCheck: { url: `http://127.0.0.1:${port}/health` },
    healthTimeoutMs: 10_000,
    ...extra,
  })

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-process-'))
    port = await freePort()
    started = []
  })

  afterEach(async () => {
    await stopServices(...started)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe('spawnServiceUnderTest', () => {
    it('starts, becomes ready and stops, as before', async () => {
      const service = spawnServiceUnderTest(options())
      started.push(service)
      await service.ready
      expect(await marker(port)).toBe('first')

      await service.stop()
      expect(exited(service.process)).toBe(true)
      expect(fs.readFileSync(path.join(dir, 'service.log'), 'utf8')).toContain('started first')
    })

    it('runs a prebuilt binary when its environment variable is set', async () => {
      vi.stubEnv('FAKE_BIN', process.execPath)
      try {
        const service = spawnServiceUnderTest(
          options({
            cmd: 'no-such-command',
            args: [],
            binaryEnvVar: 'FAKE_BIN',
            binaryArgs: [FAKE_SERVICE],
          }),
        )
        started.push(service)
        await service.ready
        expect(await marker(port)).toBe('first')
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it('restarts with changed environment, keeping one log', async () => {
      const service = spawnServiceUnderTest(options())
      started.push(service)
      await service.ready
      const first = service.process

      await service.restart({ MARKER: 'locked' })
      expect(await marker(port)).toBe('locked')
      expect(service.process).not.toBe(first)
      expect(exited(first)).toBe(true)

      await service.stop()
      const log = fs.readFileSync(path.join(dir, 'service.log'), 'utf8')
      expect(log).toContain('started first')
      expect(log).toContain('started locked')
    })

    it('appends to an existing log when asked', async () => {
      fs.writeFileSync(path.join(dir, 'service.log'), 'earlier run\n')
      const service = spawnServiceUnderTest(options({ appendLog: true }))
      started.push(service)
      await service.ready
      await service.stop()
      expect(fs.readFileSync(path.join(dir, 'service.log'), 'utf8')).toMatch(
        /^earlier run\nstarted first/,
      )
    })

    it('waits the stop grace, then kills a service that ignores SIGINT', async () => {
      const service = spawnServiceUnderTest(
        options({
          stopGraceMs: 600,
          env: { ...process.env, PORT: String(port), STOP_DELAY_MS: 'ignore' },
        }),
      )
      started.push(service)
      await service.ready

      const begun = Date.now()
      await service.stop()
      const took = Date.now() - begun
      expect(took).toBeGreaterThanOrEqual(550)
      expect(took).toBeLessThan(3_000)
      expect(service.process.signalCode).toBe('SIGKILL')
    })

    it('waits for a slow but graceful shutdown within the grace', async () => {
      const service = spawnServiceUnderTest(
        options({
          stopGraceMs: 5_000,
          env: { ...process.env, PORT: String(port), STOP_DELAY_MS: '400' },
        }),
      )
      started.push(service)
      await service.ready
      await service.stop()
      expect(service.process.exitCode).toBe(0)
    })

    it('reports a service that dies on its own, but not one that was stopped', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const crashing = spawnServiceUnderTest(
          options({ env: { ...process.env, PORT: String(port), CRASH_AFTER_MS: '300' } }),
        )
        started.push(crashing)
        await crashing.ready
        await new Promise((resolve) => setTimeout(resolve, 600))
        expect(errors).toHaveBeenCalledWith('[fake] exited unexpectedly with code 3')

        errors.mockClear()
        port = await freePort()
        const stopped = spawnServiceUnderTest(options())
        await stopped.ready
        await stopped.restart()
        await stopped.stop()
        expect(errors).not.toHaveBeenCalled()
      } finally {
        errors.mockRestore()
      }
    })
  })

  describe('startService', () => {
    it('runs beforeStart before every start, restarts included', async () => {
      const order: string[] = []
      const service = await startService(
        options({
          beforeStart: async () => {
            order.push(
              `beforeStart (service up: ${await marker(port).then(
                () => true,
                () => false,
              )})`,
            )
          },
        }),
      )
      started.push(service)
      order.push('ready')
      await service.restart()
      expect(order).toEqual([
        'beforeStart (service up: false)',
        'ready',
        'beforeStart (service up: false)',
      ])
    })

    it('does nothing when the skip variable is set', async () => {
      vi.stubEnv('SKIP_FAKE', '1')
      try {
        const beforeStart = vi.fn()
        const service = await startService(options({ skipEnvVar: 'SKIP_FAKE', beforeStart }))
        expect(service).toMatchObject({ skipped: true, process: null })
        expect(beforeStart).not.toHaveBeenCalled()
        await service.restart({ MARKER: 'x' })
        await service.stop()
        await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it('fails clearly when the service never becomes ready', async () => {
      await expect(
        startService(
          options({ readyCheck: { probe: async () => false }, healthTimeoutMs: 300 }),
        ).then((s) => {
          started.push(s)
        }),
      ).rejects.toThrow('fake did not become ready within 300ms')
    })
  })

  it('stops several services at once rather than in turn', async () => {
    const slow = { ...process.env, STOP_DELAY_MS: '700' }
    const a = spawnServiceUnderTest(options({ env: { ...slow, PORT: String(port) } }))
    const portB = await freePort()
    const b = spawnServiceUnderTest(
      options({
        env: { ...slow, PORT: String(portB) },
        readyCheck: { url: `http://127.0.0.1:${portB}/health` },
      }),
    )
    started.push(a, b)
    await Promise.all([a.ready, b.ready])

    const begun = Date.now()
    await stopServices(a, b, null)
    expect(Date.now() - begun).toBeLessThan(1_300)
  })

  describe('registerServiceUnderTest', () => {
    beforeEach(() => {
      for (const list of Object.values(hooks)) list.length = 0
    })

    it('starts before the suite, stops after it, and restarts for a tag', async () => {
      const api = registerServiceUnderTest(options({ stopGraceMs: 2_000 }))
      api.restartForTag('@locked', { MARKER: 'locked' })
      expect(() => api.handle).toThrow('[fake] has not been started yet')

      await hooks.beforeAll[0].fn.call({})
      started.push(api.handle)
      expect(await marker(port)).toBe('first')

      expect(hooks.before[0].options).toMatchObject({ tags: '@locked' })
      expect(await hooks.before[0].fn.call({})).toBeUndefined()
      expect(await marker(port)).toBe('locked')
      await hooks.after[0].fn.call({})
      expect(await marker(port)).toBe('first')

      await hooks.afterAll[0].fn.call({})
      expect(exited(api.handle.process)).toBe(true)
      expect(hooks.afterAll[0].options.timeout).toBe(12_000)
    })

    it('skips tagged scenarios when the service is skipped', async () => {
      vi.stubEnv('SKIP_FAKE', '1')
      try {
        const api = registerServiceUnderTest(options({ skipEnvVar: 'SKIP_FAKE' }))
        api.restartForTag('@locked', { MARKER: 'locked' })
        await hooks.beforeAll[0].fn.call({})
        expect(await hooks.before[0].fn.call({})).toBe('skipped')
        await hooks.after[0].fn.call({})
      } finally {
        vi.unstubAllEnvs()
      }
    })
  })
})
