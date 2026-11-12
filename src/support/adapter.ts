import { Before, BeforeAll, After, AfterAll, Status } from '@cucumber/cucumber'
import type { ITestCaseHookParameter } from '@cucumber/cucumber'
import type { ComponentTestWorld } from './world'
import type { FrameworkConfig } from '../types'
import { currentWorker } from './worker'
import type { WorkerInfo } from './worker'

export interface AdapterContext {
  config: FrameworkConfig
  worker: WorkerInfo
}

type Hook<Args extends unknown[]> = (...args: Args) => unknown | Promise<unknown>

/**
 * One technology's lifecycle, so it can be added without changing the core.
 * `State` is whatever `setup` returns, handed to every later hook and to
 * `world.adapter(thisAdapter)`.
 */
export interface Adapter<State = undefined> {
  /** Unique within a run. A duplicate throws at registration. */
  readonly name: string
  /** At registration. Throw for config mistakes. */
  validate?(ctx: AdapterContext): void
  /** Once, at registration. Its return value is the adapter's state. */
  setup?(ctx: AdapterContext): State
  beforeAll?: Hook<[AdapterContext, State]>
  beforeScenario?: Hook<[ComponentTestWorld, State]>
  onScenarioFailed?: Hook<[ComponentTestWorld, ITestCaseHookParameter, State]>
  afterScenario?: Hook<[ComponentTestWorld, ITestCaseHookParameter, State]>
  afterAll?: Hook<[AdapterContext, State]>
  /** Called once, at registration, after every adapter's `setup`. */
  registerSteps?(state: State): void
  /** Milliseconds. Default 30_000. */
  beforeAllTimeout?: number
  /** Milliseconds. Default is Cucumber's default timeout. */
  afterAllTimeout?: number
}

// Adapters with different states share one list, so the list's element type can't name a state.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAdapter = Adapter<any>

export function defineAdapter<State = undefined>(adapter: Adapter<State>): Adapter<State> {
  return adapter
}

export const DEFAULT_BEFORE_ALL_TIMEOUT = 30_000

/** Results that fail the run (undefined and pending ones under --strict). */
export const FAILED_STATUSES = new Set<string>([
  Status.FAILED,
  Status.AMBIGUOUS,
  Status.UNDEFINED,
  Status.PENDING,
])

// Per worker: Cucumber gives each parallel worker its own module instances.
const states = new Map<AnyAdapter, unknown>()

/** The state of a registered adapter. Throws if it isn't registered. */
export function adapterState<State>(adapter: Adapter<State>): State {
  if (!states.has(adapter)) {
    throw new Error(
      `Adapter "${adapter.name}" isn't registered: pass it in registerHooks({ adapters: [...] }) or to registerAdapter().`,
    )
  }
  return states.get(adapter) as State
}

/** Run every step even when one throws, then rethrow the first error. */
export async function runAll(steps: Array<() => unknown>): Promise<void> {
  let first: { error: unknown } | undefined
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      first ??= { error }
    }
  }
  if (first) throw first.error
}

export function failed(scenario: ITestCaseHookParameter): boolean {
  return FAILED_STATUSES.has(String(scenario.result?.status))
}

/**
 * Validate, set up and register the steps of every adapter, in that order
 * for the whole list. A duplicate name throws before anything runs.
 */
export function initAdapters(adapters: AnyAdapter[], ctx: AdapterContext): void {
  const seen = new Set<string>()
  for (const adapter of adapters) {
    if (seen.has(adapter.name)) throw new Error(`Adapter "${adapter.name}" is registered twice.`)
    seen.add(adapter.name)
  }
  for (const adapter of adapters) adapter.validate?.(ctx)
  for (const adapter of adapters) states.set(adapter, adapter.setup?.(ctx))
  for (const adapter of adapters) adapter.registerSteps?.(states.get(adapter))
}

export function beforeAllHooks(adapters: AnyAdapter[], ctx: AdapterContext): void {
  for (const adapter of adapters) {
    const { beforeAll } = adapter
    if (!beforeAll) continue
    BeforeAll(
      { timeout: adapter.beforeAllTimeout ?? DEFAULT_BEFORE_ALL_TIMEOUT },
      async function () {
        await beforeAll.call(adapter, ctx, states.get(adapter))
      },
    )
  }
}

/** Each adapter's beforeScenario, in order. A throw stops the chain. */
export async function runBeforeScenario(
  adapters: AnyAdapter[],
  world: ComponentTestWorld,
): Promise<void> {
  for (const adapter of adapters) {
    await adapter.beforeScenario?.(world, states.get(adapter))
  }
}

/** The failure and teardown steps for one scenario's adapters, in spec order. */
export function afterScenarioSteps(
  adapters: AnyAdapter[],
  world: ComponentTestWorld,
  scenario: ITestCaseHookParameter,
): Array<() => unknown> {
  const steps: Array<() => unknown> = []
  if (failed(scenario)) {
    for (const adapter of adapters) {
      if (adapter.onScenarioFailed) {
        steps.push(() => adapter.onScenarioFailed!(world, scenario, states.get(adapter)))
      }
    }
  }
  return steps
}

export function teardownSteps(
  adapters: AnyAdapter[],
  world: ComponentTestWorld,
  scenario: ITestCaseHookParameter,
): Array<() => unknown> {
  return [...adapters]
    .reverse()
    .filter((adapter) => adapter.afterScenario)
    .map((adapter) => () => adapter.afterScenario!(world, scenario, states.get(adapter)))
}

/** The afterAll steps, in reverse adapter order. */
export function afterAllSteps(adapters: AnyAdapter[], ctx: AdapterContext): Array<() => unknown> {
  return [...adapters]
    .reverse()
    .filter((adapter) => adapter.afterAll)
    .map((adapter) => () => adapter.afterAll!(ctx, states.get(adapter)))
}

/**
 * Register one adapter's own Cucumber hooks in place, for code that doesn't
 * go through `registerHooks`, so Cucumber's registration order applies. Pass
 * `config` when the adapter reads it; without it `ctx.config` is empty.
 * Returns the adapter's state.
 */
export function registerAdapter<State>(
  adapter: Adapter<State>,
  config: FrameworkConfig = {} as FrameworkConfig,
): State {
  const ctx: AdapterContext = { config, worker: currentWorker() }
  initAdapters([adapter], ctx)
  const state = states.get(adapter) as State

  beforeAllHooks([adapter], ctx)
  if (adapter.beforeScenario) {
    Before(async function (this: ComponentTestWorld) {
      await runBeforeScenario([adapter], this)
    })
  }
  if (adapter.onScenarioFailed || adapter.afterScenario) {
    After(async function (this: ComponentTestWorld, scenario: ITestCaseHookParameter) {
      await runAll([
        ...afterScenarioSteps([adapter], this, scenario),
        ...teardownSteps([adapter], this, scenario),
      ])
    })
  }
  if (adapter.afterAll) {
    const run = async () => {
      await runAll(afterAllSteps([adapter], ctx))
    }
    AfterAll({ timeout: adapter.afterAllTimeout }, run)
  }
  return state
}
