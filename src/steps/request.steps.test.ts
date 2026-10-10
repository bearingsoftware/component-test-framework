import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import type { AddressInfo } from 'net'
import type { IWorldOptions } from '@cucumber/cucumber'

type Fn = (this: unknown, ...args: unknown[]) => unknown

// Capture step definitions (by expression, or by regex source) and Before
// hooks, so the real steps run without a Cucumber runtime.
const registry = vi.hoisted(() => ({
  steps: new Map<string, Fn>(),
  regexSteps: [] as { pattern: RegExp; fn: Fn }[],
  before: [] as { tags?: string; fn: Fn }[],
}))

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (expression: string | RegExp, optionsOrFn: unknown, maybeFn?: Fn) => {
    const fn = (typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn) as Fn
    if (expression instanceof RegExp) registry.regexSteps.push({ pattern: expression, fn })
    else registry.steps.set(expression, fn)
  }
  const before = (optionsOrFn: { tags?: string } | Fn, maybeFn?: Fn) => {
    if (typeof optionsOrFn === 'function') registry.before.push({ fn: optionsOrFn })
    else registry.before.push({ tags: optionsOrFn.tags, fn: maybeFn as Fn })
  }
  return { ...actual, Given: register, When: register, Then: register, Before: before }
})

import { ComponentTestWorld } from '../support/world'
import { sendOperation } from '../support/requests'
import { jwtClaims, registerLoginTag } from '../support/auth'
import { signHS256 } from '../utils/jwt'
import './api/generic-api.steps'
import { registerRequestSteps } from './request.steps'

