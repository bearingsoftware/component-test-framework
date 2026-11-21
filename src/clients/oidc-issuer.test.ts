import { describe, it, expect, afterEach } from 'vitest'
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { startOidcIssuer, type OidcIssuer, type OidcIssuerOptions } from './oidc-issuer'

const REDIRECT = 'http://127.0.0.1:1/callback'
const USER = { sub: 'u1', email: 'u1@example.test', name: 'User One', groups: ['dev'] }

let running: OidcIssuer[] = []
afterEach(async () => {
  await Promise.all(running.map((i) => i.stop()))
  running = []
})

async function start(options: Partial<OidcIssuerOptions> = {}): Promise<OidcIssuer> {
  const issuer = await startOidcIssuer({ users: [USER], ...options })
  running.push(issuer)
  return issuer
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function authorize(issuer: OidcIssuer, params: Record<string, string>): Promise<URL> {
  const url = new URL(`${issuer.issuer}/authorize`)
  const all = { response_type: 'code', client_id: 'app', redirect_uri: REDIRECT, ...params }
  for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v)
  const res = await fetch(url, { redirect: 'manual' })
  expect(res.status).toBe(302)
  return new URL(res.headers.get('location') as string)
}

function tokenRequest(
  issuer: OidcIssuer,
  form: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return fetch(`${issuer.issuer}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ client_id: 'app', ...form }),
  })
}

interface Jwt {
  header: { alg: string; kid: string }
  claims: Record<string, unknown>
}

async function verifyJwt(issuer: OidcIssuer, jwt: string): Promise<Jwt> {
  const [h, p, s] = jwt.split('.')
  const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as Jwt['header']
  const jwks = (await (await fetch(`${issuer.issuer}/jwks`)).json()) as { keys: { kid: string }[] }
  const jwk = jwks.keys.find((k) => k.kid === header.kid)
  expect(jwk, `kid ${header.kid} in the JWKS`).toBeDefined()
  const key = createPublicKey({ key: jwk as never, format: 'jwk' })
  expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))).toBe(
    true,
  )
  return { header, claims: JSON.parse(Buffer.from(p, 'base64url').toString()) as Jwt['claims'] }
}

async function login(issuer: OidcIssuer, extra: Record<string, string> = {}) {
  const { verifier, challenge } = pkce()
  const back = await authorize(issuer, {
    state: 'st',
    nonce: 'n-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  })
  return { back, verifier }
}

describe('startOidcIssuer', () => {
  it('serves discovery whose URLs resolve under the issuer path', async () => {
    const issuer = await start({ issuerPath: '/realms/test' })
    expect(issuer.issuer).toBe(`${issuer.url}/realms/test`)
    const doc = (await (
      await fetch(`${issuer.issuer}/.well-known/openid-configuration`)
    ).json()) as Record<string, unknown>
    expect(doc).toMatchObject({
      issuer: issuer.issuer,
      jwks_uri: `${issuer.issuer}/jwks`,
      token_endpoint: `${issuer.issuer}/token`,
    })
    expect((await fetch(`${issuer.url}/jwks`)).status).toBe(404)
  })

  it('takes the port from portEnv, and 0 binds an ephemeral one', async () => {
    const first = await start()
    expect(first.port).toBeGreaterThan(0)
    process.env.CTF_TEST_OIDC_PORT = String(first.port)
    await first.stop()
    const again = await start({ portEnv: 'CTF_TEST_OIDC_PORT' })
    expect(again.port).toBe(first.port)
    process.env.CTF_TEST_OIDC_PORT = 'nope'
    await expect(startOidcIssuer({ users: [USER], portEnv: 'CTF_TEST_OIDC_PORT' })).rejects.toThrow(
      'not a port',
    )
    delete process.env.CTF_TEST_OIDC_PORT
  })

  it('runs the code + PKCE flow with a signed id_token, echoing state and nonce', async () => {
    const issuer = await start()
    const { back, verifier } = await login(issuer)
    expect(back.searchParams.get('state')).toBe('st')
    const res = await tokenRequest(issuer, {
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') as string,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    const { header, claims } = await verifyJwt(issuer, body.id_token)
    expect(header.alg).toBe('RS256')
    expect(claims.nbf).toBe(claims.iat)
    expect(claims).toMatchObject({
      iss: issuer.issuer,
      aud: 'app',
      azp: 'app',
      sub: 'u1',
      email: 'u1@example.test',
      name: 'User One',
      groups: ['dev'],
      nonce: 'n-1',
    })
    const info = await fetch(`${issuer.issuer}/userinfo`, {
      headers: { Authorization: `Bearer ${body.access_token}` },
    })
    expect(await info.json()).toMatchObject({ sub: 'u1', email: 'u1@example.test' })
    expect((await fetch(`${issuer.issuer}/userinfo`)).status).toBe(401)
  })

  it('rejects a wrong PKCE verifier, and a code used twice', async () => {
    const issuer = await start()
    const { back, verifier } = await login(issuer)
    const code = back.searchParams.get('code') as string
    const bad = await tokenRequest(issuer, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: pkce().verifier,
    })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'invalid_grant' })
    const reuse = await tokenRequest(issuer, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    })
    expect(reuse.status).toBe(400)
  })

  it('refuses a challenge method other than S256', async () => {
    const issuer = await start()
    const back = await authorize(issuer, { code_challenge: 'x', code_challenge_method: 'plain' })
    expect(back.searchParams.get('error')).toBe('invalid_request')
  })

  it('rotation signs with a new kid and keeps the old key verifying', async () => {
    const issuer = await start()
    const exchange = async () => {
      const { back, verifier } = await login(issuer)
      const res = await tokenRequest(issuer, {
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') as string,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      })
      return ((await res.json()) as { id_token: string }).id_token
    }
    const before = await exchange()
    await issuer.rotateKey()
    const after = await exchange()
    expect((await verifyJwt(issuer, before)).header.kid).not.toBe(
      (await verifyJwt(issuer, after)).header.kid,
    )
  })

  it('refreshes, rotating the refresh token, and drops the nonce', async () => {
    const issuer = await start()
    const { back, verifier } = await login(issuer)
    const first = (await (
      await tokenRequest(issuer, {
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') as string,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      })
    ).json()) as Record<string, string>
    const res = await tokenRequest(issuer, {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
    })
    expect(res.status).toBe(200)
    const next = (await res.json()) as Record<string, string>
    expect(next.refresh_token).not.toBe(first.refresh_token)
    expect((await verifyJwt(issuer, next.id_token)).claims).not.toHaveProperty('nonce')
    expect(
      (
        await tokenRequest(issuer, {
          grant_type: 'refresh_token',
          refresh_token: first.refresh_token,
        })
      ).status,
    ).toBe(400)
  })

  it('setClaims changes the next token; an unknown sub throws', async () => {
    const issuer = await start()
    issuer.setClaims('u1', { groups: ['admins', 'ops'], tenant: 't9' })
    expect(() => issuer.setClaims('nobody', {})).toThrow('no OIDC user')
    const { back, verifier } = await login(issuer)
    const body = (await (
      await tokenRequest(issuer, {
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') as string,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      })
    ).json()) as { id_token: string }
    expect((await verifyJwt(issuer, body.id_token)).claims).toMatchObject({
      groups: ['admins', 'ops'],
      tenant: 't9',
    })
  })

  it('picks the user by login_hint, and denies when several users and no hint', async () => {
    const issuer = await start({ users: [USER, { sub: 'u2', email: 'u2@example.test' }] })
    expect(
      (await authorize(issuer, { login_hint: 'u2@example.test' })).searchParams.get('code'),
    ).toBeTruthy()
    expect((await authorize(issuer, { login_hint: 'u2' })).searchParams.get('code')).toBeTruthy()
    expect((await authorize(issuer, {})).searchParams.get('error')).toBe('access_denied')
    expect((await authorize(issuer, { login_hint: 'ghost' })).searchParams.get('error')).toBe(
      'access_denied',
    )
  })

  it('checks configured clients: redirect URI, secret by basic auth or body', async () => {
    const issuer = await start({ clients: [{ id: 'app', secret: 's3', redirectUris: [REDIRECT] }] })
    const bad = await fetch(
      `${issuer.issuer}/authorize?response_type=code&client_id=app&redirect_uri=http://evil.test/`,
      {
        redirect: 'manual',
      },
    )
    expect(bad.status).toBe(400)
    const code = async () => (await authorize(issuer, {})).searchParams.get('code') as string
    const grant = (c: string) => ({
      grant_type: 'authorization_code',
      code: c,
      redirect_uri: REDIRECT,
    })
    expect((await tokenRequest(issuer, grant(await code()))).status).toBe(401)
    expect(
      (await tokenRequest(issuer, { ...grant(await code()), client_secret: 's3' })).status,
    ).toBe(200)
    const basic = 'Basic ' + Buffer.from('app:s3').toString('base64')
    expect((await tokenRequest(issuer, grant(await code()), { Authorization: basic })).status).toBe(
      200,
    )
  })

  it('rejects a Basic credential without a colon as invalid_client', async () => {
    const issuer = await start()
    const res = await tokenRequest(
      issuer,
      { grant_type: 'authorization_code', code: 'x' },
      { Authorization: 'Basic ' + Buffer.from('app').toString('base64') },
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'invalid_client' })
  })

  it('needs a user', async () => {
    await expect(startOidcIssuer({ users: [] })).rejects.toThrow('at least one user')
  })
})
