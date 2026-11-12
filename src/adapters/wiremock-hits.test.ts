/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { wiremockAdapter } from './wiremock'
import { WireMockClient } from '../clients/wiremock-client'

const scenario = {
  pickle: { uri: 'f/a.feature', name: 'outline row', astNodeIds: ['row2'] },
  gherkinDocument: {
    feature: {
      children: [
        {
          scenario: {
            id: 'sc',
            location: { line: 3 },
            examples: [
              {
                tableBody: [
                  { id: 'row1', location: { line: 7 } },
                  { id: 'row2', location: { line: 8 } },
                ],
              },
            ],
          },
        },
      ],
    },
  },
} as any

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('wiremockAdapter CTF_FAULT_HITS (COMPONENT-30)', () => {
  it('has no afterScenario, and so makes no journal call and writes no file, when unset', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-hits-')), 'hits')
    const adapter = wiremockAdapter({ url: 'http://wm', fixturesDir: '.' })
    expect(adapter.afterScenario).toBeUndefined()
    await adapter.afterScenario?.({} as any, scenario, adapter.setup!({} as any))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('records the stubs a scenario hit, with its line, when set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-hits-'))
    const file = path.join(dir, 'hits.jsonl')
    vi.stubEnv('CTF_FAULT_HITS', file)
    const adapter = wiremockAdapter({ url: 'http://wm', fixturesDir: '.' })
    const client = new WireMockClient('http://wm')
    vi.spyOn(client, 'servedStubKeys').mockResolvedValue(['GET /a', 'GET /a', 'GET /b'])
    await adapter.afterScenario!({} as any, scenario, client)
    expect(
      fs
        .readFileSync(file, 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
    ).toEqual([{ uri: 'f/a.feature', name: 'outline row', line: 8, stubs: ['GET /a', 'GET /b'] }])
    fs.rmSync(dir, { recursive: true })
  })
})
