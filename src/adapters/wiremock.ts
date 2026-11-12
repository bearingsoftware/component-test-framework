import * as fs from 'fs'
import * as path from 'path'
import { WireMockClient } from '../clients/wiremock-client'
import { defineAdapter } from '../support/adapter'
import type { Adapter } from '../support/adapter'
import type { ITestCaseHookParameter } from '@cucumber/cucumber'

export interface WireMockAdapterOptions {
  /** WireMock admin base URL. Empty means not configured: only the config checks run. */
  url: string
  /** Path prefix keeping this worker's stubs apart (see `wiremockNamespace`). */
  namespace?: string
  /** Stub directories under `fixturesDir`, loaded after every reset. */
  baseline?: string[]
  fixturesDir: string
  stubsDir?: string
}

/** The line of the scenario, or of the Examples row, a pickle came from: what Cucumber's JSON reports. */
function pickleLine(scenario: ITestCaseHookParameter): number | undefined {
  const ids = new Set(scenario.pickle.astNodeIds)
  for (const child of scenario.gherkinDocument.feature?.children ?? []) {
    const nodes = [...(child.rule?.children ?? []), child]
    for (const node of nodes) {
      const sc = node.scenario
      if (!sc) continue
      for (const ex of sc.examples) {
        for (const row of ex.tableBody) if (ids.has(row.id)) return row.location.line
      }
      if (ids.has(sc.id)) return sc.location.line
    }
  }
  return undefined
}

/** Resets WireMock (and loads the baseline stubs) before each scenario. State is the client. */
export function wiremockAdapter(options: WireMockAdapterOptions): Adapter<WireMockClient> {
  const { url, baseline, fixturesDir, stubsDir } = options
  return defineAdapter<WireMockClient>({
    name: 'wiremock',
    validate() {
      if (baseline?.length) {
        if (!url) {
          throw new Error(
            'wiremockBaseline needs wiremockUrl: set WIREMOCK_URL or pass wiremockUrl.',
          )
        }
        for (const dir of baseline) {
          const mappings = path.join(path.resolve(fixturesDir, dir), 'mappings')
          if (!fs.existsSync(mappings)) {
            throw new Error(
              `wiremockBaseline directory has no mappings folder: ${mappings}. ` +
                `Stub directories use WireMock's layout, <dir>/mappings/*.json.`,
            )
          }
        }
      }
      if (stubsDir && !fs.existsSync(stubsDir)) {
        console.warn(
          `[component-test-framework] wiremockStubsDir does not exist: ${stubsDir}. ` +
            `Steps that register stubs from files will fail.`,
        )
      }
    },
    setup: () => new WireMockClient(url, undefined, { namespace: options.namespace }),
    ...(url &&
      process.env.CTF_FAULT_HITS && {
        async afterScenario(_world, scenario, client: WireMockClient) {
          const stubs = [...new Set(await client.servedStubKeys())]
          const { uri, name } = scenario.pickle
          const line = pickleLine(scenario)
          fs.appendFileSync(
            process.env.CTF_FAULT_HITS as string,
            `${JSON.stringify({ uri, name, line, stubs })}\n`,
          )
        },
      }),
    ...(url && {
      beforeAll: (_ctx: unknown, client: WireMockClient) => client.waitForReady(30_000),
      async beforeScenario(world, client: WireMockClient) {
        world.wiremock = client
        await client.resetAll()
        for (const dir of baseline ?? []) {
          await client.loadMappingsFromDir(path.resolve(fixturesDir, dir))
        }
      },
    }),
  })
}
