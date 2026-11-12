// Live: starts real containers. Run with CTF_TESTCONTAINERS=1 and Docker.
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import Redis from 'ioredis'
import { startContainers, stopContainers } from './testcontainers'
import { WireMockClient } from './clients/wiremock-client'

const live = process.env.CTF_TESTCONTAINERS === '1'
const URLS = ['DATABASE_URL', 'REDIS_URL', 'WIREMOCK_URL']

describe.skipIf(!live)('startContainers against Docker', () => {
  afterAll(async () => {
    await stopContainers()
    for (const k of URLS) delete process.env[k]
  })

  async function ping(url: string): Promise<string> {
    const redis = new Redis(url, { lazyConnect: true })
    try {
      await redis.connect()
      await redis.set('k', 'v')
      return `${await redis.ping()} ${await redis.get('k')}`
    } finally {
      redis.disconnect()
    }
  }

  it('starts Postgres, Valkey and WireMock, then Redis, and each answers', async () => {
    for (const k of URLS) delete process.env[k]
    const began = Date.now()
    const result = await startContainers({
      postgres: { image: 'postgres:17-alpine', database: 'app' },
      redis: { image: 'valkey/valkey:8-alpine' },
      wiremock: { image: 'wiremock/wiremock:3.13.2' },
    })
    console.log(`postgres, valkey and wiremock started in ${Date.now() - began} ms`)
    expect(result).toEqual({ started: ['postgres', 'redis', 'wiremock'], skipped: [] })

    const db = new Client({ connectionString: process.env.DATABASE_URL })
    await db.connect()
    const row = await db.query('select current_database() as name')
    await db.end()
    expect(row.rows[0].name).toBe('app')

    expect(await ping(process.env.REDIS_URL as string)).toBe('PONG v')

    const wiremock = new WireMockClient(process.env.WIREMOCK_URL as string)
    await wiremock.resetAll()
    const health = await fetch(`${process.env.WIREMOCK_URL}/__admin/health`)
    expect(health.status).toBe(200)

    const redisBegan = Date.now()
    delete process.env.REDIS_URL
    const again = await startContainers({ redis: { image: 'redis:7-alpine' } })
    console.log(`redis started in ${Date.now() - redisBegan} ms`)
    expect(again.started).toEqual(['redis'])
    expect(await ping(process.env.REDIS_URL ?? '')).toBe('PONG v')
  }, 120_000)
})
