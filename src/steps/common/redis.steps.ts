import { When, Then } from '@cucumber/cucumber'
import type { DataTable } from '@cucumber/cucumber'
import { strict as assert } from 'assert'
import type { ComponentTestWorld } from '../../support/world'
import { serviceWaitTimeout } from '../../support/eventually'
import { assertPartialMatch } from '../../utils/match'
import { valueAt } from '../../utils/json-path'
import type {
  MessagePredicate,
  PubSubMessage,
  PubSubSubscription,
} from '../../clients/redis-client'

function requireRedis(world: ComponentTestWorld): NonNullable<ComponentTestWorld['redis']> {
  if (!world.redis) {
    throw new Error('RedisClient is not configured — set redisUrl on FrameworkConfig')
  }
  return world.redis
}

function parseExpected(expectedJSON: string): unknown {
  try {
    return JSON.parse(expectedJSON)
  } catch (err) {
    throw new Error(`expected JSON is malformed: ${(err as Error).message}`)
  }
}

/** A table cell as JSON when it parses (`42`, `true`, `"x"`, `{…}`), otherwise as text. */
function cellValue(cell: string): unknown {
  try {
    return JSON.parse(cell)
  } catch {
    return cell
  }
}

/** Partial-match `expected` against a message's JSON; a message that isn't JSON doesn't match. */
function jsonMatches(check: (json: unknown) => void): MessagePredicate {
  return ({ message }) => {
    let json: unknown
    try {
      json = JSON.parse(message)
    } catch {
      return false
    }
    try {
      check(json)
      return true
    } catch {
      return false
    }
  }
}

/** The subscription the last "I subscribe to …" step opened. */
function requireSubscription(world: ComponentTestWorld): PubSubSubscription {
  assert.ok(
    world.activeSubscription,
    'no active subscription — call "I subscribe to Valkey channel …" or "… pattern …" first',
  )
  return world.activeSubscription
}

/**
 * Wait for the next message on the active subscription that `predicate`
 * accepts (any message without one), and keep it as `world.lastRedisMessage`.
 * The subscription stays open for further steps; the After hook closes it.
 */
async function receive(
  world: ComponentTestWorld,
  timeout: number,
  predicate?: MessagePredicate,
): Promise<void> {
  const sub = requireSubscription(world)
  const received: PubSubMessage = predicate
    ? await sub.waitForMessage(predicate, timeout)
    : await sub.waitForMessage(timeout)
  world.lastRedisMessage = received.message
}

async function track(
  world: ComponentTestWorld,
  opening: Promise<PubSubSubscription>,
): Promise<void> {
  const sub = await opening
  world.subscriptions.push(sub)
  world.activeSubscription = sub
}

/**
 * The same match as the step above, retried until the key's value matches,
 * for a value a background worker writes. Reports the last mismatch.
 */
async function eventuallyContains(
  world: ComponentTestWorld,
  timeoutMs: number,
  key: string,
  expectedJSON: string,
) {
  world.lastRedisValue = await requireRedis(world).waitForValue(
    key,
    parseExpected(expectedJSON) as object,
    {
      timeoutMs,
    },
  )
}

/** Options for {@link defineRedisSteps}. */
export interface RedisStepOptions {
  /**
   * How long the waiting steps wait, in ms: receiving a message, a key being
   * set or matching, publishing until heard. Default 30s. Each of those steps
   * gets a Cucumber timeout 1s longer, so a failure says what it was waiting
   * for.
   */
  serviceWaitTimeout?: number
}

// Headroom between a step's own wait and its Cucumber timeout, so the step
// fails with what it was waiting for rather than "function timed out".
const STEP_HEADROOM = 1_000

let registered = false

/**
 * Register the Valkey / Redis steps, once: a second call registers nothing,
 * so the steps can't become ambiguous. `registerRedisSteps` calls this.
 */
