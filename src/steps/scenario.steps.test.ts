import { describe, it, expect, vi } from 'vitest'

type StepFn = (this: unknown, ...args: unknown[]) => unknown

// Capture step definitions by expression so the real step functions can run
// without a Cucumber runtime.
const steps = vi.hoisted(() => new Map<string, StepFn>())

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (expression: string, optionsOrFn: unknown, maybeFn?: StepFn) => {
    steps.set(expression, (typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn) as StepFn)
  }
  return { ...actual, Given: register, When: register, Then: register }
})

import './common/wiremock.steps'
import './worker/generic-service.steps'

const MOVE = 'the WireMock scenario {string} is moved to state {string}'
const IS_IN = 'the WireMock scenario {string} is in state {string}'
const MOVE_AND_ROW =
  'the WireMock scenario {string} is moved to state {string} and a new row appears in {word} matching {string}'

const run = (world: unknown, expression: string, ...args: unknown[]) => {
  const step = steps.get(expression)
  if (!step) throw new Error(`Step not registered: ${expression}`)
  return step.apply(world, args)
}

/**
 * A world with one scenario, "recovery", and a table of `rows` rows that,
 * with `growsAfterMove`, gains a row each time it is counted after a move.
 */
const world = (options: { rows?: number; growsAfterMove?: boolean } = {}) => {
  let state = 'Started'
  let rows = options.rows ?? 0
  const events: string[] = []
  return {
    events,
    config: {
      apiBaseUrl: '',
      wiremockUrl: 'http://wiremock.test',
      fixturesDir: '.',
      waitTimeout: 300,
      serviceWaitTimeout: 1_200,
    },
    wiremock: {
      setScenarioState: vi.fn(async (_name: string, to: string) => {
        events.push(`move ${to}`)
        state = to
      }),
      getScenarioState: vi.fn(async (name: string) => (name === 'recovery' ? state : undefined)),
    },
    db: {
      query: vi.fn(async (sql: string) => {
        events.push(`count ${sql}`)
        if (options.growsAfterMove && state !== 'Started') rows++
        return { rows: [{ count: String(rows) }] }
      }),
    },
  }
}

describe('WireMock scenario steps (COMPONENT-14)', () => {
  it('moves a scenario', async () => {
    const w = world()
    await run(w, MOVE, 'recovery', 'recovered')
    expect(w.wiremock.setScenarioState).toHaveBeenCalledWith('recovery', 'recovered')
  })

  it('passes when the scenario is in the state', async () => {
    const w = world()
    await run(w, MOVE, 'recovery', 'recovered')
    await run(w, IS_IN, 'recovery', 'recovered')
  })

  it('waits, then says which state the scenario is in', async () => {
    await expect(run(world(), IS_IN, 'recovery', 'recovered')).rejects.toThrow(
      'WireMock scenario "recovery" is in state "Started"',
    )
  })

  it('fails at once for a scenario that does not exist', async () => {
    const w = world()
    w.config.waitTimeout = 10_000
    const started = Date.now()
    await expect(run(w, IS_IN, 'recover', 'recovered')).rejects.toThrow(
      'WireMock has no scenario "recover"',
    )
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('moving a scenario and waiting for a new row (COMPONENT-14)', () => {
  it('counts before the move, then waits for the count to grow', async () => {
    const w = world({ rows: 2, growsAfterMove: true })
    await run(w, MOVE_AND_ROW, 'recovery', 'recovered', 'readings', "source = 'vendor'")
    expect(w.events[0]).toBe(
      `count SELECT COUNT(*)::text AS count FROM readings WHERE source = 'vendor'`,
    )
    expect(w.events[1]).toBe('move recovered')
    expect(w.events.length).toBeGreaterThan(2)
  })

  it('does not count rows that were already there', async () => {
    const w = world({ rows: 5 })
    await expect(run(w, MOVE_AND_ROW, 'recovery', 'recovered', 'readings', 'true')).rejects.toThrow(
      /after moving WireMock scenario "recovery" to "recovered" \(5 before\)/,
    )
  })

  it('refuses an unsafe table name before moving anything', async () => {
    const w = world()
    await expect(
      run(w, MOVE_AND_ROW, 'recovery', 'recovered', 'readings;drop', 'true'),
    ).rejects.toThrow('unsafe table name: readings;drop')
    expect(w.wiremock.setScenarioState).not.toHaveBeenCalled()
  })
})
