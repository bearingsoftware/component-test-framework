// `npm run examples:test`: runs the three example suites, then runs `ctf init`
// into a temporary directory and runs the feature it writes, for each service.
// Needs the built package (npm run build) and the services the suites use:
// WIREMOCK_URL, DATABASE_URL and REDIS_URL, MAILPIT_URL and WEB_PORT, as for
// the other suites.
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..')
const CUCUMBER = path.join(REPO, 'node_modules', '@cucumber', 'cucumber', 'bin', 'cucumber.js')
const CTF = path.join(REPO, 'dist', 'cli.js')

function run(file, args, cwd, env = {}) {
  const { status } = spawnSync(process.execPath, [file, ...args], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  return status === 0
}

const failures = []

for (const name of ['api', 'worker', 'spa']) {
  console.log(`\n== examples/${name}`)
  if (!run(CUCUMBER, ['--config', `examples/${name}/cucumber.js`], REPO)) {
    failures.push(`examples/${name}`)
  }
}

// ts-node is a dependency of a consumer's suite, not of this package, so a
// stand-in that compiles .ts files with the TypeScript here lets the
// generated cucumber.js run unchanged.
const TS_NODE_SHIM = `
const fs = require('fs')
const ts = require(${JSON.stringify(require.resolve('typescript'))})
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf-8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  })
  module._compile(outputText, filename)
}
`

// Inside the repository, so @cucumber/cucumber resolves to the one the package uses.
const scratch = fs.mkdtempSync(path.join(__dirname, '.scaffold-'))
try {
  for (const pieces of [undefined, 'postgres', 'redis', 'mailpit', 'spa']) {
    const label = `ctf init${pieces ? ` --with ${pieces}` : ''}`
    console.log(`\n== ${label}`)
    const dir = path.join(scratch, pieces ?? 'default')
    fs.mkdirSync(path.join(dir, 'node_modules', '@bearingsoftware'), { recursive: true })
    fs.symlinkSync(
      REPO,
      path.join(dir, 'node_modules', '@bearingsoftware', 'component-test-framework'),
    )
    fs.mkdirSync(path.join(dir, 'node_modules', 'ts-node'))
    fs.writeFileSync(path.join(dir, 'node_modules', 'ts-node', 'register.js'), TS_NODE_SHIM)
    const initArgs = ['init', '.', ...(pieces ? ['--with', pieces] : [])]
    // Cucumber resolves ts-node from its own location, so the shim goes on NODE_PATH.
    const nodePath = path.join(dir, 'node_modules')
    if (!run(CTF, initArgs, dir) || !run(CUCUMBER, [], dir, { NODE_PATH: nodePath })) {
      failures.push(label)
    }
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nFailed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll examples passed')
