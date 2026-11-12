// `npm run examples:test`: runs the three example suites, then the scaffold
// check, which installs the packed package into a temporary project the way a
// consumer does, runs `ctf init` for each service, starts the generated
// docker-compose.yml with `--wait`, and runs the generated feature under real
// ts-node with type-checking on.
//
// Needs the built package (npm run build), Docker, and network access to
// registry.npmjs.org, which the temporary project's installs use whatever
// ~/.npmrc says. The example
// suites read WIREMOCK_URL, DATABASE_URL, REDIS_URL and WEB_PORT as the other
// suites do; the scaffold check picks free ports of its own.
// EXAMPLES_COMPOSE_PROJECT names the scaffold's compose project.
const { spawnSync } = require('child_process')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..')
const COMPOSE_PROJECT = process.env.EXAMPLES_COMPOSE_PROJECT ?? 'ctf-scaffold'

function run(command, args, cwd, env = {}) {
  const merged = { ...process.env, ...env }
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key]
  const { status } = spawnSync(command, args, { cwd, stdio: 'inherit', env: merged })
  return status === 0
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

// Only the chosen services' variables: a REDIS_URL left in the environment
// would make a suite without Redis try to flush one.
async function scaffoldEnv(pieces) {
  const [wiremock, postgres, redis, mailpit, smtp, web] = await Promise.all(
    Array.from({ length: 6 }, freePort),
  )
  const all = {
    WIREMOCK_PORT: String(wiremock),
    WIREMOCK_URL: `http://localhost:${wiremock}`,
    POSTGRES_PORT: String(postgres),
    DATABASE_URL: `postgres://postgres:postgres@localhost:${postgres}/postgres`,
    REDIS_PORT: String(redis),
    REDIS_URL: `redis://localhost:${redis}`,
    MAILPIT_PORT: String(mailpit),
    MAILPIT_SMTP_PORT: String(smtp),
    MAILPIT_URL: `http://localhost:${mailpit}`,
    WEB_PORT: String(web),
    COMPOSE_PROJECT_NAME: COMPOSE_PROJECT,
  }
  const uses = {
    wiremock: ['WIREMOCK_PORT', 'WIREMOCK_URL'],
    postgres: ['POSTGRES_PORT', 'DATABASE_URL'],
    redis: ['REDIS_PORT', 'REDIS_URL'],
    mailpit: ['MAILPIT_PORT', 'MAILPIT_SMTP_PORT', 'MAILPIT_URL'],
    spa: ['WEB_PORT'],
  }
  const wanted = new Set(pieces.flatMap((p) => uses[p]))
  const env = { COMPOSE_PROJECT_NAME: COMPOSE_PROJECT }
  for (const key of Object.keys(all))
    if (key !== 'COMPOSE_PROJECT_NAME') env[key] = wanted.has(key) ? all[key] : undefined
  return env
}

async function main() {
  const failures = []
  const cucumber = path.join(REPO, 'node_modules', '@cucumber', 'cucumber', 'bin', 'cucumber.js')

  for (const name of ['api', 'worker', 'spa']) {
    console.log(`\n== examples/${name}`)
    if (!run(process.execPath, [cucumber, '--config', `examples/${name}/cucumber.js`], REPO)) {
      failures.push(`examples/${name}`)
    }
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-scaffold-'))
  const project = path.join(scratch, 'project')
  fs.mkdirSync(project)
  try {
    console.log('\n== packing and installing the package into a temporary project')
    const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', scratch], {
      cwd: REPO,
      encoding: 'utf-8',
    })
    if (packed.status !== 0) throw new Error(`npm pack failed:\n${packed.stderr}`)
    const tarball = path.join(scratch, packed.stdout.trim().split('\n').pop())
    fs.writeFileSync(
      path.join(project, 'package.json'),
      '{ "name": "scaffold-check", "private": true }',
    )
    const installed = run(
      'npm',
      [
        'install',
        '--registry',
        'https://registry.npmjs.org/',
        '--no-audit',
        '--no-fund',
        tarball,
        '@cucumber/cucumber',
        'ts-node',
        'typescript@5',
        '@types/node',
        '@playwright/test',
      ],
      project,
    )
    if (!installed) throw new Error('installing into the temporary project failed')

    const bin = (name) => path.join(project, 'node_modules', '.bin', name)
    for (const pieces of [undefined, 'postgres', 'redis', 'mailpit', 'spa']) {
      const label = `ctf init${pieces ? ` --with ${pieces}` : ''}`
      console.log(`\n== ${label}`)
      const dir = path.join(project, pieces ?? 'default')
      const env = await scaffoldEnv(pieces === 'spa' ? ['wiremock', 'spa'] : [pieces ?? 'wiremock'])
      const compose = ['compose', '-f', path.join(dir, 'docker-compose.yml')]
      const initArgs = ['init', dir, ...(pieces ? ['--with', pieces] : [])]
      let ok = run(bin('ctf'), initArgs, project)
      if (ok) {
        ok = run('docker', [...compose, 'up', '-d', '--wait'], dir, env)
        try {
          ok = ok && run(bin('cucumber-js'), [], dir, env)
        } finally {
          run('docker', [...compose, 'down', '-v'], dir, env)
        }
      }
      if (!ok) failures.push(label)
    }
  } catch (err) {
    console.error(err.message)
    failures.push('scaffold setup')
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nFailed: ${failures.join(', ')}`)
    process.exit(1)
  }
  console.log('\nAll examples passed')
}

main()
