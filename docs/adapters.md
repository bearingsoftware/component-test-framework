# Adapters

An adapter is one technology's lifecycle, so it can be added without changing the framework. WireMock, Postgres, Redis, Mailpit and the SPA server are all expressed this way (`wiremockAdapter`, `postgresAdapter`, `redisAdapter`, `mailpitAdapter`, `spaServerAdapter`, `coverageAdapter`), and your own take the same shape.

```ts
interface Adapter<State = undefined> {
  name: string // unique within a registerHooks list; a duplicate there throws
  validate?(ctx): void // at registration; throw for config mistakes
  setup?(ctx): State // once, at registration; the return value is the state
  beforeAll?(ctx, state) // beforeAllTimeout ms, default 30_000
  beforeScenario?(world, state)
  onScenarioFailed?(world, scenario, state)
  afterScenario?(world, scenario, state)
  afterAll?(ctx, state) // afterAllTimeout ms, default Cucumber's
  registerSteps?(state): void // once, at registration
}
```

Pass adapters to `registerHooks({ adapters: [...] })`, or call `registerAdapter(adapter)` where you are not using `registerHooks`: it registers the adapter's Cucumber hooks in place and returns its state. `world.adapter(thatAdapter)` returns the state, typed, and throws if the adapter isn't registered.

Order, which is fixed:

1. Registration: the built-in adapters derived from config (Postgres, WireMock, Redis, in that order), then `adapters` in array order. `validate` runs for all, then `setup` for all, then `registerSteps` for all.
2. `BeforeAll`: adapter order.
3. Before each scenario: the world is wired and reset, each `beforeScenario` runs in order, then `hooks.afterReset`, then the `@ui` hook. A throw stops the chain.
4. After each scenario (before the `@ui` After): `hooks.onScenarioFailed`, each adapter's `onScenarioFailed` (failed results only), each `afterScenario` in reverse order, then `cleanup`. Every step runs even if one throws, and the first error is rethrown.
5. `AfterAll`: reverse order, after the browser closes, with the same error rule.

```ts
// support/setup.ts
import { registerHooks, defineAdapter, loadConfig } from '@bearingsoftware/component-test-framework/core'
import { Then } from '@cucumber/cucumber'
import type { ComponentTestWorld } from '@bearingsoftware/component-test-framework/core'

const clock = defineAdapter({
  name: 'clock',
  setup: () => ({ now: new Date(0) }),
  beforeScenario: (_world, state) => {
    state.now = new Date(0)
  },
  registerSteps: (state) => {
    Then('a minute passes', () => {
      state.now = new Date(state.now.getTime() + 60_000)
    })
  },
})

registerHooks({ ...loadConfig(), adapters: [clock] })

Then('it is {int} minute(s) past the start', function (this: ComponentTestWorld, minutes: number) {
  if (this.adapter(clock).now.getTime() !== minutes * 60_000) throw new Error('wrong time')
})
```

The adapter factories come from their entry points: `wiremockAdapter` from `/wiremock`, `postgresAdapter` from `/postgres`, `redisAdapter` from `/redis`, `mailpitAdapter` from `/mailpit`, and `spaServerAdapter` and `coverageAdapter` from `/spa`. `defineAdapter`, `registerAdapter` and the `Adapter` type come from `/core`. See [lifecycle.md](lifecycle.md) for where adapter hooks sit in the scenario lifecycle.
