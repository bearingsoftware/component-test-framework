import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { CucumberExpression, ParameterTypeRegistry } from '@cucumber/cucumber-expressions'

const registered = vi.hoisted(() => [] as string[])

vi.mock('@cucumber/cucumber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cucumber/cucumber')>()
  const register = (expression: string | RegExp) => void registered.push(String(expression))
  return { ...actual, Given: register, When: register, Then: register }
})

// A step text matching two definitions makes Cucumber fail the scenario as
// ambiguous. Load every built-in step module and check the GraphQL texts
// (COMPONENT-23) each match exactly one definition.
describe('GraphQL steps are not ambiguous with existing steps (COMPONENT-23)', () => {
  it.each([
    'the shop GraphQL query account returns:',
    'the shop GraphQL mutation obtainKrakenToken returns:',
    'the shop GraphQL operation account returns the errors:',
    'the shop GraphQL query account with variables "{\\"a\\":1}" returns:',
    'the shop GraphQL query account was called 1 time',
    'the shop GraphQL mutation account was called 2 times',
  ])('%s', async (text) => {
    const root = path.resolve(__dirname, '..')
    const modules = ['api', 'common', 'ui', 'worker', '.'].flatMap((dir) => {
      const full = path.join(root, dir)
      return fs
        .readdirSync(full)
        .filter((f) => f.endsWith('.steps.ts'))
        .map((f) => path.join(full, f))
    })
    for (const file of modules) await import(file)
    ;(await import('./redis.steps')).defineRedisSteps()

    const registry = new ParameterTypeRegistry()
    const matching = registered.filter((expression) => {
      if (!expression.startsWith('/'))
        return new CucumberExpression(expression, registry).match(text)
      const end = expression.lastIndexOf('/')
      return new RegExp(expression.slice(1, end), expression.slice(end + 1)).test(text)
    })
    expect(registered.length).toBeGreaterThan(40)
    expect(matching).toHaveLength(1)
  })
})
