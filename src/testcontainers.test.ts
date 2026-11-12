import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const imports = vi.hoisted(() => ({ core: 0, pg: 0, redis: 0 }))
const stops = vi.hoisted(() => ({ fn: vi.fn() }))
const failImports = vi.hoisted(() => ({ on: false }))
const calls = vi.hoisted(() => ({ reuse: [] as string[], generic: [] as unknown[] }))
const spawn = vi.hoisted(() => ({ fn: vi.fn() }))

function notFound(): never {
  throw Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' })
}

function container(extra: object) {
  return { stop: stops.fn, getId: () => 'id1', ...extra }
}

const coreFactory = () => {
  imports.core++
  if (failImports.on) notFound()
  class GenericContainer {
    mounts: unknown[] = []
    constructor(public image: string) {
      calls.generic.push(this)
    }
    withExposedPorts() {
      return this
    }
    withWaitStrategy() {
      return this
    }
    withBindMounts(m: unknown[]) {
      this.mounts = m
      return this
    }
    withReuse() {
      calls.reuse.push('wiremock')
      return this
    }
    async start() {
      return container({ getHost: () => 'localhost', getMappedPort: () => 4321 })
    }
  }
  return { GenericContainer, Wait: { forHttp: () => ({}) } }
}
const pgFactory = () => {
  imports.pg++
  class PostgreSqlContainer {
    constructor(public image: string) {}
    withDatabase() {
      return this
    }
    withUsername() {
      return this
    }
    withPassword() {
      return this
    }
    withReuse() {
      calls.reuse.push('postgres')
      return this
    }
    async start() {
      return container({ getConnectionUri: () => 'postgres://localhost:5000/app' })
    }
  }
  return { PostgreSqlContainer }
}
const redisFactory = () => {
  imports.redis++
  class RedisContainer {
    constructor(public image: string) {}
    withReuse() {
      calls.reuse.push('redis')
      return this
    }
    async start() {
      return container({ getConnectionUrl: () => 'redis://localhost:6000' })
    }
  }
  return { RedisContainer }
}

const URLS = ['DATABASE_URL', 'REDIS_URL', 'WIREMOCK_URL']
const saved: Record<string, string | undefined> = {}

const ALL = {
  postgres: { image: 'postgres:17-alpine', database: 'app' },
  redis: { image: 'valkey/valkey:8-alpine' },
  wiremock: { image: 'wiremock/wiremock:3.13.2', mappingsDir: '/tmp/m' },
}

async function fresh(isMainThread = true) {
  vi.resetModules()
  vi.doMock('child_process', () => ({ spawnSync: spawn.fn }))
  vi.doMock('worker_threads', () => ({ isMainThread }))
  vi.doMock('testcontainers', coreFactory)
  vi.doMock('@testcontainers/postgresql', pgFactory)
  vi.doMock('@testcontainers/redis', redisFactory)
  return import('./testcontainers')
}

const exitListeners = () =>
  process.listeners('beforeExit').length + process.listeners('exit').length

