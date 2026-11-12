import { defineAdapter, registerAdapter } from '../support/adapter'
import type { Adapter } from '../support/adapter'
import { workerPort } from '../support/worker'
import { startSpaServer, type SpaServer, type SpaServerOptions } from './spa-server'

export { startSpaServer }
export type { SpaServer, SpaServerOptions }

/** Options for {@link registerSpaServer}: {@link SpaServerOptions} with the port taken from the environment. */
export interface RegisterSpaServerOptions extends Omit<SpaServerOptions, 'port'> {
  /** Environment variable holding the port. Default `WEB_PORT`. */
  portEnvVar?: string
  /**
   * Port when the variable isn't set. Default 3100. Under Cucumber
   * `--parallel`, worker n listens on the port plus n.
   */
  defaultPort?: number
}

/**
 * Start the SPA server before the suite and stop it after. The port, and so
 * the base URL, is known at once, so it can be given to `registerHooks` as
 * `webBaseUrl`. Under Cucumber `--parallel`, each worker runs its own
 * server, on the port plus the worker's number (see `workerPort`); give it
 * `apiUrl: workerWiremockUrl(…)` to keep each worker's API traffic apart.
 *
 * @example
 * const spa = registerSpaServer({
 *   distDir: path.resolve(__dirname, '../../../dist'),
 *   apiUrl: process.env.WIREMOCK_URL ?? 'http://localhost:8443',
 *   buildHint: 'npm run build:coverage',
 * })
 * registerHooks({ ...loadConfig(), webBaseUrl: spa.baseUrl })
 */
export function registerSpaServer(options: RegisterSpaServerOptions): {
  port: number
  baseUrl: string
} {
  const { port, baseUrl } = registerAdapter(spaServerAdapter(options))
  return { port, baseUrl }
}

/** What {@link spaServerAdapter} keeps as its state. */
export interface SpaServerState {
  port: number
  baseUrl: string
  server: SpaServer | null
}

/** {@link registerSpaServer} as an adapter: starts before the suite, stops after. */
export function spaServerAdapter(options: RegisterSpaServerOptions): Adapter<SpaServerState> {
  const portEnvVar = options.portEnvVar ?? 'WEB_PORT'
  const fromEnv = process.env[portEnvVar]
  const basePort = Number(fromEnv ? fromEnv : (options.defaultPort ?? 3100))
  // The base URL is needed before the server starts, so the port can't be
  // picked by the system.
  if (!Number.isInteger(basePort) || basePort <= 0) {
    throw new Error(
      `registerSpaServer needs a fixed port; ${portEnvVar}=${String(fromEnv)} isn't one.`,
    )
  }
  const port = workerPort(basePort)

  return defineAdapter<SpaServerState>({
    name: `spa-server:${port}`,
    setup: () => ({ port, baseUrl: `http://localhost:${port}`, server: null }),
    beforeAll: async (_ctx, state) => {
      try {
        state.server = await startSpaServer({ ...options, port })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          throw new Error(
            `Port ${port} is in use (${portEnvVar}${port === basePort ? '' : ` plus the worker number`}). ` +
              `Is another run still going?`,
          )
        }
        throw err
      }
    },
    afterAll: async (_ctx, state) => {
      await state.server?.close()
    },
    afterAllTimeout: 15_000,
  })
}
