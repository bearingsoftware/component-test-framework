import { describe, it, expect, vi, afterEach } from 'vitest'

type StepFn = (this: unknown, ...args: unknown[]) => unknown
const steps = vi.hoisted(() => new Map<string, StepFn>())

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (expression: string, fn: StepFn) => steps.set(expression, fn)
  return { ...actual, Given: register, When: register, Then: register }
})

import { registerOidcSteps } from './oidc.steps'
import { startOidcIssuer, type OidcIssuer } from '../clients/oidc-issuer'

let issuer: OidcIssuer | undefined
afterEach(async () => {
  await issuer?.stop()
  issuer = undefined
})

const run = (expression: string, ...args: unknown[]) => steps.get(expression)?.apply({}, args)

describe('OIDC steps', () => {
  it('act on the latest issuer, and fail clearly when none runs', async () => {
    registerOidcSteps()
    registerOidcSteps()
    await expect(async () => run('the OIDC signing key is rotated')).rejects.toThrow(
      'no OIDC issuer',
    )
    issuer = await startOidcIssuer({ users: [{ sub: 'u1', email: 'a@example.test' }] })
    const keys = async () =>
      ((await (await fetch(`${issuer?.issuer}/jwks`)).json()) as { keys: unknown[] }).keys.length
    expect(await keys()).toBe(1)
    await run('the OIDC signing key is rotated')
    expect(await keys()).toBe(2)

    await run('the OIDC user {string} has groups {string}', 'u1', 'admins, ops')
    const res = await fetch(
      `${issuer.issuer}/authorize?response_type=code&client_id=c&redirect_uri=http://127.0.0.1:1/cb`,
      {
        redirect: 'manual',
      },
    )
    const code = new URL(res.headers.get('location') as string).searchParams.get('code') as string
    const token = (await (
      await fetch(`${issuer.issuer}/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'c',
          code,
          redirect_uri: 'http://127.0.0.1:1/cb',
        }),
      })
    ).json()) as { access_token: string }
    const info = (await (
      await fetch(`${issuer.issuer}/userinfo`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      })
    ).json()) as { groups: string[] }
    expect(info.groups).toEqual(['admins', 'ops'])
  })
})
