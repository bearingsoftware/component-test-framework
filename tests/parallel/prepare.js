// Create the reference suite's template database: the one each parallel
// worker copies. Run before the suite (npm run test:parallel does).
const { Client } = require('pg')

const DEFAULT_URL = 'postgres://postgres:postgres@localhost:55440/ctf_reference'

async function prepare(databaseUrl = process.env.DATABASE_URL ?? DEFAULT_URL) {
  const url = new URL(databaseUrl)
  const name = url.pathname.slice(1)
  const maintenance = new URL(url)
  maintenance.pathname = '/postgres'
  const admin = new Client({ connectionString: maintenance.toString() })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.query(`CREATE DATABASE "${name}"`)
  await admin.end()

  const db = new Client({ connectionString: url.toString() })
  await db.connect()
  await db.query(`
    CREATE TABLE orders (
      id serial PRIMARY KEY,
      sku text NOT NULL,
      qty integer NOT NULL,
      total integer NOT NULL
    )`)
  await db.end()
  console.log(`template database ${name} ready`)
}

module.exports = { prepare }

if (require.main === module) {
  prepare().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