let listenersBefore: number
let beforeBefore: number
let exitBefore: number
beforeEach(() => {
  for (const k of URLS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  imports.core = imports.pg = imports.redis = 0
  failImports.on = false
  calls.reuse = []
  calls.generic = []
  stops.fn.mockReset().mockResolvedValue(undefined)
  spawn.fn.mockReset().mockReturnValue({ status: 0 })
  listenersBefore = exitListeners()
  beforeBefore = process.listeners('beforeExit').length
  exitBefore = process.listeners('exit').length
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  for (const k of URLS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  for (const event of ['beforeExit', 'exit'] as const) {
    for (const l of process.listeners(event).slice(event === 'exit' ? exitBefore : beforeBefore)) {
      process.removeListener(event, l)
    }
  }
  vi.restoreAllMocks()
  vi.doUnmock('worker_threads')
})

describe('startContainers', () => {
  it('starts every service and sets the URL variables from the containers', async () => {
    const { startContainers } = await fresh()
    const result = await startContainers(ALL)
    expect(result).toEqual({ started: ['postgres', 'redis', 'wiremock'], skipped: [] })
    expect(process.env.DATABASE_URL).toBe('postgres://localhost:5000/app')
    expect(process.env.REDIS_URL).toBe('redis://localhost:6000')
    expect(process.env.WIREMOCK_URL).toBe('http://localhost:4321')
  })

  it.each([
    ['postgres', 'DATABASE_URL'],
    ['redis', 'REDIS_URL'],
    ['wiremock', 'WIREMOCK_URL'],
  ])('does not start %s when %s is set', async (service, variable) => {
    process.env[variable] = 'preset'
    const { startContainers } = await fresh()
    const result = await startContainers(ALL)
    expect(result.skipped).toEqual([service])
    expect(result.started).toEqual(['postgres', 'redis', 'wiremock'].filter((s) => s !== service))
    expect(process.env[variable]).toBe('preset')
  })

  it('never imports testcontainers when nothing needs starting', async () => {
    for (const k of URLS) process.env[k] = 'preset'
    const { startContainers } = await fresh()
    expect(await startContainers(ALL)).toEqual({
      started: [],
      skipped: ['postgres', 'redis', 'wiremock'],
    })
    expect(await startContainers({})).toEqual({ started: [], skipped: [] })
    expect(imports).toEqual({ core: 0, pg: 0, redis: 0 })
    expect(exitListeners()).toBe(listenersBefore)
  })

  it('only imports the packages for services that start', async () => {
    const { startContainers } = await fresh()
    await startContainers({ redis: ALL.redis })
    expect(imports.redis).toBe(1)
    expect(imports.pg).toBe(0)
  })

  it('mounts mappingsDir read-only', async () => {
    const { startContainers } = await fresh()
    await startContainers({ wiremock: ALL.wiremock })
    expect((calls.generic[0] as { mounts: unknown[] }).mounts).toEqual([
      { source: '/tmp/m', target: '/home/wiremock/mappings', mode: 'ro' },
    ])
  })

  it('names the install command and the env vars when testcontainers is missing', async () => {
    failImports.on = true
    const { startContainers } = await fresh()
    const err = await startContainers(ALL).catch((e: Error) => e)
    expect((err as Error).message).toContain(
      'npm install -D testcontainers @testcontainers/postgresql @testcontainers/redis',
    )
    expect((err as Error).message).toContain(
      'or set DATABASE_URL/REDIS_URL/WIREMOCK_URL to use your own',
    )
  })
})

describe('stopping on exit', () => {
  const fireExit = async () => {
    for (const l of process.listeners('beforeExit').slice(beforeBefore)) l(0)
    await new Promise((r) => setTimeout(r, 0))
  }

  it('registers one beforeExit hook, however many times it is called, and stops everything', async () => {
    const { startContainers } = await fresh()
    await startContainers({ redis: ALL.redis })
    delete process.env.REDIS_URL
    await startContainers(ALL)
    expect(exitListeners()).toBe(listenersBefore + 2)
    await fireExit()
    expect(stops.fn).toHaveBeenCalledTimes(4)
  })

  it('does not stop or register anything with reuse on, and asks for reuse', async () => {
    const { startContainers } = await fresh()
    await startContainers({ ...ALL, reuse: true })
    expect(exitListeners()).toBe(listenersBefore)
    expect(calls.reuse.sort()).toEqual(['postgres', 'redis', 'wiremock'])
    await fireExit()
    expect(stops.fn).not.toHaveBeenCalled()
  })

  it('does not ask for reuse by default', async () => {
    const { startContainers } = await fresh()
    await startContainers(ALL)
    expect(calls.reuse).toEqual([])
  })

  it('registers nothing in a worker thread', async () => {
    const { startContainers } = await fresh(false)
    await startContainers(ALL)
    expect(exitListeners()).toBe(listenersBefore)
  })

  it('swallows stop errors and logs once', async () => {
    stops.fn.mockRejectedValue(new Error('gone'))
    const { startContainers } = await fresh()
    await startContainers(ALL)
    await fireExit()
    expect(stops.fn).toHaveBeenCalledTimes(3)
    expect(console.error).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('gone')
  })

  it('removes the containers synchronously on exit when beforeExit never came', async () => {
    const { startContainers } = await fresh()
    await startContainers(ALL)
    process
      .listeners('exit')
      .slice(exitBefore)
      .forEach((l) => l(0))
    expect(spawn.fn).toHaveBeenCalledTimes(1)
    expect(spawn.fn.mock.calls[0].slice(0, 2)).toEqual([
      'docker',
      ['rm', '--force', '--volumes', 'id1', 'id1', 'id1'],
    ])
  })

  it('does not run docker on exit once the containers are stopped', async () => {
    const { startContainers } = await fresh()
    await startContainers(ALL)
    await fireExit()
    process
      .listeners('exit')
      .slice(exitBefore)
      .forEach((l) => l(0))
    expect(spawn.fn).not.toHaveBeenCalled()
  })

  it('does not run docker on exit with reuse on', async () => {
    const { startContainers } = await fresh()
    await startContainers({ ...ALL, reuse: true })
    process
      .listeners('exit')
      .slice(exitBefore)
      .forEach((l) => l(0))
    expect(spawn.fn).not.toHaveBeenCalled()
  })
})
