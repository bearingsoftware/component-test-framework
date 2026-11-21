import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createHash,
  generateKeyPair,
  randomBytes,
  sign,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto'
import { promisify } from 'node:util'

const generateKeyPairAsync = promisify(generateKeyPair)

/** A user the issuer can sign in. */
export interface OidcUser {
  sub: string
  email: string
  name?: string
  groups?: string[]
  /** Extra claims for the ID token and `/userinfo`. They win over the fields above. */
  claims?: Record<string, unknown>
}

/** A relying party. Without any `clients`, the issuer accepts every client and redirect URI. */
export interface OidcClient {
  id: string
  /** Checked at `/token` when set; a client without one is public. */
  secret?: string
  redirectUris: string[]
}

export interface OidcIssuerOptions {
  /** 0 (the default) takes an ephemeral port. */
  port?: number
  /** An environment variable holding the port, used when `port` isn't set. */
  portEnv?: string
  /** A path under the host that the issuer's URL carries, such as `/realms/test`. Default none. */
  issuerPath?: string
  users: OidcUser[]
  clients?: OidcClient[]
}

export interface OidcIssuer {
  /** The `iss` claim and discovery base: `url` plus `issuerPath`. */
  readonly issuer: string
  /** `http://127.0.0.1:<port>` */
  readonly url: string
  readonly port: number
  /** Merge claims into a user's ID tokens and `/userinfo`, replacing any claim of the same name. */
  setClaims(sub: string, claims: Record<string, unknown>): void
  /** Sign with a new key from now on. Earlier keys stay in the JWKS, so tokens already issued still verify. */
  rotateKey(): Promise<void>
  stop(): Promise<void>
}

const HOST = '127.0.0.1'
const TOKEN_LIFETIME_S = 300

interface SigningKey {
  kid: string
  privateKey: KeyObject
  jwk: Record<string, unknown>
}