interface Received {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

const ACCESS = signHS256({ sub: 'u1', tier: 'beta', hid: 'h-1' }, 'secret')

// A small API: login returns a token in `token` (as secure-repo's does) or
// `access_token` (as joule-genie's does), and every other route echoes the
// request back.
describe('requests, values and auth (COMPONENT-7)', () => {
  let server: http.Server
  let apiBaseUrl: string
  let fixturesDir: string
  let received: Received[]
  let logins: number

  const world = (auth: ComponentTestWorld['config']['auth'] = {}) => {
    const w = new ComponentTestWorld({
      attach: vi.fn(),
      log: vi.fn(),
      link: vi.fn(),
      parameters: {},
    } as unknown as IWorldOptions)
    w.config = { apiBaseUrl, wiremockUrl: '', fixturesDir, auth }
    w.operationMap = {
      getScan: { method: 'GET', path: '/orgs/{oid}/scans/{sid}' },
      createThing: { method: 'POST', path: '/things' },
      getThing: { method: 'GET', path: '/things/{id}' },
      issueTokens: { method: 'POST', path: '/tokens' },
    }
    return w
  }

  const run = (w: ComponentTestWorld, text: string, ...args: unknown[]) => {
    const step = registry.steps.get(text)
    if (!step) throw new Error(`Step not registered: ${text}`)
    return step.apply(w, args)
  }

  /** Run a regex step by matching a whole step line, as Cucumber would. */
  const runLine = (w: ComponentTestWorld, line: string) => {
    const matches = registry.regexSteps.filter(({ pattern }) => pattern.test(line))
    if (matches.length !== 1) throw new Error(`${matches.length} regex steps match: ${line}`)
    const args = line.match(matches[0].pattern)!.slice(1)
    return matches[0].fn.apply(w, args)
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
        const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
          res.end(JSON.stringify(payload))
        }
        if (req.url === '/login' || req.url === '/auth/login') {
          logins++
          const { password } = JSON.parse(body) as { password: string }
          if (password !== 'right') return json(401, { error: 'bad credentials' })
          return req.url === '/login'
            ? json(200, { token: ACCESS, user: { id: 7 } })
            : json(200, { access_token: ACCESS, refresh_token: 'r-1' })
        }
        if (req.url === '/tokens') return json(201, { access_token: 'a-2', refresh_token: 'r-2' })
        if (req.method === 'POST' && req.url === '/things')
          return json(201, { id: 42, nested: { items: [{ id: 'n-1' }] } })
        json(200, { id: 99, url: req.url, list: [1, 2], empty: [] }, { 'X-Trace': 'abc-123' })
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-requests-'))
    fs.mkdirSync(path.join(fixturesDir, 'requests'))
    fs.writeFileSync(
      path.join(fixturesDir, 'requests', 'scan.json'),
      JSON.stringify({
        _pathParams: { oid: 'from-fixture', sid: 's-1' },
        _queryParams: { page: '2' },
      }),
    )
    fs.writeFileSync(
      path.join(fixturesDir, 'requests', 'thing.json'),
      JSON.stringify({ name: 'widget' }),
    )

    registerRequestSteps()
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(fixturesDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    received = []
    logins = 0
  })

  describe('sendOperation', () => {
    it('fills every placeholder, with explicit values winning over the fixture', async () => {
      const w = world()
      w.accessToken = 'tok'
      await sendOperation(w, 'getScan', {
        requestFile: 'scan',
        pathParams: { oid: 'org 1' },
        queryParams: { size: '10' },
        headers: { 'X-Extra': 'yes' },
      })

      expect(received[0].url).toBe('/orgs/org%201/scans/s-1?page=2&size=10')
      expect(received[0].headers).toMatchObject({ authorization: 'Bearer tok', 'x-extra': 'yes' })
      expect(w.lastResponse?.headers['x-trace']).toBe('abc-123')
      expect(w.getCallCount('getScan', 'scan')).toBe(1)
    })

    it('sends a raw body with its own content type, and no token when asked', async () => {
      const w = world()
      w.accessToken = 'tok'
      await sendOperation(w, 'createThing', {
        rawBody: '{not json',
        contentType: 'text/plain',
        auth: 'none',
      })

      expect(received[0].body).toBe('{not json')
      expect(received[0].headers['content-type']).toBe('text/plain')
      expect(received[0].headers.authorization).toBeUndefined()
    })

    it('treats _empty as no fixture', async () => {
      await sendOperation(world(), 'createThing', {
        requestFile: '_empty',
        auth: { token: 'other' },
      })
      expect(received[0].body).toBe('{}')
      expect(received[0].headers.authorization).toBe('Bearer other')
    })
  })

  describe('world values', () => {
    it('remembers and recalls values, and names what it has when asked for something else', () => {
      const w = world()
      w.remember('org', 5)
      expect(w.recall('org')).toBe(5)
      expect(() => w.recall('scan')).toThrow('Nothing remembered as "scan". Remembered: org')
    })

    it('gives a stable unique id per name within a scenario, and new ones after a reset', () => {
      const w = world()
      const first = w.uniqueId('owner')
      expect(first).toMatch(/^owner-[a-z0-9]+$/)
      expect(w.uniqueId('owner')).toBe(first)
      expect(w.uniqueId('admin')).not.toBe(first)
      w.resetScenario()
      expect(w.uniqueId('owner')).not.toBe(first)
      expect(() => w.recall('anything')).toThrow()
    })
  })

  describe('opt-in steps', () => {
    it('are registered once, and ignore a second registration', () => {
      const before = registry.steps.get('I capture the id as {word}')
      registerRequestSteps()
      expect(registry.steps.get('I capture the id as {word}')).toBe(before)
    })

    it('capture values from the last response and use them in later requests', async () => {
      const w = world()
      await sendOperation(w, 'createThing', { requestFile: 'thing' })
      await run(w, 'I capture the id as {word}', 'thing')
      await run(
        w,
        'I capture {word} from the last response as {word}',
        'nested.items[0].id',
        'child',
      )

      await run(
        w,
        'I send the request {word} to the {word} operation with {word} saved as {word}',
        'scan',
        'getScan',
        'oid',
        'child',
      )
      expect(received.at(-1)?.url).toBe('/orgs/n-1/scans/s-1?page=2')

      await run(
        w,
        'I send the request {word} to the {word} operation with saved id {word}',
        '_empty',
        'getThing',
        'thing',
      )
      expect(received.at(-1)?.url).toBe('/things/42')
    })

    it('fill any placeholder from the last response id, but leave "with id" to the existing step', async () => {
      const w = world()
      await sendOperation(w, 'createThing', { requestFile: 'thing' })

      await runLine(
        w,
        'I send the request scan to the getScan operation with sid from last response',
      )
      expect(received.at(-1)?.url).toBe('/orgs/from-fixture/scans/42?page=2')

      expect(() =>
        runLine(w, 'I send the request scan to the getThing operation with id from last response'),
      ).toThrow('0 regex steps match')
      expect(
        registry.steps.has(
          'I send the request {word} to the {word} operation with id from last response',
        ),
      ).toBe(true)
    })

    it('combine a saved value with the last response id', async () => {
      const w = world()
      w.remember('org', 'o-9')
      await sendOperation(w, 'createThing', { requestFile: 'thing' })
      await run(
        w,
        'I send the request {word} to the {word} operation with {word} {word} and {word} from last response',
        'scan',
        'getScan',
        'oid',
        'org',
        'sid',
      )
      expect(received.at(-1)?.url).toBe('/orgs/o-9/scans/42?page=2')
    })

    it('send an authed raw request', async () => {
      const w = world()
      w.accessToken = 'tok'
      await run(
        w,
        'I send an authed {word} to {string} with body {string}',
        'post',
        '/raw',
        '{"a":1}',
      )
      expect(received[0]).toMatchObject({ method: 'POST', body: '{"a":1}' })
      expect(received[0].headers.authorization).toBe('Bearer tok')
    })
  })

  describe('authentication', () => {
    it('logs in with a configured login path, body and token path', async () => {
      const w = world({
        loginPath: '/login',
        tokenPath: 'token',
        loginBody: (u, p) => ({ user: u, password: p }),
      })
      await run(w, 'I log in as {string} with password {string}', 'a@example.com', 'right')

      expect(JSON.parse(received[0].body)).toEqual({ user: 'a@example.com', password: 'right' })
      expect(w.accessToken).toBe(ACCESS)
      expect(w.lastResponse).toBeNull()
    })

    it('fails a login that is refused', async () => {
      const w = world({ loginPath: '/login', tokenPath: 'token' })
      await expect(
        run(w, 'I log in as {string} with password {string}', 'a@example.com', 'wrong'),
      ).rejects.toThrow(/login as a@example.com failed: 401/)
    })

    it('records a refused login attempt without failing', async () => {
      const w = world({ loginPath: '/login' })
      await run(
        w,
        'I attempt to log in as {string} with password {string}',
        'a@example.com',
        'wrong',
      )
      expect(w.lastResponse).toMatchObject({ status: 401, body: { error: 'bad credentials' } })
      expect(w.accessToken).toBeNull()
    })

    it('says what to configure when there is no login path', async () => {
      await expect(
        run(world(), 'I log in as {string} with password {string}', 'a', 'right'),
      ).rejects.toThrow(/auth.loginPath is not configured/)
    })

    it('remembers tokens by name and switches back to them', async () => {
      const w = world()
      w.accessToken = 'leaver'
      await run(w, 'I remember the current token as {word}', 'leaver')
      w.accessToken = 'admin'
      await run(w, 'I use the remembered token {word}', 'leaver')
      expect(w.accessToken).toBe('leaver')
    })

    it('adopts the token pair from the last response', async () => {
      const w = world()
      await sendOperation(w, 'issueTokens')
      await run(w, 'I adopt the tokens from the last response')
      expect([w.accessToken, w.refreshToken]).toEqual(['a-2', 'r-2'])
    })

    it('reads tokens for the existing authenticate step from the configured path', async () => {
      const w = world({ tokenPath: 'token' })
      fs.writeFileSync(
        path.join(fixturesDir, 'requests', 'creds.json'),
        JSON.stringify({ password: 'right' }),
      )
      w.operationMap.login = { method: 'POST', path: '/login' }
      await run(
        w,
        'I authenticate with the request {word} to the {word} operation',
        'creds',
        'login',
      )
      expect(w.accessToken).toBe(ACCESS)
    })

    it('decodes JWT claims and asserts on them', async () => {
      expect(jwtClaims(ACCESS)).toMatchObject({ tier: 'beta', hid: 'h-1' })

      const w = world({ loginPath: '/auth/login' })
      await run(
        w,
        'I attempt to log in as {string} with password {string}',
        'a@example.com',
        'right',
      )
      await run(
        w,
        'the token at {word} in the response has claim {word} equal to {string}',
        'access_token',
        'tier',
        'beta',
      )
      expect(() =>
        run(
          w,
          'the token at {word} in the response has claim {word} equal to {string}',
          'access_token',
          'tier',
          'pro',
        ),
      ).toThrow('token claim tier = "beta", want "pro"')
    })
  })

  describe('registerLoginTag', () => {
    const hookFor = (tag: string) => {
      const hook = registry.before.find((h) => h.tags === tag)
      if (!hook) throw new Error(`no Before hook for ${tag}`)
      return hook.fn
    }

    it('seeds, then logs in, before each tagged scenario', async () => {
      const seeded: string[] = []
      registerLoginTag('@as-owner', {
        before: (w) => void seeded.push(w.uniqueId('owner')),
        credentials: (w) => ({ username: `${w.uniqueId('owner')}@example.com`, password: 'right' }),
      })
      const w = world({ loginPath: '/auth/login' })
      await hookFor('@as-owner').call(w)

      expect(seeded).toEqual([w.uniqueId('owner')])
      expect(JSON.parse(received[0].body).email).toBe(`${w.uniqueId('owner')}@example.com`)
      expect([w.accessToken, w.refreshToken]).toEqual([ACCESS, 'r-1'])
    })

    it('reuses the first login when asked to cache', async () => {
      registerLoginTag('@cached', {
        credentials: { username: 'c@example.com', password: 'right' },
        cache: true,
      })
      for (let i = 0; i < 3; i++) {
        const w = world({ loginPath: '/auth/login' })
        await hookFor('@cached').call(w)
        expect(w.accessToken).toBe(ACCESS)
      }
      expect(logins).toBe(1)
    })

    it('names the tag when its login fails', async () => {
      registerLoginTag('@broken', { credentials: { username: 'b@example.com', password: 'wrong' } })
      await expect(hookFor('@broken').call(world({ loginPath: '/auth/login' }))).rejects.toThrow(
        /^@broken: login as b@example.com failed: 401/,
      )
    })
  })

  describe('response assertions', () => {
    const responded = (body: unknown, headers: Record<string, string> = {}) => {
      const w = world()
      w.lastResponse = { status: 200, body, headers }
      return w
    }

    it('check text in the body', () => {
      const w = responded({ message: 'hello world' })
      run(w, 'the response body contains {string}', 'hello')
      expect(() => run(w, 'the response body contains {string}', 'bye')).toThrow(/lacks "bye"/)
      run(w, 'the response body does not contain {string}', 'bye')
      expect(() => run(w, 'the response body does not contain {string}', 'world')).toThrow(
        /contains "world"/,
      )
    })

    it('check part of a header', () => {
      const w = responded({}, { 'x-cache': 'HIT from edge' })
      run(w, 'the response header {word} contains {string}', 'X-Cache', 'HIT')
      expect(() =>
        run(w, 'the response header {word} contains {string}', 'X-Missing', 'x'),
      ).toThrow(/header X-Missing = undefined/)
    })

    it('check for non-empty values, including nested ones', () => {
      const w = responded({ token: 'abc', user: { name: '' }, list: [], obj: {} })
      run(w, 'the response body at {word} should be a non-empty string', 'token')
      expect(() =>
        run(w, 'the response body at {word} should be a non-empty string', 'user.name'),
      ).toThrow()
      run(w, 'the response body at {word} should not be empty', 'token')
      for (const empty of ['list', 'obj', 'user.name', 'missing']) {
        expect(() => run(w, 'the response body at {word} should not be empty', empty)).toThrow(
          /expected non-empty/,
        )
      }
    })

    it('count items in a root array, and check a key is absent', () => {
      run(responded([1, 2, 3]), 'the response body should contain {int} items', 3)
      expect(() => run(responded({}), 'the response body should contain {int} items', 0)).toThrow(
        /expected array/,
      )
      run(responded({ a: 1 }), 'the response body should not have {word}', 'b')
      expect(() =>
        run(responded({ a: 1 }), 'the response body should not have {word}', 'a'),
      ).toThrow('expected no a, got 1')
    })

    it('dump the last response to stderr', () => {
      const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      try {
        run(responded({ ok: true }), 'I dump the last response')
        expect(write).toHaveBeenCalledWith('DEBUG: status=200 body={"ok":true}\n')
      } finally {
        write.mockRestore()
      }
    })
  })
})
