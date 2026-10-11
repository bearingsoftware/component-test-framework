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
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
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
    if (!/^[A-Za-z_$][\w$]*$/.test(global)) {
      throw new Error(
        `runtimeEnvGlobal must be a JavaScript identifier, not ${JSON.stringify(global)}`,
      )
    }
    fs.writeFileSync(
      path.join(root, '__env.js'),
      `window.${global} = ${JSON.stringify(options.runtimeEnv, null, 2)};\n`,
    )
  }

  // '/auth/' and '/auth' mean the same prefix.
  const prefixes = (options.proxyPrefixes ?? ['/api']).map((p) => p.replace(/\/+$/, '') || '/')
  const stripPrefix = options.stripPrefix ?? true
  const api = new URL(options.apiUrl)
  const mimeTypes = { ...MIME_TYPES, ...options.mimeTypes }

  const live = new Set<http.ClientRequest>()
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    const pathname = url.split('?')[0]
    const prefix = matchPrefix(pathname, prefixes)
    if (prefix) {
      // What follows the prefix, made a path again: '/api?x=1' forwards as '/?x=1'.
      const rest = url.slice(prefix.length)
      const forwardPath = stripPrefix ? (rest.startsWith('/') ? rest : `/${rest}`) : url
      forward(req, res, { api, path: forwardPath, prefix, stripPrefix, live })
      return
    }
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      res.writeHead(400)
      res.end('bad request')
      return
    }
    serveFile(res, root, decoded === '/' ? '/index.html' : decoded, indexHtml, mimeTypes)
  })

  // WebSocket upgrades aren't proxied; say so rather than leave the client waiting.
  server.on('upgrade', (_req, socket) => {
    socket.end(
      'HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\nWebSocket upgrades are not proxied',
    )
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  const baseUrl = `http://localhost:${port}`
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // An open proxied stream (SSE, a long poll) would otherwise keep close
      // waiting, and its upstream side would keep the process alive.
      server.closeAllConnections()
      for (const upstream of live) upstream.destroy()
    })

  try {
    const res = await fetch(`${baseUrl}/`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    await close()
    throw new Error(`The SPA server at ${baseUrl} did not serve /: ${(err as Error).message}`)
  }
  return { port, baseUrl, close }
}

// Headers that belong to one connection, not to the request or response, so
// aren't passed on (RFC 9110 section 7.6.1), plus any the Connection header names.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function endToEnd(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const named = String(headers.connection ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
  const out: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name) && !named.includes(name)) out[name] = value
  }
  return out
}

/** How a request maps onto the API: where it goes, and how its redirects come back. */
interface Forwarding {
  api: URL
  path: string
  /** The prefix it matched, put back on redirects when it was stripped. */
  prefix: string
  stripPrefix: boolean
  /** Upstream requests in flight, so the server can end them when it stops. */
  live: Set<http.ClientRequest>
}

/**
 * A redirect to the API's own address would send the browser straight to
 * WireMock, cross-origin. Point it back through this server instead.
 */
function rewriteLocation(location: string | undefined, f: Forwarding): string | undefined {
  if (!location) return location
  let target: URL
  try {
    target = new URL(location, f.api)
  } catch {
    return location
  }
  if (target.origin !== f.api.origin) return location
  return `${f.stripPrefix ? f.prefix : ''}${target.pathname}${target.search}${target.hash}`
}

/** Forward a request to the API, streaming the body both ways. */
function forward(req: http.IncomingMessage, res: http.ServerResponse, f: Forwarding): void {
  const client = f.api.protocol === 'https:' ? https : http
  const upstream = client.request(
    {
      protocol: f.api.protocol,
      hostname: f.api.hostname,
      port: f.api.port || (f.api.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: f.path,
      headers: { ...endToEnd(req.headers), host: f.api.host },
    },
    (upstreamRes) => {
      const headers = endToEnd(upstreamRes.headers)
      if (headers.location) headers.location = rewriteLocation(String(headers.location), f)
      res.writeHead(upstreamRes.statusCode ?? 502, headers)
      upstreamRes.pipe(res)
      // The API dropping the connection mid-response (as WireMock's fault
      // stubs do) drops the browser's too, rather than leaving it waiting.
      upstreamRes.on('close', () => {
        if (!upstreamRes.complete) res.destroy()
      })
    },
  )
  f.live.add(upstream)
  upstream.on('close', () => f.live.delete(upstream))
  // The browser giving up (navigating away from a stream, a cancelled fetch)
  // ends the upstream request too, rather than leaving it open on WireMock.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy()
  })
  upstream.on('error', (err) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(502, { 'Content-Type': 'text/plain' })
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
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res)
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
 * `webBaseUrl`. It uses one fixed port, so it suits serial runs, not
 * Cucumber `--parallel`.
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
  const fromEnv = process.env[portEnvVar]
  const port = Number(fromEnv ? fromEnv : (options.defaultPort ?? 3100))
  // The base URL is needed before the server starts, so the port can't be
  // picked by the system.
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `registerSpaServer needs a fixed port; ${portEnvVar}=${String(fromEnv)} isn't one.`,
    )
  }
  let server: SpaServer | null = null

  BeforeAll({ timeout: 30_000 }, async function () {
    try {
      server = await startSpaServer({ ...options, port })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new Error(
          `Port ${port} is in use (${portEnvVar}). Is another run still going? The SPA server ` +
            `uses one fixed port, so it can't run under Cucumber --parallel.`,
        )
      }
      throw err
    }
  })
  AfterAll({ timeout: 15_000 }, async function () {
    await server?.close()
  })
  return { port, baseUrl: `http://localhost:${port}` }
}
