import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import type { AddressInfo } from 'net'
import type { IWorldOptions } from '@cucumber/cucumber'

// Capture step definitions by their expression so the tests can run the real
// step functions without a Cucumber runtime.
const steps = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (expression: string, fn: (...args: unknown[]) => unknown) => {
    steps.set(expression, fn)
  }
  return { ...actual, Given: register, When: register, Then: register }
})

import { ComponentTestWorld } from '../../support/world'
import './generic-api.steps'
import '../common/response-assertion.steps'

const run = (world: ComponentTestWorld, expression: string, ...args: unknown[]) => {
  const step = steps.get(expression)
  if (!step) throw new Error(`Step not registered: ${expression}`)
  return step.apply(world, args)
}

describe('operation steps keep response headers (COMPONENT-4)', () => {
  let server: http.Server
  let fixturesDir: string
  let apiBaseUrl: string

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'abc-123' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-fixtures-'))
    fs.mkdirSync(path.join(fixturesDir, 'requests'), { recursive: true })
    fs.writeFileSync(path.join(fixturesDir, 'requests', 'empty.json'), '{}')
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(fixturesDir, { recursive: true, force: true })
  })

  const makeWorld = (): ComponentTestWorld => {
    const world = new ComponentTestWorld({
      attach: vi.fn(),
      log: vi.fn(),
      link: vi.fn(),
      parameters: {},
    } as unknown as IWorldOptions)
    world.config = { apiBaseUrl, wiremockUrl: '', fixturesDir }
    world.operationMap = { getThing: { method: 'GET', path: '/thing' } }
    return world
  }

  it('records headers on lastResponse after an operation step', async () => {
    const world = makeWorld()

    await run(world, 'I send the request {word} to the {word} operation', 'empty', 'getThing')

    expect(world.lastResponse?.status).toBe(200)
    expect(world.lastResponse?.headers['x-request-id']).toBe('abc-123')
    expect(world.callHistory[0].response.headers?.['x-request-id']).toBe('abc-123')
  })

  it('lets the header assertion step pass after an operation step', async () => {
    const world = makeWorld()

    await run(world, 'I send the request {word} to the {word} operation', 'empty', 'getThing')

    expect(() =>
      run(
        world,
        'the response should contain header {word} with value {string}',
        'X-Request-Id',
        'abc-123',
      ),
    ).not.toThrow()
  })

  it('still counts calls', async () => {
    const world = makeWorld()

    await run(world, 'I send the request {word} to the {word} operation', 'empty', 'getThing')
    await run(world, 'I send the request {word} to the {word} operation', 'empty', 'getThing')

    expect(world.getCallCount('getThing', 'empty')).toBe(2)
  })
})
