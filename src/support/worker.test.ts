import { describe, it, expect, afterEach } from 'vitest'
import {
  currentWorker,
  workerPort,
  setWorkerPortStride,
  resetWorkerPorts,
  expandWorkerPorts,
  expandWorkerPortsInEnv,
  workerFile,
  workerWiremockUrl,
  workerDatabaseUrl,
  workerRedisUrl,
} from './worker'

function asWorker(id: number, total = 4): void {
  process.env.CUCUMBER_PARALLEL = 'true'
  process.env.CUCUMBER_WORKER_ID = String(id)
  process.env.CUCUMBER_TOTAL_WORKERS = String(total)
}

afterEach(() => {
  resetWorkerPorts()
  delete process.env.CUCUMBER_PARALLEL
  delete process.env.CUCUMBER_WORKER_ID
  delete process.env.CUCUMBER_TOTAL_WORKERS
})

describe('outside a parallel run', () => {
  it('is worker 0 of 1, and every helper returns its input', () => {
    expect(currentWorker()).toEqual({ id: 0, total: 1, parallel: false })
    expect(workerPort(18080)).toBe(18080)
    expect(workerFile('/tmp/.api.log')).toBe('/tmp/.api.log')
    expect(workerWiremockUrl('http://localhost:8443')).toBe('http://localhost:8443')
    expect(workerDatabaseUrl('postgres://u:p@db:5432/app')).toBe('postgres://u:p@db:5432/app')
    expect(workerRedisUrl('redis://cache:6379')).toBe('redis://cache:6379')
  })

  it("ignores a worker id without Cucumber's parallel flag", () => {
    process.env.CUCUMBER_WORKER_ID = '2'
    expect(currentWorker().parallel).toBe(false)
  })
})

describe('in worker 2 of a parallel run', () => {
  it('knows its number and the run size', () => {
    asWorker(2)
    expect(currentWorker()).toEqual({ id: 2, total: 4, parallel: true })
  })

  it('offsets ports by the worker number', () => {
    asWorker(2)
    expect(workerPort(18080)).toBe(18082)
  })

  it('puts the worker number before the extension of a file name', () => {
    asWorker(2)
    expect(workerFile('/tmp/suite/.api.log')).toBe('/tmp/suite/.api.w2.log')
    expect(workerFile('logs/api.log')).toBe('logs/api.w2.log')
    expect(workerFile('./worker')).toBe('./worker.w2')
  })

  it("adds the worker's prefix to the WireMock URL", () => {
    asWorker(2)
    expect(workerWiremockUrl('http://localhost:8443/')).toBe('http://localhost:8443/__worker-2')
  })

  it("names the worker's database after the configured one, keeping the rest of the URL", () => {
    asWorker(2)
    expect(workerDatabaseUrl('postgres://u:p%40ss@db:5432/app?sslmode=disable')).toBe(
      'postgres://u:p%40ss@db:5432/app_w2?sslmode=disable',
    )
  })

  it('offsets the Redis database index from the one in the URL', () => {
    asWorker(2)
    expect(workerRedisUrl('redis://cache:6379')).toBe('redis://cache:6379/2')
    expect(workerRedisUrl('redis://:secret@cache:6379/4')).toBe('redis://:secret@cache:6379/6')
  })
})

describe('workerPort stride and offset', () => {
  it.each([
    [0, 18080, 18085],
    [1, 18180, 18185],
    [3, 18380, 18385],
  ])('worker %i with stride 100 gets %i and, at offset 5, %i', (id, plain, offset) => {
    asWorker(id)
    setWorkerPortStride(100)
    expect(workerPort(18080)).toBe(plain)
    expect(workerPort(18080, 5)).toBe(offset)
  })

  it('adds the offset outside a parallel run', () => {
    setWorkerPortStride(100)
    expect(workerPort(18080, 7)).toBe(18087)
  })

  it('defaults to a stride of 1', () => {
    asWorker(3)
    expect(workerPort(18080, 10)).toBe(18093)
  })

  it('throws above 65535', () => {
    asWorker(3)
    setWorkerPortStride(1000)
    expect(() => workerPort(65000)).toThrow(/65535/)
  })

  it('throws when two services land on the same port', () => {
    asWorker(1)
    setWorkerPortStride(100)
    workerPort(18080)
    expect(() => workerPort(18180, -100)).toThrow(/both port 18180/)
    expect(workerPort(18080)).toBe(18180)
  })

  it('throws when changing the stride after ports were handed out', () => {
    workerPort(18080)
    expect(() => setWorkerPortStride(100)).toThrow(/already 1/)
  })

  it('accepts the same stride again after ports were handed out', () => {
    setWorkerPortStride(100)
    workerPort(18080)
    expect(() => setWorkerPortStride(100)).not.toThrow()
    expect(workerPort(18080)).toBe(18080)
  })

  it('rejects a bad stride', () => {
    expect(() => setWorkerPortStride(0)).toThrow(/stride/)
  })
})

describe('expandWorkerPorts', () => {
  it('replaces WORKER_PORT placeholders with and without an offset', () => {
    asWorker(2)
    setWorkerPortStride(100)
    expect(expandWorkerPorts(':${WORKER_PORT:18080}')).toBe(':18280')
    expect(expandWorkerPorts('http://h:${WORKER_PORT:18080:3}/x ${WORKER_PORT:19000}')).toBe(
      'http://h:18283/x 19200',
    )
    expect(expandWorkerPorts('no placeholders')).toBe('no placeholders')
  })
})

describe('placeholder scope and errors', () => {
  it.each(['${WORKER_PORT:abc}', '${WORKER_PORT:-1}', '${WORKER_PORT:}', '${WORKER_PORT:1:x}'])(
    'throws naming %s',
    (bad) => {
      expect(() => expandWorkerPorts(`x ${bad}`)).toThrow(bad)
    },
  )

  it('expands configured env values but not inherited process.env ones', () => {
    asWorker(1)
    process.env.CTF_TEST_INHERITED = 'keep ${WORKER_PORT:18080}'
    try {
      const out = expandWorkerPortsInEnv({
        ...process.env,
        OWN: ':${WORKER_PORT:18080}',
      })
      expect(out.OWN).toBe(':18081')
      expect(out.CTF_TEST_INHERITED).toBe('keep ${WORKER_PORT:18080}')
    } finally {
      delete process.env.CTF_TEST_INHERITED
    }
  })
})
