import { describe, it, expect, vi } from 'vitest'

type StepFn = (this: unknown, ...args: unknown[]) => unknown

// Its own file, so these are the first options the steps are registered with.
const steps = vi.hoisted(() => new Map<string, { options: unknown; fn: StepFn }>())

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (expression: string, options: unknown, fn?: StepFn) => {
    steps.set(expression, { options, fn: fn as StepFn })
  }
  return { ...actual, Given: register, When: register, Then: register }
})

import { defineRedisSteps } from './common/redis.steps'

describe('registerRedisSteps({ serviceWaitTimeout }) (COMPONENT-15)', () => {
  it('waits for the option and times the step out 1s later', async () => {
    defineRedisSteps({ serviceWaitTimeout: 5_000 })
    const step = steps.get('I wait for the Valkey key {string} to be set')!
    expect(step.options).toEqual({ timeout: 6_000 })

    const waitForKey = vi.fn().mockResolvedValue('v')
    const world = { config: { serviceWaitTimeout: 100 }, redis: { waitForKey } }
    await step.fn.call(world, 'k')
    expect(waitForKey).toHaveBeenCalledWith('k', { timeoutMs: 5_000 })
  })
})
