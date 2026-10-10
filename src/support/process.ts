import { spawn, ChildProcess } from 'node:child_process'
import { createWriteStream, WriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Before, After, BeforeAll, AfterAll } from '@cucumber/cucumber'

/**
 * Options for {@link spawnServiceUnderTest}.
 */
export interface SpawnServiceOptions {
  /** Human-readable name used in error messages and log prefixes. */
  name: string
  /** Working directory for the child process. */
  cwd: string
  /** Command to execute (e.g. "go" or a prebuilt binary path). */
  cmd: string
  /** Arguments to pass to the command. */
  args?: string[]
  /** Environment variables. */
  env?: NodeJS.ProcessEnv
  /**
   * Path to write stdout+stderr. Parent directories are created as needed.
   * Omit to discard output.
   */
  logFile?: string
  /** Append to `logFile` rather than starting it afresh. Default false. */
  appendLog?: boolean
  /**
   * Readiness check. Either an HTTP URL to poll for a 2xx response, or a
   * custom async predicate. Poll cadence is 250ms, total deadline is the
   * `healthTimeoutMs` option (default 60s).
   */
  readyCheck: { url: string } | { probe: () => Promise<boolean> }
  /** Readiness timeout. Default 60s. */
  healthTimeoutMs?: number
  /**
   * Name of an environment variable holding the path to a prebuilt binary.
   * When it's set, that binary runs with `binaryArgs` instead of `cmd` and
   * `args`. For example `API_BIN`, so CI can run a binary built once (and
   * instrumented for coverage) while local runs use `go run`.
   */
  binaryEnvVar?: string
  /** Arguments for the prebuilt binary. Default none. */
  binaryArgs?: string[]
  /**
   * How long `stop()` waits after SIGINT before SIGKILL, in ms. Default 5s.
   * A Go binary built with `-cover` needs time to write its coverage files
   * to GOCOVERDIR on the way out; 15s is a safe value for those.
   */
  stopGraceMs?: number
}

/**
 * Handle returned by {@link spawnServiceUnderTest}. Call `stop()` from the
 * consumer's AfterAll hook.
 */
export interface SpawnServiceHandle {
  /** The running child process. After a restart, the new one. */
  readonly process: ChildProcess
  /** Resolves once the service passes its readiness check. */
  ready: Promise<void>
  /** Send SIGINT to the process group and wait up to `stopGraceMs` before SIGKILL. */
  stop: () => Promise<void>
  /**
   * Stop the service and start it again, with `envOverrides` merged over the
   * environment it was first started with, then wait until it's ready.
   * The log continues in the same file.
   */
  restart: (envOverrides?: NodeJS.ProcessEnv) => Promise<void>
}

const DEFAULT_HEALTH_TIMEOUT = 60_000
const DEFAULT_STOP_GRACE = 5_000
const KILL_WAIT = 2_000

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * One service process and its log, which can be started, stopped and
 * restarted. Everything public below is built on it.
 */
class ManagedService {
  private child: ChildProcess | null = null
  private log: WriteStream | undefined
  private stopping = false

  constructor(private readonly opts: SpawnServiceOptions) {
    if (opts.logFile) {
      mkdirSync(dirname(opts.logFile), { recursive: true })
      this.log = createWriteStream(opts.logFile, { flags: opts.appendLog ? 'a' : 'w' })
    }
  }

  get process(): ChildProcess | null {
    return this.child
  }

