import { describe, it, expect, afterEach } from 'vitest'
import {
  currentWorker,
  workerPort,
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
