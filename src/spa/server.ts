import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as path from 'path'
import { AddressInfo } from 'net'
import { BeforeAll, AfterAll } from '@cucumber/cucumber'

/** Options for {@link startSpaServer}. */
export interface SpaServerOptions {
  /** The built SPA, e.g. `web/dist`. Must contain `index.html`. */
  distDir: string
  /** Port to listen on. 0 picks a free one. Default 0. */
  port?: number
  /**
   * Where API requests go, usually WireMock. Requests whose path starts with
   * one of `proxyPrefixes` are forwarded here.
   */
  apiUrl: string
  /** Path prefixes forwarded to `apiUrl`. Default `['/api']`. */
  proxyPrefixes?: string[]
  /**
   * Remove the matched prefix before forwarding, so `/api/v1/x` reaches the
   * API as `/v1/x`. Default true. Set false when stubs are keyed on the full
   * path, prefix included.
   */
  stripPrefix?: boolean
  /**
   * Runtime configuration the SPA reads from `window.__ENV`, written to
   * `{distDir}/__env.js` before the server starts. Omit for an SPA that has
   * its settings built in.
   */
  runtimeEnv?: Record<string, string>
  /** The global `runtimeEnv` is assigned to. Default `__ENV`. */
  runtimeEnvGlobal?: string
  /** Extra file extensions and their content types, e.g. `{ '.webmanifest': 'application/manifest+json' }`. */
  mimeTypes?: Record<string, string>
  /** How to build the SPA, named in the error when `index.html` is missing. */
  buildHint?: string
}

/** A running SPA server. */
export interface SpaServer {
  port: number
  /** e.g. `http://localhost:3100`. */
  baseUrl: string
  close: () => Promise<void>
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** The prefix a request path falls under, if any: `/api` matches `/api` and `/api/…`, not `/apiary`. */
function matchPrefix(pathname: string, prefixes: string[]): string | undefined {
  return prefixes.find((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * Serve a built SPA the way it's deployed: its files, `index.html` for any
 * other path so client-side routes load, and API paths forwarded to
 * WireMock (or any `apiUrl`).
 *
 * Before listening it checks the build exists and writes `__env.js` when
 * `runtimeEnv` is given; once listening it fetches `/` to prove the SPA is
 * served.
 */
export async function startSpaServer(options: SpaServerOptions): Promise<SpaServer> {
  const root = path.resolve(options.distDir)
  const indexHtml = path.join(root, 'index.html')
  if (!fs.existsSync(indexHtml)) {
    const hint = options.buildHint ? ` Build it first: ${options.buildHint}` : ''
    throw new Error(`No built SPA at ${root} (index.html is missing).${hint}`)
  }
  if (options.runtimeEnv) {
    const global = options.runtimeEnvGlobal ?? '__ENV'
    fs.writeFileSync(
      path.join(root, '__env.js'),
      `window.${global} = ${JSON.stringify(options.runtimeEnv, null, 2)};\n`,
    )
  }

  const prefixes = options.proxyPrefixes ?? ['/api']
  const stripPrefix = options.stripPrefix ?? true
  const api = new URL(options.apiUrl)
  const mimeTypes = { ...MIME_TYPES, ...options.mimeTypes }

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    const pathname = url.split('?')[0]
    const prefix = matchPrefix(pathname, prefixes)
    if (prefix) {
      forward(req, res, api, stripPrefix ? url.slice(prefix.length) || '/' : url)
      return
    }
    serveFile(res, root, pathname === '/' ? '/index.html' : pathname, indexHtml, mimeTypes)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const baseUrl = `http://localhost:${port}`
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()))

  try {
    const res = await fetch(`${baseUrl}/`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    await close()
    throw new Error(`The SPA server at ${baseUrl} did not serve /: ${(err as Error).message}`)
  }
  return { port, baseUrl, close }
}

/** Forward a request to the API, streaming the body both ways. */
function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  api: URL,
  forwardPath: string,
): void {
  const client = api.protocol === 'https:' ? https : http
  const upstream = client.request(
    {
      protocol: api.protocol,
      hostname: api.hostname,
      port: api.port || (api.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: forwardPath,
      headers: { ...req.headers, host: api.host },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end(`proxy error: ${err.message}`)
  })
  req.pipe(upstream)
}

/** Serve a file from the build, or index.html for anything that isn't one. */
function serveFile(
  res: http.ServerResponse,
  root: string,
  requestPath: string,
  indexHtml: string,
  mimeTypes: Record<string, string>,
): void {
  const resolved = path.normalize(path.join(root, requestPath))
  // With the separator, so a sibling such as dist-old isn't inside dist.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  const file = fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : indexHtml
  const type = mimeTypes[path.extname(file)] ?? 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': type })
  fs.createReadStream(file).pipe(res)
}

/** Options for {@link registerSpaServer}: {@link SpaServerOptions} with the port taken from the environment. */
export interface RegisterSpaServerOptions extends Omit<SpaServerOptions, 'port'> {
  /** Environment variable holding the port. Default `WEB_PORT`. */
  portEnvVar?: string
  /** Port when the variable isn't set. Default 3100. */
  defaultPort?: number
}

/**
 * Start the SPA server before the suite and stop it after. The port, and so
 * the base URL, is known at once, so it can be given to `registerHooks` as
 * `webBaseUrl`.
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
  const portEnvVar = options.portEnvVar ?? 'WEB_PORT'
  const port = Number(process.env[portEnvVar] ?? options.defaultPort ?? 3100)
  let server: SpaServer | null = null

  BeforeAll({ timeout: 30_000 }, async function () {
    server = await startSpaServer({ ...options, port })
  })
  AfterAll({ timeout: 15_000 }, async function () {
    await server?.close()
  })
  return { port, baseUrl: `http://localhost:${port}` }
}
