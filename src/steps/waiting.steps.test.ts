import { describe, it, expect, vi, beforeAll } from 'vitest'

type StepFn = (this: unknown, ...args: unknown[]) => unknown
interface Step {
  options: { timeout?: number }
  fn: StepFn
}

// Capture step definitions by expression so the real step functions can run
// without a Cucumber runtime.
const steps = vi.hoisted(() => new Map<string, Step>())

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (
    expression: string,
    optionsOrFn: Step['options'] | StepFn,
    maybeFn?: StepFn,
  ) => {
    if (typeof optionsOrFn === 'function') steps.set(expression, { options: {}, fn: optionsOrFn })
    else steps.set(expression, { options: optionsOrFn, fn: maybeFn as StepFn })
  }
  return { ...actual, Given: register, When: register, Then: register }
})

import './common/wiremock.steps'
import './common/db-assertion.steps'
import './worker/generic-service.steps'
import { registerWaitingSteps } from './waiting.steps'

const BUDGET = 300

const run = (world: unknown, expression: string, ...args: unknown[]) => {
  const step = steps.get(expression)
  if (!step) throw new Error(`Step not registered: ${expression}`)
  return step.fn.apply(world, args)
}

/** A value source that returns each of `values` in turn, then repeats the last. */
const sequence = (...values: number[]) => {
  let i = 0
  return vi.fn(async () => values[Math.min(i++, values.length - 1)])
}

/** A world whose WireMock count and DB count come from the given sources. */
const world = (counts: { requests?: () => Promise<number>; rows?: () => Promise<number> }) => ({
  config: {
    apiBaseUrl: '',
    wiremockUrl: 'http://wiremock.test',
    fixturesDir: '.',
    waitTimeout: BUDGET,
  },
  wiremock: { getRequestCount: vi.fn((..._args: unknown[]) => counts.requests?.() ?? 0) },
  db: {
    query: vi.fn(async (sql: string) => ({
      rows: sql.startsWith('SELECT COUNT') ? [{ count: String(await counts.rows?.()) }] : [],
    })),
  },
})

describe('existing count steps now wait (COMPONENT-6)', () => {
  it('passes once WireMock reaches the expected count', async () => {
    const w = world({ requests: sequence(0, 1, 2) })
    await run(w, 'the {word} API at {string} was called {int} time(s)', 'vendor', '/orders', 2)
    expect(w.wiremock.getRequestCount).toHaveBeenCalledTimes(3)
  })

  it('fails at once when WireMock has already overshot', async () => {
    const started = Date.now()
    await expect(
      run(world({ requests: sequence(3) }), 'the {word} API was called {int} time(s)', 'vendor', 2),
    ).rejects.toThrow('Expected 2 calls to /vendor/.*, got 3')
    expect(Date.now() - started).toBeLessThan(BUDGET)
  })

  it('fails with the last count when WireMock never gets there', async () => {
    await expect(
      run(
        world({ requests: sequence(1) }),
        'the {word} API at {string} was called {int} time(s)',
        'vendor',
        '/orders',
        2,
      ),
    ).rejects.toThrow(`timed out after ${BUDGET}ms: Expected 2 calls to /orders, got 1`)
  })

  it('waits for an exact row count to settle', async () => {
    const w = world({ rows: sequence(0, 0, 2) })
    await run(
      w,
      'the {word} table contains {int} row(s) matching {string}',
      'jobs',
      2,
      "state = 'done'",
    )
    expect(w.db.query).toHaveBeenLastCalledWith(
      "SELECT COUNT(*)::text AS count FROM jobs WHERE state = 'done'",
    )
  })

  it('waits for a table to empty', async () => {
    await run(world({ rows: sequence(2, 1, 0) }), 'the {word} table is empty', 'jobs')
  })

  it('rejects unsafe table names in record waits', async () => {
    await expect(
      run(
        world({ rows: sequence(1) }),
        'I wait for {int} record(s) in {word} matching {string}',
        1,
        'jobs;--',
        'true',
      ),
    ).rejects.toThrow('unsafe table name: jobs;--')
  })
})

describe('registerWaitingSteps (COMPONENT-6)', () => {
  const optIn = [
    'the {word} page should eventually be displayed',
    'I should eventually see {word} on the {word} page',
    'the {word} API eventually receives {int} {word} request(s) to {string}',
    'the {word} table contains at least {int} row(s) matching {string}',
  ]

  it('registers nothing until called', () => {
    for (const expression of optIn) expect(steps.has(expression)).toBe(false)
  })

  describe('once registered', () => {
    beforeAll(() => registerWaitingSteps({ waitTimeout: BUDGET }))

    it('registers the steps, with a timeout just past the wait', () => {
      for (const expression of optIn) {
        expect(steps.get(expression)?.options.timeout).toBe(BUDGET + 1_000)
      }
    })

    it('turns off the Cucumber timeout for steps that watch a window', () => {
      expect(
        steps.get(
          'the {word} API receives no further {word} requests to {string} for {int} seconds',
        )?.options.timeout,
      ).toBe(-1)
    })

    it('waits for at least N requests, filtered by method and body', async () => {
      const w = world({ requests: sequence(1, 3) })
      await run(
        w,
        'the {word} API eventually receives {int} {word} request(s) to {string} whose body matches {string}',
        'vendor',
        2,
        'post',
        '/orders',
        '$.id',
      )
      expect(w.wiremock.getRequestCount).toHaveBeenLastCalledWith('/orders', {
        method: 'post',
        bodyJsonPath: '$.id',
      })
    })

    it('fails "exactly over a window" when another request arrives', async () => {
      await expect(
        run(
          world({ requests: sequence(1, 1, 2) }),
          'the {word} API receives exactly {int} {word} request(s) to {string} whose body matches {string} over {int} seconds',
          'vendor',
          1,
          'POST',
          '/orders',
          '$.id',
          1,
        ),
      ).rejects.toThrow('2 POST /orders matching $.id request(s), want exactly 1')
    })

    it('passes "no further requests" when the count holds', { timeout: 10_000 }, async () => {
      await run(
        world({ requests: sequence(2) }),
        'the {word} API receives no further {word} requests to {string} for {int} seconds',
        'vendor',
        'GET',
        '/poll',
        1,
      )
    })

    it(
      'fails "no further requests" when nothing arrived beforehand',
      { timeout: 10_000 },
      async () => {
        await expect(
          run(
            world({ requests: sequence(0) }),
            'the {word} API receives no further {word} requests to {string} for {int} seconds',
            'vendor',
            'GET',
            '/poll',
            1,
          ),
        ).rejects.toThrow('expected at least one GET /poll request')
      },
    )

    it('waits for at least N rows', async () => {
      await run(
        world({ rows: sequence(0, 5) }),
        'the {word} table contains at least {int} row(s) matching {string}',
        'readings',
        2,
        'true',
      )
    })

    it('waits for a row count to come down to exactly N', async () => {
      await run(
        world({ rows: sequence(4, 1) }),
        'I wait for exactly {int} record(s) in {word} matching {string}',
        1,
        'readings',
        'true',
      )
    })
  })
})
