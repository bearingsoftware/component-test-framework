import type Redis from 'ioredis'

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
   * Subscribe to one or more pub/sub channels and return a handle that lets
   * the caller wait for messages. Each call opens a dedicated connection so
   * SUBSCRIBE doesn't interfere with the main client's commands.
   */
  async subscribe(...channels: string[]): Promise<PubSubSubscription> {
    const subClient = new (ioredis())(this.url)
    const buffer: { channel: string; message: string }[] = []
    const waiters: ((msg: { channel: string; message: string }) => void)[] = []

    subClient.on('message', (channel, message) => {
      const entry = { channel, message }
      const waiter = waiters.shift()
      if (waiter) {
        waiter(entry)
      } else {
        buffer.push(entry)
      }
    })

    await subClient.subscribe(...channels)

    return {
      async waitForMessage(timeoutMs = 30_000) {
        if (buffer.length > 0) {
          return buffer.shift()!
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const idx = waiters.indexOf(waiter)
            if (idx >= 0) waiters.splice(idx, 1)
            reject(
              new Error(
                `Timed out after ${timeoutMs}ms waiting for pub/sub message on ${channels.join(', ')}`,
              ),
            )
          }, timeoutMs)
          const waiter = (msg: { channel: string; message: string }) => {
            clearTimeout(timer)
            resolve(msg)
          }
          waiters.push(waiter)
        })
      },
      async close() {
        await subClient.quit()
      },
    }
  }

  /** Close the connection. */
  async close(): Promise<void> {
    await this.client.quit()
  }
}

/** Handle returned by {@link RedisClient.subscribe}. */
export interface PubSubSubscription {
  /** Await the next message on any subscribed channel, or throw on timeout. */
  waitForMessage(timeoutMs?: number): Promise<{ channel: string; message: string }>
  /** Close the subscription's dedicated connection. */
  close(): Promise<void>
}