  /** Spawn the process now. Readiness is checked separately, by {@link waitReady}. */
  spawn(env: NodeJS.ProcessEnv | undefined): ChildProcess {
    const binary = this.opts.binaryEnvVar ? process.env[this.opts.binaryEnvVar] : undefined
    const cmd = binary || this.opts.cmd
    const args = binary ? (this.opts.binaryArgs ?? []) : (this.opts.args ?? [])

    const child = spawn(cmd, args, {
      cwd: this.opts.cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.stopping = false

    if (this.log) {
      // end: false, so a restarted process keeps writing to the same log.
      child.stdout?.pipe(this.log, { end: false })
      child.stderr?.pipe(this.log, { end: false })
    }
    child.on('exit', (code) => {
      if (!this.stopping && this.child === child) {
        console.error(`[${this.opts.name}] exited unexpectedly with code ${code}`)
      }
    })
    return child
  }

  async waitReady(): Promise<void> {
    await waitReady(this.opts, this.opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT)
  }

  /** Stop the current process; the log stays open for a restart. */
  async stopProcess(): Promise<void> {
    const child = this.child
    this.stopping = true
    if (!child?.pid) return
    try {
      process.kill(-child.pid, 'SIGINT')
    } catch {
      /* already dead */
    }
    const deadline = Date.now() + (this.opts.stopGraceMs ?? DEFAULT_STOP_GRACE)
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* ignore */
      }
      // SIGKILL can't be ignored, but the exit still takes a moment to be
      // reported. Waiting for it means the port is free for a restart.
      await waitForExit(child, KILL_WAIT)
    }
  }

  /** Stop for good: the process, then the log. */
  async stop(): Promise<void> {
    await this.stopProcess()
    await new Promise<void>((resolve) => (this.log ? this.log.end(resolve) : resolve()))
  }
}

/**
 * Spawn a service-under-test (API, worker, sidecar) with the same lifecycle
 * guarantees we've found we actually need:
 *
 * - Detached process group so SIGINT/SIGKILL reaches every child the binary
 *   spawns itself (go-run chains are the motivating case).
 * - stdout+stderr piped to a log file so Cucumber's own console stays clean
 *   but crash output is recoverable post-hoc.
 * - Unexpected-exit logging: anything that dies before stop() is called gets
 *   a clear console error instead of a mysteriously hanging test run.
 * - Readiness gate: either HTTP poll or caller-supplied probe, same 250ms
 *   cadence as the DB/Redis waiters.
 *
 * For a service that needs work done before it starts, or that another
 * process may already be running, use {@link startService} or
 * {@link registerServiceUnderTest}.
 */
export function spawnServiceUnderTest(opts: SpawnServiceOptions): SpawnServiceHandle {
  const service = new ManagedService(opts)
  service.spawn(opts.env)
  return {
    get process() {
      return service.process as ChildProcess
    },
    ready: service.waitReady(),
    stop: () => service.stop(),
    restart: async (envOverrides) => {
      await service.stopProcess()
      service.spawn({ ...opts.env, ...envOverrides })
      await service.waitReady()
    },
  }
}

/** Options for {@link startService} and {@link registerServiceUnderTest}. */
export interface ServiceOptions extends SpawnServiceOptions {
  /**
   * Name of an environment variable that, set to `1`, means the service is
   * already running (started by hand, or by docker compose), so it isn't
   * spawned, prepared or stopped. For example `SKIP_API_SPAWN`.
   */
  skipEnvVar?: string
  /**
   * Runs before every start, restarts included: for example clearing state
   * the service reads once at boot. Not run when the service is skipped.
   */
  beforeStart?: () => unknown | Promise<unknown>
}

/** A service started by {@link startService}. */
export interface ServiceHandle {
  /** True when `skipEnvVar` said the service is already running. */
  readonly skipped: boolean
  /** The running child process, or null when skipped. */
  readonly process: ChildProcess | null
  /**
   * Stop the service and start it again with `envOverrides` merged over its
   * original environment, then wait until it's ready. Does nothing when skipped.
   */
  restart: (envOverrides?: NodeJS.ProcessEnv) => Promise<void>
  /** Stop the service. Does nothing when skipped. */
  stop: () => Promise<void>
}

/**
 * Start a service and wait until it's ready: run `beforeStart`, spawn it
 * (or a prebuilt binary, see `binaryEnvVar`), and poll its readiness check.
 * Skips all of it when `skipEnvVar` is set to `1`.
 */
