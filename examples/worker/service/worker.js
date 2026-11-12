// The service under test: a worker that takes jobs from a Redis channel,
// records each in Postgres and leaves a result under a Redis key.
const http = require('http')
const { Pool } = require('pg')
const Redis = require('ioredis')

const db = new Pool({ connectionString: process.env.DATABASE_URL })
const redis = new Redis(process.env.REDIS_URL)
// No ready check: its INFO command is refused once the connection subscribes.
const subscriber = new Redis(process.env.REDIS_URL, { enableReadyCheck: false })

async function handle(job) {
  const status = job.fail ? 'failed' : 'done'
  await db.query(
    'INSERT INTO worker_jobs (job_id, status) VALUES ($1, $2) ON CONFLICT (job_id) DO NOTHING',
    [job.id, status],
  )
  await redis.set(`job:${job.id}`, JSON.stringify({ status }))
}

async function main() {
  await db.query('CREATE TABLE IF NOT EXISTS worker_jobs (job_id text PRIMARY KEY, status text)')
  subscriber.on('message', (_channel, message) => {
    handle(JSON.parse(message)).catch((err) => console.error(err))
  })
  await subscriber.subscribe('jobs')
  // Ready only once subscribed, so a message sent after the check isn't lost.
  http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT))
}

main()
