import { execFileSync } from 'child_process'
import * as dgram from 'dgram'
import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { matches } from './match'
import type { CaptureMatch, CapturedRequest } from './match'

export type CaptureKind = 'http' | 'https' | 'udp' | 'tcp'

export interface CaptureServerOptions {
  kind: CaptureKind
  /** Port to listen on; 0 (the default) picks a free one. `portEnv`, when set in the environment, wins. */
  port?: number
  /** Name of an environment variable holding the port. */
  portEnv?: string
  /** `https` only: a certificate and key, or `'self-signed'` (needs the `openssl` binary). */
  tls?: { cert: string; key: string } | 'self-signed'
}

export interface Reply {
  status: number
  body?: string
  headers?: Record<string, string>
}

export interface CaptureRule {
  /** Default: every request. */
  match?: CaptureMatch
  /**
   * A status to answer every match with, or a list answered one per match, in
   * order. A spent list stops applying and later requests fall through.
   */
  respond: number | number[] | Reply[]
  /** Answer one matching request only. */
  once?: boolean
}

export interface CaptureServer {
  /** `http://127.0.0.1:port`, `https://…`, `tcp://…` or `udp://…`. */
  readonly url: string
  readonly port: number
  /** The certificate to trust, for `tls: 'self-signed'`. */
  readonly ca?: string
  requests(filter?: CaptureMatch): CapturedRequest[]
  /** Forget the recorded requests and the scripted rules. */
  reset(): void
  /** http and https only. The first rule that matches and still has answers left decides. */
  script(rule: CaptureRule): void
  /** Refuse connections, keeping the port, until {@link CaptureServer.up}. */
  down(): Promise<void>
  up(): Promise<void>
  stop(): Promise<void>
}

const HOST = '127.0.0.1'

interface ActiveRule {
  match?: CaptureMatch
  queue: Reply[]
  repeat: boolean
}

function toReplies(respond: CaptureRule['respond']): Reply[] {
  const list = Array.isArray(respond) ? respond : [respond]
  return list.map((r) => (typeof r === 'number' ? { status: r } : r))
}

function selfSigned(dir: string): { cert: string; key: string } {
  const keyFile = path.join(dir, 'server.key')
  const certFile = path.join(dir, 'server.crt')
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        keyFile,
        '-out',
        certFile,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ],
      { stdio: 'ignore' },
    )
  } catch {
    throw new Error(
      "tls: 'self-signed' needs the openssl binary on PATH; pass { cert, key } instead",
    )
  }
  return { cert: fs.readFileSync(certFile, 'utf-8'), key: fs.readFileSync(keyFile, 'utf-8') }
}

function resolvePort(options: CaptureServerOptions): number {
  const fromEnv = options.portEnv ? process.env[options.portEnv] : undefined
  const port = fromEnv !== undefined && fromEnv !== '' ? Number(fromEnv) : (options.port ?? 0)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid capture server port: ${String(fromEnv ?? options.port)}`)
  }
  return port
}

function record(req: http.IncomingMessage, body: Buffer): CapturedRequest {
  const url = new URL(req.url ?? '/', 'http://stub')
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v
  }
  const text = body.toString('utf-8')
  const entry: CapturedRequest = {
    at: new Date(),
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    body,
    text,
  }
  if (text !== '' && (headers['content-type'] ?? '').includes('json')) {
    try {
      entry.json = JSON.parse(text)
    } catch {
      // a body that isn't JSON stays text
    }
  }
  return entry
}

/**
 * Start a server that records what it receives and answers as scripted:
 * an HTTP(S) collector, or a raw TCP or UDP sink (a syslog or SIEM receiver,
 * say). Unscripted HTTP requests get 200; tcp and udp messages are accepted
 * and never answered. Each tcp `data` chunk and each udp datagram is one record.
 */
export async function startCaptureServer(options: CaptureServerOptions): Promise<CaptureServer> {
  const { kind } = options
  if (options.tls !== undefined && kind !== 'https') {
    throw new Error(`tls is only for kind 'https', not '${kind}'`)
  }
  const requested = resolvePort(options)
  let recorded: CapturedRequest[] = []
  let rules: ActiveRule[] = []
  let boundPort = requested
  let tmpDir: string | undefined
  let ca: string | undefined
  let tlsMaterial: { cert: string; key: string } | undefined
  if (kind === 'https') {
    if (options.tls === 'self-signed' || options.tls === undefined) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-capture-'))
      tlsMaterial = selfSigned(tmpDir)
      ca = tlsMaterial.cert
    } else {
      tlsMaterial = options.tls
    }
  }

  const answer = (entry: CapturedRequest): Reply => {
    for (const rule of rules) {
      if (rule.queue.length === 0 || !matches(entry, rule.match)) continue
      const reply = rule.queue[0]
      if (!rule.repeat) rule.queue.shift()
      return reply
    }
    return { status: 200 }
  }

  const onHttp = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (d: Buffer) => chunks.push(d))
    req.on('end', () => {
      const entry = record(req, Buffer.concat(chunks))
      recorded.push(entry)
      const reply = answer(entry)
      res.writeHead(reply.status, reply.headers)
      res.end(reply.body)
    })
  }

  const sockets = new Set<net.Socket>()
  let server: http.Server | https.Server | net.Server | undefined
  let udp: dgram.Socket | undefined

  const listen = async (): Promise<void> => {
    if (kind === 'udp') {
      const s = dgram.createSocket('udp4')
      s.on('message', (msg) => {
        recorded.push({ at: new Date(), body: msg, text: msg.toString('utf-8') })
      })
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject)
        s.bind(boundPort, HOST, resolve)
      })
      boundPort = s.address().port
      udp = s
      return
    }
    let s: http.Server | https.Server | net.Server
    if (kind === 'http') s = http.createServer(onHttp)
    else if (kind === 'https') {
      s = https.createServer({ ...tlsMaterial, minVersion: 'TLSv1.2' }, onHttp)
      s.on('tlsClientError', () => undefined)
    } else {
      s = net.createServer((socket) => {
        socket.on('data', (d: Buffer) => {
          recorded.push({ at: new Date(), body: d, text: d.toString('utf-8') })
        })
        socket.on('error', () => undefined)
      })
    }
    // Raw sockets, so a connection mid-handshake can't hold close() open.
    s.on('connection', (socket: net.Socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject)
      s.listen(boundPort, HOST, resolve)
    })
    boundPort = (s.address() as net.AddressInfo).port
    server = s
  }

  const unlisten = async (): Promise<void> => {
    const s = server
    const u = udp
    server = undefined
    udp = undefined
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
    if (u) await new Promise<void>((resolve) => u.close(() => resolve()))
  }

  await listen()
  const scheme = kind
  let stopped = false

  return {
    get url() {
      return `${scheme}://${HOST}:${boundPort}`
    },
    get port() {
      return boundPort
    },
    ca,
    requests: (filter) => recorded.filter((r) => matches(r, filter)),
    reset() {
      recorded = []
      rules = []
    },
    script(rule) {
      if (kind === 'udp' || kind === 'tcp') {
        throw new Error(`script() answers http and https requests; a ${kind} server never replies`)
      }
      const queue = toReplies(rule.respond)
      const repeat = !Array.isArray(rule.respond) && !rule.once
      rules.push({ match: rule.match, queue: rule.once ? queue.slice(0, 1) : queue, repeat })
    },
    async down() {
      await unlisten()
    },
    async up() {
      if (!server && !udp && !stopped) await listen()
    },
    async stop() {
      stopped = true
      await unlisten()
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    },
  }
}
