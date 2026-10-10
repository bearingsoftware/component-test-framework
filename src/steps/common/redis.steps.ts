import { When, Then } from '@cucumber/cucumber'
import { strict as assert } from 'assert'
import type { ComponentTestWorld } from '../../support/world'
import { assertPartialMatch } from '../../utils/match'
import type { PubSubSubscription } from '../../clients/redis-client'

function requireRedis(world: ComponentTestWorld): NonNullable<ComponentTestWorld['redis']> {
  if (!world.redis) {
    throw new Error('RedisClient is not configured — set redisUrl on FrameworkConfig')
  }
  return world.redis
}

/**
 * Block until the named key appears, then stash its raw value on
 * `world.lastRedisValue` for subsequent assertion steps. Default 30s
 * timeout, 250ms poll — same cadence as the DB wait-for-row step.
 */
When(
  'I wait for the Valkey key {string} to be set',
  async function (this: ComponentTestWorld, key: string) {
    const value = await requireRedis(this).waitForKey(key)
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
    let expected: unknown
    try {
      expected = JSON.parse(expectedJSON)
    } catch (err) {
      throw new Error(`expected JSON is malformed: ${(err as Error).message}`)
    }
    assertPartialMatch(actual, expected, { nullMatchesAnything: true })
  },
)

/**
 * Subscribe to the channel, then wait up to 30s for a message to arrive.
 * The message body is stashed on `world.lastRedisMessage` for subsequent
 * assertions. The subscription is closed after the step.
 */
When(
  'I wait for a message on Valkey channel {string}',
  async function (this: ComponentTestWorld, channel: string) {
    const sub = await requireRedis(this).subscribe(channel)
    try {
      const { message } = await sub.waitForMessage()
      this.lastRedisMessage = message
    } finally {
      await sub.close()
    }
  },
)

/**
 * Start a pub/sub subscription that persists across steps. Use this when a
 * scenario needs to seed state after subscribing so it doesn't miss the
 * broadcast. Paired with the assertion step below.
 */
When(
  'I subscribe to Valkey channel {string}',
  async function (this: ComponentTestWorld, channel: string) {
    this.activeSubscription = await requireRedis(this).subscribe(channel)
  },
)

Then(
  'I receive a message on the subscribed Valkey channel',
  async function (this: ComponentTestWorld) {
    assert.ok(this.activeSubscription, 'no active subscription — call "I subscribe to ..." first')
    try {
      const { message } = await this.activeSubscription.waitForMessage()
      this.lastRedisMessage = message
    } finally {
      await this.activeSubscription.close()
      this.activeSubscription = undefined
    }
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
    let expected: unknown
    try {
      expected = JSON.parse(expectedJSON)
    } catch (err) {
      throw new Error(`expected JSON is malformed: ${(err as Error).message}`)
    }
    assertPartialMatch(actual, expected, { nullMatchesAnything: true })
  },
)

// Re-exported so consumers can call the waiter from their own step modules.
export type { PubSubSubscription }
