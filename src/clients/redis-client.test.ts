import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RedisClient } from './redis-client'

// Against a real Redis: REDIS_URL, which CI's unit-test job sets. Without it
// these tests are skipped.
const url = process.env.REDIS_URL

describe.skipIf(!url)('RedisClient against Redis (COMPONENT-15)', () => {
  let redis: RedisClient
  // Channel names are per run, as pub/sub is shared by every database.
  const run = `ctf-test-${process.pid}-${Date.now()}`

  beforeAll(() => {
    redis = new RedisClient(url as string)
  })

  afterAll(async () => {
    await redis.close()
  })

  it('subscribes to a channel and receives what is published, with the channel', async () => {
    const sub = await redis.subscribe(`${run}:plain`)
    try {
      expect(await redis.publish(`${run}:plain`, 'hello')).toBe(1)
      expect(await sub.waitForMessage(2_000)).toEqual({ channel: `${run}:plain`, message: 'hello' })
    } finally {
      await sub.close()
    }
  })

  it('subscribes by pattern, and messages carry the pattern and the channel', async () => {
    const sub = await redis.psubscribe(`${run}:user:*`)
    try {
      await redis.publish(`${run}:user:42`, '{"type":"reading"}')
      await redis.publish(`${run}:user:42`, '{"type":"optimiser","id":7}')
      const found = await sub.waitForMessage(
        (m) => JSON.parse(m.message).type === 'optimiser',
        2_000,
      )
      expect(found).toEqual({
        pattern: `${run}:user:*`,
        channel: `${run}:user:42`,
        message: '{"type":"optimiser","id":7}',
      })
    } finally {
      await sub.close()
    }
  })

  it('times out naming the pattern when nothing arrives', async () => {
    const sub = await redis.psubscribe(`${run}:quiet:*`)
    try {
      await expect(sub.waitForMessage(50)).rejects.toThrow(
        `Timed out after 50ms waiting for a pub/sub message on pattern ${run}:quiet:*`,
      )
    } finally {
      await sub.close()
      await sub.close()
    }
  })

  it('publishes until a late subscriber hears it', async () => {
    const channel = `${run}:late`
    let sub: Awaited<ReturnType<RedisClient['subscribe']>> | undefined
    const subscribing = new Promise<void>((resolve) =>
      setTimeout(async () => {
        sub = await redis.subscribe(channel)
        resolve()
      }, 150),
    )
    try {
      const heard = await redis.publishUntilHeard(channel, 'go', {
        timeoutMs: 3_000,
        intervalMs: 50,
      })
      expect(heard).toBe(1)
      await subscribing
      expect((await sub!.waitForMessage(1_000)).message).toBe('go')
    } finally {
      await subscribing
      await sub?.close()
    }
  })

  it('says how many heard the last publish when nobody does', async () => {
    await expect(
      redis.publishUntilHeard(`${run}:nobody`, 'x', { timeoutMs: 100, intervalMs: 20 }),
    ).rejects.toThrow(`publishing to ${run}:nobody: the last publish reached 0 subscriber(s)`)
  })

  it('keeps publishing until the until condition holds', async () => {
    const channel = `${run}:until`
    const sub = await redis.subscribe(channel)
    let checks = 0
    try {
      await redis.publishUntilHeard(channel, 'x', { intervalMs: 10, until: () => ++checks >= 3 })
      expect(checks).toBe(3)
    } finally {
      await sub.close()
    }
  })

  it('waits for a value to match JSON partially, a string exactly, or a function', async () => {
    const key = `${run}:value`
    setTimeout(() => void redis.set(key, '{"status":"pending"}'), 20)
    setTimeout(() => void redis.set(key, '{"status":"done","count":2}'), 120)
    const value = await redis.waitForValue(
      key,
      { status: 'done' },
      { timeoutMs: 2_000, intervalMs: 20 },
    )
    expect(JSON.parse(value)).toEqual({ status: 'done', count: 2 })
    await redis.waitForValue(key, '{"status":"done","count":2}', { timeoutMs: 200 })
    await redis.waitForValue(key, (v) => v.includes('done'), { timeoutMs: 200 })
    await redis.del(key)
  })

  it('reports the last mismatch when the value never matches', async () => {
    const key = `${run}:stuck`
    await redis.set(key, '{"status":"pending"}')
    await expect(
      redis.waitForValue(key, { status: 'done' }, { timeoutMs: 100, intervalMs: 20 }),
    ).rejects.toThrow(
      /waiting for Redis key ".*:stuck".*timed out after 100ms[\s\S]*Mismatch at status/,
    )
    await redis.del(key)
    await expect(redis.waitForValue(key, 'x', { timeoutMs: 50 })).rejects.toThrow(/is unset/)
  })
})
