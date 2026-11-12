import { RedisClient } from '../clients/redis-client'
import { defineAdapter } from '../support/adapter'
import type { Adapter } from '../support/adapter'

export interface RedisAdapterOptions {
  /** Empty means not configured: only the subscription cleanup runs. */
  url: string
}

/** Flushes the database before each scenario, closes subscriptions after. State is the client. */
export function redisAdapter(options: RedisAdapterOptions): Adapter<RedisClient | undefined> {
  return defineAdapter<RedisClient | undefined>({
    name: 'redis',
    setup: () => (options.url ? new RedisClient(options.url) : undefined),
    ...(options.url && {
      async beforeScenario(world, redis) {
        world.redis = redis
        await redis?.flushDb()
      },
    }),
    async afterScenario(world) {
      // Steps' subscriptions, and one a suite's own step left as the active one.
      const subscriptions = new Set(world.subscriptions ?? [])
      if (world.activeSubscription) subscriptions.add(world.activeSubscription)
      for (const sub of subscriptions) {
        try {
          await sub.close()
        } catch {
          /* best-effort */
        }
      }
      world.subscriptions = []
      world.activeSubscription = undefined
    },
  })
}
