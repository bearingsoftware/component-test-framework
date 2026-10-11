// Create the reference suite's template database: the one each parallel
// worker copies. Run before the suite (npm run test:parallel does).
const { Client } = require('pg')

const url = new URL(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55440/ctf_reference',
)
const name = url.pathname.slice(1)

async function main() {
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

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
