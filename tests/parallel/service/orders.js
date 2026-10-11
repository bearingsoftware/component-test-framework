// The reference suite's service under test: an orders API that prices an
// order from a pricing service (WireMock in the suite), saves it in Postgres
// and caches it in Redis. Each parallel worker runs its own copy, pointed at
// its own database, Redis index and WireMock prefix.
const http = require('http')
const { Pool } = require('pg')
const Redis = require('ioredis')

const port = Number(process.env.PORT)
const pricingUrl = process.env.PRICING_URL
const db = new Pool({ connectionString: process.env.DATABASE_URL })
const redis = new Redis(process.env.REDIS_URL)

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  return body ? JSON.parse(body) : {}
}

async function placeOrder(req, res) {
  const { sku, qty } = await readBody(req)
  const quote = await fetch(`${pricingUrl}/prices/${encodeURIComponent(sku)}`)
  if (!quote.ok) return json(res, 502, { error: `pricing answered ${quote.status}` })
  const { price } = await quote.json()
  // Long enough that scenarios in other workers overlap this one.
  await new Promise((resolve) => setTimeout(resolve, 150))
  const total = price * qty
  const { rows } = await db.query(
    'INSERT INTO orders (sku, qty, total) VALUES ($1, $2, $3) RETURNING id',
    [sku, qty, total],
  )
  await redis.set('last-order-total', String(total))
  json(res, 201, { id: rows[0].id, total })
}

http
  .createServer((req, res) => {
    if (req.url === '/health') return json(res, 200, { ok: true })
    if (req.method === 'POST' && req.url === '/orders') {
      return placeOrder(req, res).catch((err) => json(res, 500, { error: String(err) }))
    }
    json(res, 404, { error: 'not found' })
  })
  .listen(port, () => console.log(`orders listening on ${port}`))
