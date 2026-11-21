import { Given, Then, When } from '@cucumber/cucumber'
import type { CaptureServer } from './capture-server'
import { parseMatch } from './match'
import { eventually } from '../support/eventually'

/** A capture server, or a function returning it, for servers started in a hook. */
export type StubSource = CaptureServer | (() => CaptureServer)

export interface StubStepOptions {
  /** How long "I wait for the … stub to see …" waits, in ms. Default 10s. */
  stubWaitTimeout?: number
}

const DEFAULT_WAIT = 10_000
// The wait bounds the step itself, and a later call may change it.
const NO_STEP_TIMEOUT = -1

const servers = new Map<string, StubSource>()
let defined = false
let waitMs = DEFAULT_WAIT

function stub(name: string): CaptureServer {
  const source = servers.get(name)
  if (!source) {
    throw new Error(
      `No stub named "${name}": registered are ${[...servers.keys()].join(', ') || 'none'}`,
    )
  }
  return typeof source === 'function' ? source() : source
}

/**
 * Register the capture-server steps for the named servers:
 *
 * - `the {word} stub answers {int} for requests matching {string}`
 * - `the {word} stub answers {int} once for requests matching {string}`
 * - `the {word} stub saw {int} request(s) matching {string}`
 * - `I wait for the {word} stub to see {int} request(s) matching {string}`:
 *   waits until at least that many have arrived
 * - `the {word} stub is down` / `the {word} stub is up`
 *
 * The matching string is `;`-separated terms: `path=/x`, `method=POST`,
 * `query.NAME=v`, `header.NAME=v`, and `body~text` last (it takes the rest).
 * Calling this again adds servers to the same steps, which are defined once;
 * a later call's `stubWaitTimeout`, when given, replaces the earlier one.
 */
export function registerStubSteps(
  named: Record<string, StubSource>,
  options: StubStepOptions = {},
): void {
  for (const [name, source] of Object.entries(named)) servers.set(name, source)
  if (options.stubWaitTimeout !== undefined) waitMs = options.stubWaitTimeout
  if (defined) return
  defined = true

  Given(
    'the {word} stub answers {int} for requests matching {string}',
    function (name: string, status: number, spec: string) {
      stub(name).script({ match: parseMatch(spec), respond: status })
    },
  )

  Given(
    'the {word} stub answers {int} once for requests matching {string}',
    function (name: string, status: number, spec: string) {
      stub(name).script({ match: parseMatch(spec), respond: status, once: true })
    },
  )

  Then(
    'the {word} stub saw {int} request(s) matching {string}',
    function (name: string, want: number, spec: string) {
      const got = stub(name).requests(parseMatch(spec)).length
      if (got !== want)
        throw new Error(`the ${name} stub saw ${got} requests matching "${spec}", expected ${want}`)
    },
  )

  Then(
    'I wait for the {word} stub to see {int} request(s) matching {string}',
    { timeout: NO_STEP_TIMEOUT },
    async function (name: string, want: number, spec: string) {
      const match = parseMatch(spec)
      await eventually(
        () => {
          const got = stub(name).requests(match).length
          if (got < want)
            throw new Error(
              `the ${name} stub has seen ${got} requests matching "${spec}", expected ${want}`,
            )
        },
        { timeout: waitMs, description: `waiting for the ${name} stub` },
      )
    },
  )

  When('the {word} stub is down', async function (name: string) {
    await stub(name).down()
  })

  When('the {word} stub is up', async function (name: string) {
    await stub(name).up()
  })
}
