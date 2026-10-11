// `@bearingsoftware/component-test-framework/redis`: the Redis / Valkey
// client and its steps. Registers nothing on import; ioredis is loaded when a
// RedisClient is first created.
export { RedisClient } from './clients/redis-client'
export type {
  PubSubSubscription,
  PubSubMessage,
  MessagePredicate,
  ValueMatcher,
} from './clients/redis-client'
export { registerRedisSteps } from './steps/register'
