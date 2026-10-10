import { describe, it, expect } from 'vitest'
import { eventually, holdsFor, StopRetrying, waitTimeout } from './eventually'

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

  it('lets steps that always waited keep their own default', () => {
    expect(waitTimeout({}, 30_000)).toBe(30_000)
  })
})