export function defineRedisSteps(options: RedisStepOptions = {}): void {
  if (registered) return
  registered = true

  const stepBudget = serviceWaitTimeout(options)
  const serviceStep = { timeout: stepBudget + STEP_HEADROOM }
  // The option when given; otherwise the suite's serviceWaitTimeout, capped
  // at the step's Cucumber timeout so the wait still fails first.
  const budget = (world: ComponentTestWorld) =>
    options.serviceWaitTimeout !== undefined
      ? stepBudget
      : Math.min(serviceWaitTimeout(world.config ?? {}), stepBudget)

  /**
   * Block until the named key appears, then stash its raw value on
   * `world.lastRedisValue` for subsequent assertion steps. Default 30s
   * timeout, 250ms poll — same cadence as the DB wait-for-row step.
   */
  When(
    'I wait for the Valkey key {string} to be set',
    serviceStep,
    async function (this: ComponentTestWorld, key: string) {
      const value = await requireRedis(this).waitForKey(key, { timeoutMs: budget(this) })
      this.lastRedisValue = value
    },
  )

  Then('the Valkey key {string} exists', async function (this: ComponentTestWorld, key: string) {
    const exists = await requireRedis(this).exists(key)
    assert.ok(exists, `expected Valkey key "${key}" to exist`)
  })

  Then(
    'the Valkey key {string} does not exist',
    async function (this: ComponentTestWorld, key: string) {
      const exists = await requireRedis(this).exists(key)
      assert.ok(!exists, `expected Valkey key "${key}" to not exist`)
    },
  )

  /**
   * Assert the key's value is valid JSON and every field in the supplied
   * JSON expression is present (deep partial match). Arrays are length-checked.
   * Unspecified fields in the actual are ignored — matches the semantics of
   * the generic-service fixture comparator.
   */
  Then(
    'the Valkey key {string} contains JSON matching {string}',
    async function (this: ComponentTestWorld, key: string, expectedJSON: string) {
      const raw = await requireRedis(this).get(key)
      assert.ok(raw !== null, `Valkey key "${key}" is unset`)
      let actual: unknown
      try {
        actual = JSON.parse(raw)
      } catch (err) {
        throw new Error(`Valkey key "${key}" is not valid JSON: ${(err as Error).message}`)
      }
      assertPartialMatch(actual, parseExpected(expectedJSON), { nullMatchesAnything: true })
    },
  )

  Then(
    'the Valkey key {string} eventually contains JSON matching {string}',
    serviceStep,
    async function (this: ComponentTestWorld, key: string, expectedJSON: string) {
      await eventuallyContains(this, budget(this), key, expectedJSON)
    },
  )

  Then(
    'the Valkey key {string} eventually contains JSON matching:',
    serviceStep,
    async function (this: ComponentTestWorld, key: string, expectedJSON: string) {
      await eventuallyContains(this, budget(this), key, expectedJSON)
    },
  )

  /**
   * Subscribe to the channel, then wait for a message to arrive. The message
   * body is stashed on `world.lastRedisMessage` for subsequent assertions.
   * The subscription is closed after the step.
   */
  When(
    'I wait for a message on Valkey channel {string}',
    serviceStep,
    async function (this: ComponentTestWorld, channel: string) {
      const sub = await requireRedis(this).subscribe(channel)
      try {
        const { message } = await sub.waitForMessage(budget(this))
        this.lastRedisMessage = message
      } finally {
        await sub.close()
      }
    },
  )

  /**
   * Start a pub/sub subscription that persists across steps. Use this when a
   * scenario needs to seed state after subscribing so it doesn't miss the
   * broadcast. Paired with the receive steps below.
   */
  When(
    'I subscribe to Valkey channel {string}',
    async function (this: ComponentTestWorld, channel: string) {
      await track(this, requireRedis(this).subscribe(channel))
    },
  )

  /** As above, by glob pattern (PSUBSCRIBE), e.g. `events:user:*`. */
  When(
    'I subscribe to Valkey pattern {string}',
    async function (this: ComponentTestWorld, pattern: string) {
      await track(this, requireRedis(this).psubscribe(pattern))
    },
  )

  Then(
    'I receive a message on the subscribed Valkey channel/pattern',
    serviceStep,
    async function (this: ComponentTestWorld) {
      await receive(this, budget(this))
    },
  )

  /**
   * Skip messages until one is JSON whose `type` field equals the given type,
   * for a channel that carries several kinds of event.
   */
  Then(
    'I receive a message with type {string} on the subscribed Valkey channel/pattern',
    serviceStep,
    async function (this: ComponentTestWorld, type: string) {
      await receive(
        this,
        budget(this),
        jsonMatches((json) => assert.equal((json as { type?: unknown })?.type, type)),
      )
    },
  )

  /** Skip messages until one is JSON that partially matches, as the JSON steps match. */
  Then(
    'I receive a message on the subscribed Valkey channel/pattern matching JSON {string}',
    serviceStep,
    async function (this: ComponentTestWorld, expectedJSON: string) {
      const expected = parseExpected(expectedJSON)
      await receive(
        this,
        budget(this),
        jsonMatches((json) => assertPartialMatch(json, expected, { nullMatchesAnything: true })),
      )
    },
  )

  Then(
    'I receive a message on the subscribed Valkey channel/pattern matching JSON:',
    serviceStep,
    async function (this: ComponentTestWorld, expectedJSON: string) {
      const expected = parseExpected(expectedJSON)
      await receive(
        this,
        budget(this),
        jsonMatches((json) => assertPartialMatch(json, expected, { nullMatchesAnything: true })),
      )
    },
  )

  /**
   * Skip messages until one is JSON with every field in the table: a path
   * (`user.id`, `items[0].sku`) and a value, read as JSON when it parses and
   * as text otherwise.
   */
  Then(
    'I receive a message on the subscribed Valkey channel/pattern with fields:',
    serviceStep,
    async function (this: ComponentTestWorld, table: DataTable) {
      const fields = Object.entries(table.rowsHash()).map(
        ([path, cell]) => [path, cellValue(cell)] as const,
      )
      await receive(
        this,
        budget(this),
        jsonMatches((json) => {
          for (const [path, expected] of fields) {
            assertPartialMatch(valueAt(json, path), expected, { nullMatchesAnything: true })
          }
        }),
      )
    },
  )

  Then(
    'the last Valkey message matches JSON {string}',
    function (this: ComponentTestWorld, expectedJSON: string) {
      assert.ok(this.lastRedisMessage !== undefined, 'no Valkey message captured')
      let actual: unknown
      try {
        actual = JSON.parse(this.lastRedisMessage)
      } catch (err) {
        throw new Error(`last Valkey message is not valid JSON: ${(err as Error).message}`)
      }
      assertPartialMatch(actual, parseExpected(expectedJSON), { nullMatchesAnything: true })
    },
  )

  When(
    'I publish {string} to Valkey channel {string}',
    async function (this: ComponentTestWorld, message: string, channel: string) {
      await requireRedis(this).publish(channel, message)
    },
  )

  When(
    'I publish to Valkey channel {string}:',
    async function (this: ComponentTestWorld, channel: string, message: string) {
      await requireRedis(this).publish(channel, message)
    },
  )

  /**
   * Publish every 500ms until a subscriber receives it, for a subscriber that
   * may not be listening yet. It may be delivered more than once.
   */
  When(
    'I publish {string} to Valkey channel {string} until a subscriber hears it',
    serviceStep,
    async function (this: ComponentTestWorld, message: string, channel: string) {
      await requireRedis(this).publishUntilHeard(channel, message, {
        timeoutMs: budget(this),
      })
    },
  )
}

// Re-exported so consumers can call the waiter from their own step modules.
export type { PubSubSubscription }
