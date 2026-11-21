import * as path from 'path'

/**
 * Which Cucumber worker this code is running in.
 *
 * Under `--parallel N` (or `parallel: N` in the profile), Cucumber runs each
 * worker with `CUCUMBER_PARALLEL=true` and `CUCUMBER_WORKER_ID` set to 0..N-1.
 * Anywhere else, including Cucumber's coordinator, which loads the support
 * code but runs no hooks, this is worker 0 of 1 and `parallel` is false.
 */
export interface WorkerInfo {
  /** 0-based worker number; 0 when not running in parallel. */
  id: number
  /** How many workers the run has; 1 when not running in parallel. */
  total: number
  /** True only inside a worker of a parallel run. */
  parallel: boolean
}

/** The current worker, read from the environment each time. */
export function currentWorker(): WorkerInfo {
  const parallel =
    process.env.CUCUMBER_PARALLEL === 'true' && process.env.CUCUMBER_WORKER_ID !== undefined
  if (!parallel) return { id: 0, total: 1, parallel: false }
  return {
    id: Number(process.env.CUCUMBER_WORKER_ID),
    total: Number(process.env.CUCUMBER_TOTAL_WORKERS ?? '1'),
    parallel: true,
  }
}

let portStride = 1
const claimedPorts = new Map<string, string>()

/**
 * Set the gap between workers' ports, which `workerPort` uses. Default 1.
 * `registerHooks` sets it from `workerIsolation.portStride`; call this
 * yourself first if `workerPort` runs before `registerHooks` does.
 */
export function setWorkerPortStride(stride: number): void {
  if (!Number.isInteger(stride) || stride < 1) {
    throw new Error(`Worker port stride must be a positive integer, not ${stride}`)
  }
  portStride = stride
  claimedPorts.clear()
}

/**
 * A port for this worker: `base + offset` when not running in parallel,
 * `base + id * stride + offset` in worker `id`. With the default stride of 1,
 * space the bases of a suite's services further apart than the worker count;
 * with a larger stride (`workerIsolation.portStride`), give each service an
 * `offset` inside it, so one worker's services sit side by side.
 *
 * Throws if the port is above 65535, or is the port another `workerPort`
 * call (a different base or offset) already returned for this worker.
 */
export function workerPort(base: number, offset = 0): number {
  const id = currentWorker().id
  const port = base + id * portStride + offset
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `workerPort(${base}, ${offset}) is ${port} in worker ${id} (stride ${portStride}); ports run from 1 to 65535`,
    )
  }
  const key = `${id}:${port}`
  const source = `workerPort(${base}, ${offset})`
  const earlier = claimedPorts.get(key)
  if (earlier !== undefined && earlier !== source) {
    throw new Error(`${source} and ${earlier} are both port ${port} in worker ${id}`)
  }
  claimedPorts.set(key, source)
  return port
}

/**
 * Replace `${WORKER_PORT:<base>[:<offset>]}` in a string with `workerPort`'s
 * result, for service arguments and environment values.
 */
export function expandWorkerPorts(value: string): string {
  return value.replace(/\$\{WORKER_PORT:(\d+)(?::(\d+))?\}/g, (_, base, offset) =>
    String(workerPort(Number(base), offset === undefined ? 0 : Number(offset))),
  )
}

/**
 * A file path for this worker: unchanged when not running in parallel,
 * otherwise with `.w<id>` before the extension (`.api.log` becomes
 * `.api.w2.log`), so workers don't write over each other's logs.
 */
export function workerFile(file: string): string {
  const { id, parallel } = currentWorker()
  if (!parallel) return file
  const base = path.basename(file)
  // A leading dot is part of the name, not the extension: .api.log -> .api.w2.log
  const dot = base.lastIndexOf('.')
  const name = dot > 0 ? `${base.slice(0, dot)}.w${id}${base.slice(dot)}` : `${base}.w${id}`
  return file.slice(0, file.length - base.length) + name
}

/** The path prefix that marks one worker's traffic through a shared WireMock. */
export function wiremockNamespace(id = currentWorker().id): string {
  return `/__worker-${id}`
}

/**
 * The base URL a service under test (or the SPA server) should call WireMock
 * at: unchanged when not running in parallel, otherwise with this worker's
 * prefix, e.g. `http://localhost:8443/__worker-2`. Pass WireMock's root URL,
 * as for `wiremockUrl`: the prefix goes at the root. With
 * `workerIsolation.wiremock`, the framework registers this worker's stubs
 * under the same prefix, so one WireMock serves every worker.
 */
export function workerWiremockUrl(url: string): string {
  if (!currentWorker().parallel) return url
  return `${url.replace(/\/+$/, '')}${wiremockNamespace()}`
}

/**
 * This worker's database: unchanged when not running in parallel, otherwise
 * the same server with `_w<id>` appended to the database name. Create it with
 * {@link prepareWorkerDatabase}.
 */
export function workerDatabaseUrl(url: string): string {
  const { id, parallel } = currentWorker()
  if (!parallel) return url
  const parsed = new URL(url)
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'postgres'
  parsed.pathname = `/${encodeURIComponent(`${name}_w${id}`)}`
  return parsed.toString()
}

/**
 * This worker's Redis: unchanged when not running in parallel, otherwise the
 * database index in the URL (0 when it has none) plus the worker id. Redis
 * has 16 databases unless configured otherwise, so this suits up to 16
 * workers from index 0.
 */
export function workerRedisUrl(url: string): string {
  const { id, parallel } = currentWorker()
  if (!parallel) return url
  const parsed = new URL(url)
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`workerRedisUrl needs a redis:// or rediss:// URL, not ${url}`)
  }
  const db = Number(parsed.pathname.replace(/^\//, '') || '0')
  if (!Number.isInteger(db)) throw new Error(`Redis URL has a database that isn't a number: ${url}`)
  parsed.pathname = `/${db + id}`
  return parsed.toString()
}