export async function startService(opts: ServiceOptions): Promise<ServiceHandle> {
  if (opts.skipEnvVar && process.env[opts.skipEnvVar] === '1') {
    return {
      skipped: true,
      process: null,
      restart: async () => {},
      stop: async () => {},
    }
  }

  const service = new ManagedService(opts)
  const start = async (env: NodeJS.ProcessEnv | undefined) => {
    await opts.beforeStart?.()
    service.spawn(env)
    await service.waitReady()
  }
  await start(opts.env)
  return {
    skipped: false,
    get process() {
      return service.process
    },
    restart: async (envOverrides) => {
      await service.stopProcess()
      await start({ ...opts.env, ...envOverrides })
    },
    stop: () => service.stop(),
  }
}

/** Stop several services at once, rather than one after another. */
export async function stopServices(
  ...services: (Pick<ServiceHandle, 'stop'> | null | undefined)[]
): Promise<void> {
  await Promise.all(services.map((service) => service?.stop()))
}

/** What {@link registerServiceUnderTest} returns. */
export interface RegisteredService {
  /** The started service. Throws if asked for before the suite's BeforeAll. */
  readonly handle: ServiceHandle
  /**
   * Restart the service with `envOverrides` before each scenario tagged
   * `tag`, and with its original environment after it: for settings the
   * service reads once at start-up. Scenarios are skipped when the service
   * itself is skipped, since it can't be restarted.
   */
  restartForTag: (tag: string, envOverrides: NodeJS.ProcessEnv) => void
}

/**
 * Start a service before the suite and stop it after: registers the
 * BeforeAll and AfterAll hooks for {@link startService}. A harness becomes
 * this call plus the service's environment.
 *
 * @example
 * export const api = registerServiceUnderTest({
 *   name: 'api',
 *   cwd: BACKEND_ROOT,
 *   cmd: 'go',
 *   args: ['run', './cmd/api'],
 *   binaryEnvVar: 'API_BIN',
 *   skipEnvVar: 'SKIP_API_SPAWN',
 *   env: { ...process.env, LISTEN_ADDR: ':18080' },
 *   logFile: path.join(__dirname, '..', '.api.log'),
 *   readyCheck: { url: 'http://localhost:18080/health' },
 *   stopGraceMs: 15_000,
 * })
 * api.restartForTag('@actuation-locked', { ACTUATION_DISABLED: 'true' })
 */
export function registerServiceUnderTest(opts: ServiceOptions): RegisteredService {
  const healthTimeout = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT
  const stopGrace = opts.stopGraceMs ?? DEFAULT_STOP_GRACE
  // Room for one stop and one start, plus whatever beforeStart does.
  const startTimeout = healthTimeout + 10_000
  const restartTimeout = stopGrace + healthTimeout + 10_000
  let handle: ServiceHandle | null = null

  BeforeAll({ timeout: startTimeout }, async function () {
    handle = await startService(opts)
  })
  AfterAll({ timeout: stopGrace + 10_000 }, async function () {
    await handle?.stop()
  })

  const started = (): ServiceHandle => {
    if (!handle) throw new Error(`[${opts.name}] has not been started yet`)
    return handle
  }

  return {
    get handle() {
      return started()
    },
    restartForTag(tag, envOverrides) {
      Before({ tags: tag, timeout: restartTimeout }, async function () {
        const service = started()
        if (service.skipped) return 'skipped'
        await service.restart(envOverrides)
        return undefined
      })
      After({ tags: tag, timeout: restartTimeout }, async function () {
        const service = started()
        if (!service.skipped) await service.restart()
      })
    },
  }
}

async function waitReady(opts: SpawnServiceOptions, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const probe =
    'url' in opts.readyCheck
      ? async () => {
          try {
            const res = await fetch((opts.readyCheck as { url: string }).url)
            return res.ok
          } catch {
            return false
          }
        }
      : opts.readyCheck.probe

  while (Date.now() < deadline) {
    if (await probe()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`${opts.name} did not become ready within ${timeoutMs}ms`)
}
