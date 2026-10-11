import { strict as assert } from 'assert'
import type Redis from 'ioredis'
import { eventually } from '../support/eventually'
import { assertPartialMatch } from '../utils/match'
import { MessageQueue, type MessagePredicate, type PubSubMessage } from './message-queue'

export type { MessagePredicate, PubSubMessage }

/**
 * ioredis, loaded on first use rather than when this module is imported, so
 * a suite without Redis never loads it.
 */
function ioredis(): typeof Redis {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('ioredis') as typeof Redis
}

/**
 * Thin wrapper around ioredis for test cache operations:
 * flushing between scenarios and inspecting/setting values for assertions.
 */
export class RedisClient {
  private client: Redis
  private url: string

  constructor(url: string) {
    this.url = url
    this.client = new (ioredis())(url)
  }

  /** Flush the current database. Called between scenarios. */
  async flushDb(): Promise<void> {
    await this.client.flushdb()
  }

  /** Get a value by key. */
  async get(key: string): Promise<string | null> {
    return this.client.get(key)
  }

  /** Set a key-value pair with optional TTL in seconds. */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds)
    } else {
      await this.client.set(key, value)
    }
  }

  /** Delete a key. */
  async del(key: string): Promise<void> {
    await this.client.del(key)
  }

  /** Check if a key exists. */
  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key)
    return result === 1
  }

  /**
   * Poll until `key` is set, returning its value. Throws if the timeout
   * elapses first. Default 30s timeout, 250ms poll interval — matches the
   * cadence of the DB wait-for-row step.
   */
  async waitForKey(
    key: string,
    { timeoutMs = 30_000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const val = await this.client.get(key)
      if (val !== null) return val
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for Redis key "${key}"`)
  }

  /**
   * Poll until the value at `key` matches, returning the value. `expected`
   * is one of:
   * - a string: the exact value;
   * - a function: returns false or throws while the value doesn't match;
   * - anything else: the value is parsed as JSON and partially matched
   *   against it. Extra fields are ignored, and null in `expected` matches
   *   anything, as in the Valkey JSON step.
   *
   * Throws the last mismatch after `timeoutMs` (default 30s).
   */
  async waitForValue(
    key: string,
    expected: ValueMatcher,
    { timeoutMs = 30_000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<string> {
    return eventually(
      async () => {
        const value = await this.client.get(key)
        if (value === null) throw new Error(`key "${key}" is unset`)
        if (typeof expected === 'string') {
          assert.equal(value, expected, `key "${key}" has a different value`)
        } else if (typeof expected === 'function') {
          if (expected(value) === false) throw new Error(`key "${key}" doesn't match: ${value}`)
        } else {
          let actual: unknown
          try {
            actual = JSON.parse(value)
          } catch {
            throw new Error(`key "${key}" is not valid JSON: ${value}`)
          }
          assertPartialMatch(actual, expected, { nullMatchesAnything: true })
        }
        return value
      },
      { timeout: timeoutMs, interval: intervalMs, description: `waiting for Redis key "${key}"` },
    )
  }

  /**
   * Subscribe to one or more pub/sub channels and return a handle that lets
   * the caller wait for messages. Each call opens a dedicated connection so
   * SUBSCRIBE doesn't interfere with the main client's commands.
   */
  async subscribe(...channels: string[]): Promise<PubSubSubscription> {
    const subClient = new (ioredis())(this.url)
    const queue = new MessageQueue(channels.join(', '))
    subClient.on('message', (channel: string, message: string) => queue.push({ channel, message }))
    return listen(subClient, queue, () => subClient.subscribe(...channels))
  }

  /**
   * Subscribe to channels by glob pattern (PSUBSCRIBE), such as `events:*`,
   * for channels whose names a feature can't know in advance. Messages carry
   * the pattern that matched as well as the channel. Opens a dedicated
   * connection, as {@link subscribe} does.
   */
  async psubscribe(...patterns: string[]): Promise<PubSubSubscription> {
    const subClient = new (ioredis())(this.url)
    const queue = new MessageQueue(`pattern ${patterns.join(', ')}`)
    subClient.on('pmessage', (pattern: string, channel: string, message: string) =>
      queue.push({ pattern, channel, message }),
    )
    return listen(subClient, queue, () => subClient.psubscribe(...patterns))
  }

  /** Publish a message, returning how many subscribers received it. */
  async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message)
  }

  /**
   * Publish repeatedly until at least one subscriber receives the message
   * and `until`, if given, holds. Use it for a subscriber that may not have
   * subscribed yet, such as a worker that's still starting.
   *
   * Returns how many subscribers the last publish reached. Throws after
   * `timeoutMs` (default 30s), saying how many that was. Publishing more than
   * once can deliver the message more than once, so the subscriber must
   * tolerate repeats.
   */
  async publishUntilHeard(
    channel: string,
    message: string,
    {
      timeoutMs = 30_000,
      intervalMs = 500,
      until,
    }: { timeoutMs?: number; intervalMs?: number; until?: () => boolean | Promise<boolean> } = {},
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs
    let heard = 0
    for (;;) {
      heard = await this.client.publish(channel, message)
      if (heard > 0 && (!until || (await until()))) return heard
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)))
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms publishing to ${channel}: the last publish reached ` +
        `${heard} subscriber(s)${until && heard > 0 ? ', but the until condition never held' : ''}`,
    )
  }

  /** Close the connection. */
  async close(): Promise<void> {
    await this.client.quit()
  }
}

/** What {@link RedisClient.waitForValue} matches a value against. */
export type ValueMatcher = string | ((value: string) => boolean | void) | object | number | boolean

/** Handle returned by {@link RedisClient.subscribe} and {@link RedisClient.psubscribe}. */
export interface PubSubSubscription {
  /** Await the next message, or throw on timeout (default 30s). */
  waitForMessage(timeoutMs?: number): Promise<PubSubMessage>
  /**
   * Await the next message `predicate` accepts, or throw on timeout (default
   * 30s). Messages it skips are taken off the queue.
   */
  waitForMessage(predicate: MessagePredicate, timeoutMs?: number): Promise<PubSubMessage>
  /** Close the subscription's dedicated connection. Closing twice is harmless. */
  close(): Promise<void>
}

/** Subscribe, closing the connection if that fails, and return the handle. */
async function listen(
  subClient: Redis,
  queue: MessageQueue,
  start: () => Promise<unknown>,
): Promise<PubSubSubscription> {
  try {
    await start()
  } catch (err) {
    subClient.disconnect()
    throw err
  }
  let closed = false
  const waitForMessage = (
    predicateOrTimeout?: MessagePredicate | number,
    timeoutMs = 30_000,
  ): Promise<PubSubMessage> =>
    typeof predicateOrTimeout === 'function'
      ? queue.next(predicateOrTimeout, timeoutMs)
      : queue.next(undefined, predicateOrTimeout ?? 30_000)
  return {
    waitForMessage,
    async close() {
      if (closed) return
      closed = true
      await subClient.quit()
    },
  }
}
