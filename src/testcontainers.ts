// `@bearingsoftware/component-test-framework/testcontainers`: start Postgres,
// Redis/Valkey and WireMock in Docker from an ESM cucumber.mjs. The packages
// it needs are loaded only when a service has to start.
import { spawnSync } from 'child_process'
import { isMainThread } from 'worker_threads'

export interface StartContainersOptions {
  /** Started unless DATABASE_URL is set. `database` is the one workers copy from. */
  postgres?: { image: string; database?: string; username?: string; password?: string }
  /** Started unless REDIS_URL is set. Valkey images go here too. */
  redis?: { image: string }
  /** Started unless WIREMOCK_URL is set. `mappingsDir` is mounted read-only. */
  wiremock?: { image: string; mappingsDir?: string }
  /** Keep containers between runs. Local only: they are never stopped or cleaned up. */
  reuse?: boolean
}

export interface StartContainersResult {
  started: string[]
  skipped: string[]
}

interface Stoppable {
  getId(): string
  stop(): Promise<unknown>
}

const USE_YOUR_OWN = 'or set DATABASE_URL/REDIS_URL/WIREMOCK_URL to use your own'

const ORDER = ['postgres', 'redis', 'wiremock']
const running: Stoppable[] = []
let exitHookRegistered = false

async function load<T>(name: string, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer()
  } catch (err) {
    const { cause } = err as { cause?: unknown }
    // Only the package being loaded missing means "not installed"; a missing dependency of it is a real error.
    const notInstalled = [err, cause].some((e) => {
      const { code, message } = (e ?? {}) as NodeJS.ErrnoException
      return (
        (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') &&
        typeof message === 'string' &&
        message.includes(`'${name}'`)
      )
    })
    if (!notInstalled) throw err
    throw new Error(`startContainers needs ${name}: run npm install -D ${name}, ${USE_YOUR_OWN}`)
  }
}

/** Stop what startContainers started. Runs on exit by itself; call it to stop earlier. */
export async function stopContainers(): Promise<void> {
  const results = await Promise.allSettled(running.splice(0).map((c) => c.stop()))
  const failed = results.filter((r) => r.status === 'rejected')
  if (failed.length > 0) {
    console.error(
      `startContainers: stopping ${failed.length} container(s) failed: ${(failed[0] as PromiseRejectedResult).reason}`,
    )
  }
}

// Cucumber ends the process with process.exit, which skips beforeExit and lets
// no promise finish, so a synchronous `docker rm` stands in for the stop then.
function stopOnExit(): void {
  if (exitHookRegistered || !isMainThread) return
  exitHookRegistered = true
  process.on('beforeExit', () => {
    void stopContainers()
  })
  process.on('exit', () => {
    const ids = running.splice(0).map((c) => c.getId())
    if (ids.length === 0) return
    const result = spawnSync('docker', ['rm', '--force', '--volumes', ...ids], {
      stdio: 'ignore',
      timeout: 15_000,
    })
    if (result.status !== 0) {
      console.error('startContainers: removing the containers failed; Ryuk will clean up')
    }
  })
}

/**
 * Start the containers asked for whose URL variable is unset, and set that
 * variable from the container. Call it with `await` at the top of cucumber.mjs.
 */
export async function startContainers(
  options: StartContainersOptions,
): Promise<StartContainersResult> {
  const started: string[] = []
  const skipped: string[] = []
  const wanted = (service: 'postgres' | 'redis' | 'wiremock', variable: string): boolean => {
    if (!options[service]) return false
    if (process.env[variable]) {
      skipped.push(service)
      return false
    }
    return true
  }
  const postgres = wanted('postgres', 'DATABASE_URL') ? options.postgres : undefined
  const redis = wanted('redis', 'REDIS_URL') ? options.redis : undefined
  const wiremock = wanted('wiremock', 'WIREMOCK_URL') ? options.wiremock : undefined
  if (!postgres && !redis && !wiremock) return { started, skipped }

  const core = await load('testcontainers', () => import('testcontainers'))
  const reuse = options.reuse === true
  const keep = (container: Stoppable) => {
    if (!reuse) running.push(container)
  }

  // Services start side by side; the first failure rejects after the rest settle.
  const tasks: Promise<void>[] = []
  if (postgres) {
    tasks.push(
      (async () => {
        const { PostgreSqlContainer } = await load(
          '@testcontainers/postgresql',
          () => import('@testcontainers/postgresql'),
        )
        let builder = new PostgreSqlContainer(postgres.image)
        if (postgres.database) builder = builder.withDatabase(postgres.database)
        if (postgres.username) builder = builder.withUsername(postgres.username)
        if (postgres.password) builder = builder.withPassword(postgres.password)
        if (reuse) builder = builder.withReuse()
        const container = await builder.start()
        keep(container)
        process.env.DATABASE_URL = container.getConnectionUri()
        started.push('postgres')
      })(),
    )
  }
  if (redis) {
    tasks.push(
      (async () => {
        const { RedisContainer } = await load(
          '@testcontainers/redis',
          () => import('@testcontainers/redis'),
        )
        let builder = new RedisContainer(redis.image)
        if (reuse) builder = builder.withReuse()
        const container = await builder.start()
        keep(container)
        process.env.REDIS_URL = container.getConnectionUrl()
        started.push('redis')
      })(),
    )
  }
  if (wiremock) {
    tasks.push(
      (async () => {
        let builder = new core.GenericContainer(wiremock.image)
          .withExposedPorts(8080)
          .withWaitStrategy(core.Wait.forHttp('/__admin/health', 8080))
        if (wiremock.mappingsDir) {
          builder = builder.withBindMounts([
            { source: wiremock.mappingsDir, target: '/home/wiremock/mappings', mode: 'ro' },
          ])
        }
        if (reuse) builder = builder.withReuse()
        const container = await builder.start()
        keep(container)
        process.env.WIREMOCK_URL = `http://${container.getHost()}:${container.getMappedPort(8080)}`
        started.push('wiremock')
      })(),
    )
  }
  const settled = await Promise.allSettled(tasks)
  if (running.length > 0) stopOnExit()
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failure) {
    await stopContainers()
    throw failure.reason
  }
  started.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
  return { started, skipped }
}
