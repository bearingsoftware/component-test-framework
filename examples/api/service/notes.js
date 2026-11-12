// The service under test: saves a note in Postgres once a moderation
// service (WireMock, in the suite) says it's fine.
const http = require('http')
const { Pool } = require('pg')

const db = new Pool({ connectionString: process.env.DATABASE_URL })

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function createNote(req, res) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const { title } = JSON.parse(raw)
  const check = await fetch(`${process.env.MODERATION_URL}/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: title }),
  })
  if (!check.ok) return json(res, 422, { error: 'note rejected' })
  await db.query('INSERT INTO api_notes (title) VALUES ($1)', [title])
  json(res, 201, { title })
}

db.query('CREATE TABLE IF NOT EXISTS api_notes (id serial PRIMARY KEY, title text NOT NULL)').then(
  () =>
    http
      .createServer((req, res) => {
        if (req.url === '/health') return json(res, 200, { ok: true })
        if (req.method === 'POST' && req.url === '/notes') {
          return createNote(req, res).catch((err) => json(res, 500, { error: String(err) }))
        }
        json(res, 404, { error: 'not found' })
      })
      .listen(Number(process.env.PORT)),
)
