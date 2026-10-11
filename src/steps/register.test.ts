import { describe, it, expect, vi } from 'vitest'

// Count step definitions as they're registered.
const registered = vi.hoisted(() => [] as string[])

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (expression: string | RegExp) => void registered.push(String(expression))
  return { ...actual, Given: register, When: register, Then: register }
})

import * as core from '../core'

// Registering a group loads the compiled step module with require, which
// Vitest can't follow into TypeScript source; tests/smoke covers that against
// the built package.
describe('register…Steps (COMPONENT-9)', () => {
  it('registers nothing when core is imported', () => {
    expect(core.registerApiSteps).toBeTypeOf('function')
    expect(registered).toEqual([])
  })
})
