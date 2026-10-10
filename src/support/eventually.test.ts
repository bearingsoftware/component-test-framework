import { describe, it, expect } from 'vitest'
import { eventually, holdsFor, serviceWaitTimeout, StopRetrying, waitTimeout } from './eventually'

describe('eventually (COMPONENT-6)', () => {
  it('returns as soon as the check passes', async () => {
    let calls = 0
    const result = await eventually(
      () => {
        calls++
        if (calls < 3) throw new Error('not yet')
        return 'done'
      },
      { timeout: 1_000, interval: 5 },
    )

    expect(result).toBe('done')
    expect(calls).toBe(3)
  })

  it('reports the last failure, with what it was waiting for', async () => {
    let calls = 0
    const failure = await eventually(
      () => {
        calls++
        throw new Error(`attempt ${calls}`)
      },
      { timeout: 50, interval: 10, description: 'waiting for rows' },
    ).catch((err: Error) => err)

    expect(calls).toBeGreaterThan(1)
    expect((failure as Error).message).toBe(
      `waiting for rows (timed out after 50ms): attempt ${calls}`,
    )
  })

  it('makes a last attempt at the deadline when the interval would overshoot it', async () => {
    let calls = 0
    const started = Date.now()
    await eventually(
      () => {
        if (++calls < 2) throw new Error('not yet')
      },
      { timeout: 50, interval: 1_000 },
    )
    expect(calls).toBe(2)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('always makes at least one attempt', async () => {
    let calls = 0
    await eventually(() => void calls++, { timeout: 0 })
    expect(calls).toBe(1)
  })

  it('stops at once when the check says it cannot succeed', async () => {
    const started = Date.now()
    await expect(
      eventually(
        () => {
          throw new StopRetrying('count overshot')
        },
        { timeout: 5_000, interval: 10 },
      ),
    ).rejects.toThrow('count overshot')
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('holdsFor (COMPONENT-6)', () => {
  it('passes when the check holds for the whole window', async () => {
    let calls = 0
    const started = Date.now()
    await holdsFor(() => void calls++, { duration: 60, interval: 10 })

    expect(Date.now() - started).toBeGreaterThanOrEqual(60)
    expect(calls).toBeGreaterThan(2)
  })

  it('fails as soon as the check stops holding', async () => {
    let calls = 0
    const started = Date.now()
    await expect(
      holdsFor(
        () => {
          if (++calls === 2) throw new Error('changed')
        },
        { duration: 5_000, interval: 10, description: 'count stable' },
      ),
    ).rejects.toThrow(/^count stable \(changed after \d+ms\): changed$/)
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('waitTimeout (COMPONENT-6)', () => {
  it('prefers an explicit waitTimeout', () => {
    expect(waitTimeout({ waitTimeout: 7_000, defaultStepTimeout: 60_000 })).toBe(7_000)
  })

  it('otherwise fits inside the default step timeout', () => {
    expect(waitTimeout({ defaultStepTimeout: 30_000 })).toBe(29_000)
  })

  it('otherwise fits inside Cucumber’s 5s default', () => {
    expect(waitTimeout({})).toBe(4_000)
  })

  // Playwright treats a timeout of 0 as "wait forever".
  it('never returns 0', () => {
    expect(waitTimeout({ waitTimeout: 0 })).toBe(1)
    expect(waitTimeout({ defaultStepTimeout: 500 })).toBe(1)
    expect(serviceWaitTimeout({ serviceWaitTimeout: 0 })).toBe(1)
  })

  it('gives waits for background work 30s unless told otherwise', () => {
    expect(serviceWaitTimeout({})).toBe(30_000)
    expect(serviceWaitTimeout({ serviceWaitTimeout: 45_000 })).toBe(45_000)
  })

  it('lets steps that always waited keep their own default', () => {
    expect(waitTimeout({}, 30_000)).toBe(30_000)
  })
})