interface Grant {
  sub: string
  clientId: string
  nonce?: string
  challenge?: string
  redirectUri: string
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url')
const random = () => randomBytes(24).toString('base64url')

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

async function newKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPairAsync('rsa', { modulusLength: 2048 })
  const kid = `ctf-${randomBytes(6).toString('hex')}`
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function resolvePort(options: OidcIssuerOptions): number {
  if (options.port !== undefined) return options.port
  const fromEnv = options.portEnv ? process.env[options.portEnv] : undefined
  if (fromEnv === undefined || fromEnv === '') return 0
  const port = Number(fromEnv)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${options.portEnv} is "${fromEnv}", not a port number`)
  }
  return port
}

let latest: OidcIssuer | undefined

/** The issuer most recently started and not yet stopped, for the steps' default. */
export function latestOidcIssuer(): OidcIssuer | undefined {
  return latest
}

/**
 * Start an OpenID Connect issuer on 127.0.0.1 for a service under test to sign
 * users in against: discovery, JWKS, `/authorize` (no login page), `/token`
 * for the code and refresh grants, and `/userinfo`. ID tokens are RS256.
 */
export async function startOidcIssuer(options: OidcIssuerOptions): Promise<OidcIssuer> {
  if (options.users.length === 0) throw new Error('startOidcIssuer needs at least one user')
  const issuerPath = (options.issuerPath ?? '').replace(/\/+$/, '')
  if (issuerPath !== '' && !issuerPath.startsWith('/')) {
    throw new Error(`issuerPath "${issuerPath}" must start with "/"`)
  }
  const users = new Map(options.users.map((u) => [u.sub, structuredClone(u)]))
  const clients = options.clients
  const keys: SigningKey[] = [await newKey()]
  const codes = new Map<string, Grant>()
  const refreshTokens = new Map<string, Grant>()
  const accessTokens = new Map<string, string>()
  let issuer = ''

  const claimsFor = (user: OidcUser): Record<string, unknown> => ({
    sub: user.sub,
    email: user.email,
    email_verified: true,
    ...(user.name === undefined ? {} : { name: user.name }),
    ...(user.groups === undefined ? {} : { groups: user.groups }),
    ...user.claims,
  })

  const idToken = (user: OidcUser, grant: Grant, withNonce: boolean): string => {
    const key = keys[keys.length - 1]
    const now = Math.floor(Date.now() / 1000)
    const claims = {
      ...claimsFor(user),
      iss: issuer,
      aud: grant.clientId,
      iat: now,
      exp: now + TOKEN_LIFETIME_S,
      ...(withNonce && grant.nonce !== undefined ? { nonce: grant.nonce } : {}),
    }
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid }))
    const input = `${header}.${b64url(JSON.stringify(claims))}`
    return `${input}.${b64url(sign('RSA-SHA256', Buffer.from(input), key.privateKey))}`
  }

  const redirectError = (
    res: ServerResponse,
    redirect: URL,
    state: string | null,
    error: string,
  ) => {
    redirect.searchParams.set('error', error)
    if (state !== null) redirect.searchParams.set('state', state)
    res.writeHead(302, { Location: redirect.toString() })
    res.end()
  }

  const authorize = (url: URL, res: ServerResponse): void => {
    const q = url.searchParams
    const clientId = q.get('client_id') ?? ''
    const redirectUri = q.get('redirect_uri') ?? ''
    const client = clients?.find((c) => c.id === clientId)
    if (
      clients !== undefined &&
      (client === undefined || !client.redirectUris.includes(redirectUri))
    ) {
      json(res, 400, {
        error: 'invalid_request',
        error_description: 'unknown client or redirect_uri',
      })
      return
    }
    let redirect: URL
    try {
      redirect = new URL(redirectUri)
    } catch {
      json(res, 400, { error: 'invalid_request', error_description: 'redirect_uri is not a URL' })
      return
    }
    const state = q.get('state')
    if (q.get('response_type') !== 'code') {
      redirectError(res, redirect, state, 'unsupported_response_type')
      return
    }
    const challenge = q.get('code_challenge') ?? undefined
    if (challenge !== undefined && q.get('code_challenge_method') !== 'S256') {
      redirectError(res, redirect, state, 'invalid_request')
      return
    }
    const hint = q.get('login_hint')
    const all = [...users.values()]
    const user =
      hint !== null
        ? all.find((u) => u.sub === hint || u.email === hint)
        : all.length === 1
          ? all[0]
          : undefined
    if (user === undefined) {
      redirectError(res, redirect, state, 'access_denied')
      return
    }
    const code = random()
    codes.set(code, {
      sub: user.sub,
      clientId,
      redirectUri,
      challenge,
      nonce: q.get('nonce') ?? undefined,
    })
    redirect.searchParams.set('code', code)
    if (state !== null) redirect.searchParams.set('state', state)
    res.writeHead(302, { Location: redirect.toString() })
    res.end()
  }

  const authenticateClient = (req: IncomingMessage, form: URLSearchParams): string | null => {
    let id = form.get('client_id')
    let secret = form.get('client_secret')
    const basic = req.headers.authorization
    if (basic?.startsWith('Basic ')) {
      const decoded = Buffer.from(basic.slice(6), 'base64').toString()
      const colon = decoded.indexOf(':')
      id = decodeURIComponent(decoded.slice(0, colon))
      secret = decodeURIComponent(decoded.slice(colon + 1))
    }
    if (id === null) return null
    if (clients === undefined) return id
    const client = clients.find((c) => c.id === id)
    if (client === undefined) return null
    if (client.secret !== undefined && !safeEqual(secret ?? '', client.secret)) return null
    return id
  }

  const issue = (res: ServerResponse, user: OidcUser, grant: Grant, withNonce: boolean): void => {
    const access = random()
    accessTokens.set(access, user.sub)
    const refresh = random()
    refreshTokens.set(refresh, grant)
    json(res, 200, {
      access_token: access,
      token_type: 'Bearer',
      expires_in: TOKEN_LIFETIME_S,
      refresh_token: refresh,
      id_token: idToken(user, grant, withNonce),
    })
  }

  const token = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const form = new URLSearchParams(await readBody(req))
    const clientId = authenticateClient(req, form)
    if (clientId === null) {
      json(res, 401, { error: 'invalid_client' })
      return
    }
    const grantType = form.get('grant_type')
    if (grantType === 'authorization_code') {
      const code = form.get('code') ?? ''
      const grant = codes.get(code)
      codes.delete(code)
      if (
        grant === undefined ||
        grant.clientId !== clientId ||
        grant.redirectUri !== form.get('redirect_uri')
      ) {
        json(res, 400, { error: 'invalid_grant' })
        return
      }
      if (grant.challenge !== undefined) {
        const verifier = form.get('code_verifier') ?? ''
        const expected = b64url(createHash('sha256').update(verifier).digest())
        if (!safeEqual(expected, grant.challenge)) {
          json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
          return
        }
      }
      issue(res, users.get(grant.sub) as OidcUser, grant, true)
    } else if (grantType === 'refresh_token') {
      const old = form.get('refresh_token') ?? ''
      const grant = refreshTokens.get(old)
      refreshTokens.delete(old)
      if (grant === undefined || grant.clientId !== clientId) {
        json(res, 400, { error: 'invalid_grant' })
        return
      }
      issue(res, users.get(grant.sub) as OidcUser, grant, false)
    } else {
      json(res, 400, { error: 'unsupported_grant_type' })
    }
  }

  const userinfo = (req: IncomingMessage, res: ServerResponse): void => {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1]
    const sub = bearer === undefined ? undefined : accessTokens.get(bearer)
    const user = sub === undefined ? undefined : users.get(sub)
    if (user === undefined) {
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"')
      json(res, 401, { error: 'invalid_token' })
      return
    }
    json(res, 200, claimsFor(user))
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(issuerPath + '/')) {
      json(res, 404, { error: 'not_found' })
      return
    }
    const route = `${req.method ?? 'GET'} ${url.pathname.slice(issuerPath.length)}`
    switch (route) {
      case 'GET /.well-known/openid-configuration':
        json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          scopes_supported: ['openid', 'email', 'profile'],
        })
        return
      case 'GET /jwks':
        json(res, 200, { keys: keys.map((k) => k.jwk) })
        return
      case 'GET /authorize':
        authorize(url, res)
        return
      case 'POST /token':
        token(req, res).catch(() => {
          json(res, 500, { error: 'server_error' })
        })
        return
      case 'GET /userinfo':
      case 'POST /userinfo':
        userinfo(req, res)
        return
      default:
        json(res, 404, { error: 'not_found' })
    }
  }

  const server: Server = createServer(handle)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(resolvePort(options), HOST, resolve)
  })
  const port = (server.address() as AddressInfo).port
  const url = `http://${HOST}:${String(port)}`
  issuer = url + issuerPath

  const running: OidcIssuer = {
    issuer,
    url,
    port,
    setClaims(sub, claims) {
      const user = users.get(sub)
      if (user === undefined) throw new Error(`no OIDC user with sub "${sub}"`)
      user.claims = { ...user.claims, ...claims }
    },
    async rotateKey() {
      keys.push(await newKey())
    },
    stop() {
      if (latest === running) latest = undefined
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
        server.closeAllConnections()
      })
    },
  }
  latest = running
  return running
}
