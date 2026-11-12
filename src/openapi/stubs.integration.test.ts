import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WireMockClient } from '../clients/wiremock-client'
import { generateStubs } from './stubs'

// Against a real WireMock; skipped without WIREMOCK_URL. The stubs load under
// a per-run namespace, so other test files' stubs aren't reset.
const url = process.env.WIREMOCK_URL ?? ''
const NS = `/__stubs-it-${randomUUID().slice(0, 8)}`
const pets = path.join(__dirname, '__fixtures__', 'stubs', 'pets.yaml')

describe.skipIf(!url)('ctf stubs against WireMock (COMPONENT-26)', () => {
  const client = new WireMockClient(url, undefined, { namespace: NS })
  const call = (method: string, route: string) => fetch(`${url}${NS}${route}`, { method })

  const load = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-stubs-it-'))
    for (const { file, mapping } of generateStubs(pets, { allStatuses: true }).mappings) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      fs.writeFileSync(path.join(dir, file), JSON.stringify(mapping))
    }
    await client.loadMappingsFromDir(dir)
  }
  beforeAll(load)
  afterAll(() => client.resetAll())

  it('matches a path parameter with urlPathTemplate, and answers with the example', async () => {
    for (const id of ['1', 'abc', '42']) {
      const res = await call('GET', `/api/pets/${id}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(await res.json()).toEqual({ id: 7, name: 'Fido' })
    }
  })

  it('answers each operation with its example, by method', async () => {
    const list = await call('GET', '/api/pets')
    expect(await list.json()).toEqual([
      { id: 1, name: 'Rex', tag: 'dog' },
      { id: 2, name: 'Tom', tag: null },
    ])
    const created = await call('POST', '/api/pets')
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ id: 3, name: 'Kit' })
    const deleted = await call('DELETE', '/api/pets/42')
    expect(deleted.status).toBe(204)
    expect(await deleted.text()).toBe('')
    expect(await (await call('GET', '/api/tree')).json()).toEqual({
      value: 'root',
      children: [{ value: 'leaf' }],
    })
  })

  it('does not match another path shape, another method, or a skipped operation', async () => {
    expect((await call('GET', '/api/pets/1/2/3')).status).toBe(404)
    expect((await call('PUT', '/api/pets/1')).status).toBe(404)
    // listToys has no example, so it has no stub.
    expect((await call('GET', '/api/pets/1/toys')).status).toBe(404)
  })

  it('serves null and false examples as bodies, not empty ones', async () => {
    const nothing = await call('GET', '/api/nothing')
    expect(nothing.headers.get('content-type')).toContain('application/json')
    expect(await nothing.text()).toBe('null')
    expect(await (await call('GET', '/api/flag')).text()).toBe('false')
  })

  it('answers /pets/mine with its own example whichever order the stubs load in', async () => {
    const { mappings } = generateStubs(pets)
    const pick = (name: string) =>
      mappings.find((m) => m.file === `mappings/${name}.json`)?.mapping as Record<string, unknown>
    for (const order of [
      ['getMine', 'getPet'],
      ['getPet', 'getMine'],
    ]) {
      await client.resetAll()
      await client.importStubs(order.map(pick))
      expect(await (await call('GET', '/api/pets/mine')).json()).toEqual({ id: 99, name: 'Mine' })
      expect(await (await call('GET', '/api/pets/5')).json()).toEqual({ id: 7, name: 'Fido' })
    }
    // Back to the full set for the tests after this one.
    await client.resetAll()
    await load()
  })

  it('loses to a hand-written stub at the default priority, even on a deep path', async () => {
    const spec = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-stubs-it-')), 'deep.yaml')
    fs.writeFileSync(
      spec,
      `openapi: 3.0.3
paths:
  /a/b/c/d/{id}:
    get:
      operationId: deep
      responses:
        '200':
          description: ok
          content: { application/json: { schema: { type: object }, example: { from: spec } } }
`,
    )
    const [{ mapping }] = generateStubs(spec).mappings
    const mine = {
      request: { method: 'GET', urlPath: '/a/b/c/d/1' },
      response: { status: 200, jsonBody: { from: 'mine' } },
    }
    for (const order of [
      [mapping, mine],
      [mine, mapping],
    ]) {
      await client.resetAll()
      await client.importStubs(order as Record<string, unknown>[])
      expect(await (await call('GET', '/a/b/c/d/1')).json()).toEqual({ from: 'mine' })
      expect(await (await call('GET', '/a/b/c/d/2')).json()).toEqual({ from: 'spec' })
    }
    await client.resetAll()
    await load()
  })

  it('keeps the lower-priority status stubs from shadowing the 2xx', async () => {
    expect((await call('GET', '/api/pets/9')).status).toBe(200)
  })
})
