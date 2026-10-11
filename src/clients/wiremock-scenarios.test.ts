import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { WireMockClient, namespaceScenarioName, namespaceStub } from './wiremock-client'

interface Scenario {
  state: string
  possibleStates: string[]
}

// A stand-in for WireMock 3.9's scenario admin API. Like WireMock, it takes
// the scenario name from the URL as it is, without decoding it.
describe('WireMock scenarios (COMPONENT-14)', () => {
  let server: http.Server
  let baseUrl: string
  let scenarios: Map<string, Scenario>
  let puts: string[]

  const answer = (res: http.ServerResponse, status: number, body: unknown = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        const url = req.url ?? ''
        if (req.method === 'GET' && url === '/__admin/scenarios') {
          return answer(res, 200, {
            scenarios: [...scenarios].map(([name, s]) => ({ id: name, name, ...s })),
          })
        }
        if (req.method === 'POST' && url === '/__admin/scenarios/reset') {
          for (const s of scenarios.values()) s.state = 'Started'
          return answer(res, 200)
        }
        const put = /^\/__admin\/scenarios\/([^/]+)\/state$/.exec(url)
        if (req.method === 'PUT' && put) {
          puts.push(put[1])
          const scenario = scenarios.get(put[1])
          if (!scenario) return answer(res, 404, { errors: [{ title: 'does not exist' }] })
          const state = raw ? (JSON.parse(raw) as { state: string }).state : 'Started'
          if (!scenario.possibleStates.includes(state)) {
            return answer(res, 422, { errors: [{ title: 'does not support state' }] })
          }
          scenario.state = state
          return answer(res, 200)
        }
        answer(res, 404)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  beforeEach(() => {
    puts = []
    scenarios = new Map([
      ['recovery', { state: 'Started', possibleStates: ['Started', 'failing', 'recovered'] }],
      [
        namespaceScenarioName('recovery', '/__worker-1'),
        { state: 'Started', possibleStates: ['Started', 'recovered'] },
      ],
      [
        namespaceScenarioName('recovery', '/__worker-2'),
        { state: 'Started', possibleStates: ['Started', 'recovered'] },
      ],
      [
        namespaceScenarioName('pay day', '/__worker-2'),
        { state: 'Started', possibleStates: ['Started', 'paid'] },
      ],
    ])
  })

  it('names a namespaced scenario so it needs no encoding and reads back', () => {
    expect(namespaceScenarioName('recovery', '/__worker-2')).toBe('~2F__worker-2:recovery')
    expect(namespaceScenarioName('pay day', '/__worker-2')).toBe('~2F__worker-2:pay~20day')
    expect(namespaceScenarioName('café', '/__worker-2')).toBe('~2F__worker-2:caf~C3~A9')
    expect(namespaceStub({ scenarioName: 'pay day' }, '/__worker-2').scenarioName).toBe(
      '~2F__worker-2:pay~20day',
    )
    // A `~` in a name is escaped too, so two names never collide.
    expect(namespaceScenarioName('a~20b', '/w')).not.toBe(namespaceScenarioName('a b', '/w'))
  })

  it('lists every scenario without a namespace', async () => {
    const all = await new WireMockClient(baseUrl).getScenarios()
    expect(all.map((s) => s.name)).toContain('recovery')
    expect(all).toHaveLength(4)
  })

  it('lists only its own scenarios, by their stubs’ names, with a namespace', async () => {
    const client = new WireMockClient(baseUrl, undefined, { namespace: '/__worker-2' })
    expect(await client.getScenarios()).toEqual([
      { name: 'recovery', state: 'Started', possibleStates: ['Started', 'recovered'] },
      { name: 'pay day', state: 'Started', possibleStates: ['Started', 'paid'] },
    ])
  })

  it('moves only its own scenario of that name', async () => {
    const two = new WireMockClient(baseUrl, undefined, { namespace: '/__worker-2' })
    await two.setScenarioState('recovery', 'recovered')
    await two.setScenarioState('pay day', 'paid')
    expect(await two.getScenarioState('recovery')).toBe('recovered')
    expect(await two.getScenarioState('pay day')).toBe('paid')
    const one = new WireMockClient(baseUrl, undefined, { namespace: '/__worker-1' })
    expect(await one.getScenarioState('recovery')).toBe('Started')
    expect(await new WireMockClient(baseUrl).getScenarioState('recovery')).toBe('Started')
  })

  it('moves a scenario without a namespace', async () => {
    const client = new WireMockClient(baseUrl)
    await client.setScenarioState('recovery', 'failing')
    expect(await client.getScenarioState('recovery')).toBe('failing')
    expect(puts).toEqual(['recovery'])
  })

  it('says which scenarios exist when the name is unknown', async () => {
    const client = new WireMockClient(baseUrl, undefined, { namespace: '/__worker-2' })
    await expect(client.setScenarioState('recover', 'recovered')).rejects.toThrow(
      'WireMock has no scenario "recover" (scenarios: "recovery", "pay day")',
    )
  })

  it("says which states a scenario has when it hasn't the one asked for", async () => {
    const client = new WireMockClient(baseUrl, undefined, { namespace: '/__worker-2' })
    await expect(client.setScenarioState('recovery', 'failing')).rejects.toThrow(
      'WireMock scenario "recovery" has no state "failing" (states: "Started", "recovered")',
    )
  })

  it("refuses a name WireMock can't address, before asking it", async () => {
    const client = new WireMockClient(baseUrl)
    await expect(client.setScenarioState('pay day', 'paid')).rejects.toThrow(
      `WireMock can't address scenario "pay day"`,
    )
    expect(puts).toEqual([])
  })

  it('resets only its own scenarios with a namespace', async () => {
    const two = new WireMockClient(baseUrl, undefined, { namespace: '/__worker-2' })
    const one = new WireMockClient(baseUrl, undefined, { namespace: '/__worker-1' })
    await two.setScenarioState('recovery', 'recovered')
    await one.setScenarioState('recovery', 'recovered')
    await two.resetScenarios()
    expect(await two.getScenarioState('recovery')).toBe('Started')
    expect(await one.getScenarioState('recovery')).toBe('recovered')
  })

  it('resets every scenario without a namespace', async () => {
    const one = new WireMockClient(baseUrl, undefined, { namespace: '/__worker-1' })
    await one.setScenarioState('recovery', 'recovered')
    await new WireMockClient(baseUrl).resetScenarios()
    expect(await one.getScenarioState('recovery')).toBe('Started')
  })
})
