import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prepareWorkerDatabase } from './worker-database'

// Nothing listens here, so a copy that gets as far as connecting fails fast.
const unreachable = (db: string) => `postgres://u:p@127.0.0.1:1/${db}`

describe('prepareWorkerDatabase (COMPONENT-11)', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      CUCUMBER_PARALLEL: 'true',
      CUCUMBER_WORKER_ID: '1',
      CUCUMBER_TOTAL_WORKERS: '4',
    })
  })

  afterEach(() => {
    delete process.env.CUCUMBER_PARALLEL
    delete process.env.CUCUMBER_WORKER_ID
    delete process.env.CUCUMBER_TOTAL_WORKERS
  })

  it('does nothing outside a parallel run', async () => {
    delete process.env.CUCUMBER_PARALLEL
    await expect(prepareWorkerDatabase(unreachable('app'))).resolves.toBe(unreachable('app'))
  })

  it('refuses a second call that names a different template', async () => {
    const first = prepareWorkerDatabase(unreachable('orders'), { template: 'orders_template' })
    first.catch(() => {})
    await expect(prepareWorkerDatabase(unreachable('orders'))).rejects.toThrow(
      /copy "orders_w1" from "orders", but an earlier call copies it from "orders_template"/,
    )
    await expect(first).rejects.toThrow()
  })

  it('refuses a name Postgres would cut short', async () => {
    await expect(prepareWorkerDatabase(unreachable('x'.repeat(61)))).rejects.toThrow(
      /longer than Postgres's 63 bytes/,
    )
  })

  it('refuses to copy the database it would connect through', async () => {
    await expect(
      prepareWorkerDatabase(unreachable('shop'), { maintenanceDatabase: 'shop' }),
    ).rejects.toThrow(/"shop" can't also be the maintenance database/)
  })
})
