import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import ts from 'typescript'
import { main } from '../cli'
import { PIECES, type Piece } from './init'

const REPO = path.resolve(__dirname, '..', '..')

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-init-'))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const read = (file: string) => fs.readFileSync(path.join(dir, file), 'utf-8')
const written = () =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort()

const BASE = [
  '.env.example',
  'cucumber.js',
  'docker-compose.yml',
  'features/example.feature',
  'support/operation-map.ts',
  'support/setup.ts',
  'tsconfig.json',
]

const IMAGES: Record<Exclude<Piece, 'spa'>, string> = {
  wiremock: 'wiremock/wiremock:3.13.2',
  postgres: 'postgres:17-alpine',
  redis: 'redis:7-alpine',
  mailpit: 'axllent/mailpit:v1.33',
}

const ENV: Record<Piece, string> = {
  wiremock: 'WIREMOCK_URL=',
  postgres: 'DATABASE_URL=',
  redis: 'REDIS_URL=',
  mailpit: 'MAILPIT_URL=',
  spa: 'WEB_PORT=',
}

const COMBINATIONS: Piece[][] = [
  ['wiremock'],
  ['postgres'],
  ['redis'],
  ['mailpit'],
  ['spa'],
  ['wiremock', 'postgres'],
  ['postgres', 'redis', 'mailpit'],
  [...PIECES],
]

describe('ctf init', () => {
  it('defaults to WireMock in the current directory', () => {
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      expect(main(['init'])).toBe(0)
    } finally {
      process.chdir(cwd)
    }
    expect(written()).toEqual(BASE)
    expect(read('docker-compose.yml')).toContain(IMAGES.wiremock)
    expect(read('docker-compose.yml')).not.toContain('postgres')
    expect(read('features/example.feature')).toContain('hello operation')
  })

  it.each(COMBINATIONS)('writes the files for --with %s', (...pieces) => {
    expect(main(['init', dir, '--with', pieces.join(',')])).toBe(0)
    const withSpa = pieces.includes('spa')
    expect(written()).toEqual(
      withSpa ? [...BASE, 'pages/home.page.ts', 'web/index.html'].sort() : BASE,
    )

    const chosen = new Set<Piece>(pieces)
    if (withSpa) chosen.add('wiremock')
    const compose = read('docker-compose.yml')
    const env = read('.env.example')
    const setup = read('support/setup.ts')
    for (const piece of PIECES) {
      const image = piece === 'spa' ? undefined : IMAGES[piece]
      if (image) expect(compose.includes(image)).toBe(chosen.has(piece))
      expect(env.includes(ENV[piece])).toBe(chosen.has(piece))
    }
    expect(setup.includes('registerRedisSteps()')).toBe(chosen.has('redis'))
    expect(setup.includes('registerDbSteps()')).toBe(chosen.has('postgres'))
    expect(setup.includes('registerMailpitSteps()')).toBe(chosen.has('mailpit'))
    expect(setup.includes('registerWiremockSteps()')).toBe(chosen.has('wiremock'))
    expect(setup.includes('registerSpaServer')).toBe(withSpa)
    expect(setup).not.toContain('void ')
    expect(read('cucumber.js')).toContain('cucumberPreset()')
  })

  it('prints the next steps', () => {
    main(['init', dir])
    const out = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(out).toContain('docker compose up -d')
    expect(out).toContain('npx cucumber-js')
  })

  it('refuses to overwrite, naming the file, and --force replaces it', () => {
    fs.writeFileSync(path.join(dir, 'cucumber.js'), '// mine\n')
    expect(main(['init', dir])).toBe(2)
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      path.join(dir, 'cucumber.js'),
    )
    expect(read('cucumber.js')).toBe('// mine\n')
    expect(fs.existsSync(path.join(dir, 'support'))).toBe(false)

    expect(main(['init', dir, '--force'])).toBe(0)
    expect(read('cucumber.js')).toContain('cucumberPreset()')
  })

  it('rejects an unknown name, listing the valid ones', () => {
    expect(main(['init', dir, '--with', 'wiremock,mysql'])).toBe(2)
    const err = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(err).toContain('mysql')
    for (const piece of PIECES) expect(err).toContain(piece)
    expect(written()).toEqual([])
  })

  // The generated code compiled against the package's own sources, with the
  // package name mapped to src, so it needs no build and no install.
  it.each(COMBINATIONS)(
    'generates setup.ts and cucumber.js that typecheck for --with %s',
    (...pieces) => {
      main(['init', dir, '--with', pieces.join(',')])
      const entries = Object.entries({
        '@bearingsoftware/component-test-framework': ['src/index.ts'],
        '@bearingsoftware/component-test-framework/*': ['src/*'],
      })
      const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        allowJs: true,
        checkJs: true,
        noEmit: true,
        baseUrl: REPO,
        paths: Object.fromEntries(entries),
        typeRoots: [path.join(REPO, 'node_modules', '@types')],
        types: ['node'],
      }
      const roots = written()
        .filter((f) => f === 'cucumber.js' || f.endsWith('.ts'))
        .map((f) => path.join(dir, f))
      const program = ts.createProgram(roots, options)
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .filter((d) => d.file && path.resolve(d.file.fileName).startsWith(dir))
        .map((d) => `${d.file?.fileName}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
      expect(diagnostics).toEqual([])
    },
  )
})

describe('ctf init output details', () => {
  it('lists services in a fixed order whatever order --with gives', () => {
    main(['init', dir, '--with', 'mailpit,redis,postgres,wiremock'])
    const compose = read('docker-compose.yml')
    const at = (name: string) => compose.indexOf(`  ${name}:\n`)
    expect([at('wiremock'), at('postgres'), at('redis'), at('mailpit')]).toEqual(
      [at('wiremock'), at('postgres'), at('redis'), at('mailpit')].sort((a, b) => a - b),
    )
    expect(at('wiremock')).toBeGreaterThanOrEqual(0)
    const setup = read('support/setup.ts')
    const calls = [
      'registerWiremockSteps()',
      'registerDbSteps()',
      'registerRedisSteps()',
      'registerMailpitSteps()',
    ]
    const positions = calls.map((c) => setup.indexOf(c))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(positions.every((p) => p >= 0)).toBe(true)
  })

  it('gives every compose service a healthcheck and the ports .env.example names', () => {
    main(['init', dir, '--with', 'wiremock,postgres,redis,mailpit'])
    const compose = read('docker-compose.yml')
    expect(compose.match(/healthcheck:/g)).toHaveLength(4)
    for (const command of [
      'curl -sf http://localhost:8080/__admin/health',
      '"pg_isready -h 127.0.0.1 -U postgres"',
      '["CMD", "redis-cli", "ping"]',
      '["CMD", "/mailpit", "readyz"]',
    ]) {
      expect(compose).toContain(command)
    }
    const env = read('.env.example')
    for (const port of [
      'WIREMOCK_PORT',
      'POSTGRES_PORT',
      'REDIS_PORT',
      'MAILPIT_PORT',
      'MAILPIT_SMTP_PORT',
    ]) {
      expect(compose).toContain(`\${${port}:-`)
      expect(env).toContain(`${port}=`)
    }
  })

  it('prints the install command for the chosen pieces, with --wait', () => {
    main(['init', dir])
    let out = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(out).toContain(
      'npm install --save-dev @cucumber/cucumber ts-node typescript@5 @types/node\n',
    )
    expect(out).toContain('docker compose up -d --wait')
    expect(out).not.toContain('playwright')

    vi.mocked(console.log).mockClear()
    main(['init', dir, '--force', '--with', 'spa'])
    out = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(out).toContain('@types/node @playwright/test')
    expect(out).toContain('npx playwright install chromium')
  })

  it('loads .env in the generated cucumber.js only when it exists', () => {
    main(['init', dir])
    expect(read('cucumber.js')).toContain('process.loadEnvFile(envFile)')
    expect(read('cucumber.js')).toContain('fs.existsSync(envFile)')
  })

  it("matches the setup.ts shown in the README's quick start", () => {
    main(['init', dir])
    const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf-8')
    const quick = readme.slice(readme.indexOf('## Quick start'))
    const snippet = /```typescript\n([\s\S]*?)```/.exec(quick)?.[1]
    expect(snippet).toBe(read('support/setup.ts'))
  })

  it('never replaces an existing tsconfig.json, with or without --force', () => {
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{ "mine": true }\n')
    expect(main(['init', dir])).toBe(0)
    expect(read('tsconfig.json')).toBe('{ "mine": true }\n')
    const out = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(out).toContain('Kept your tsconfig.json')
    expect(out).toContain('esModuleInterop')
    expect(main(['init', dir, '--force'])).toBe(0)
    expect(read('tsconfig.json')).toBe('{ "mine": true }\n')
    expect(read('cucumber.js')).toContain('cucumberPreset()')
  })
})

describe('ctf init --containers', () => {
  const NO_COMPOSE = BASE.filter((f) => f !== 'cucumber.js' && f !== 'docker-compose.yml')

  it.each([
    ['wiremock'],
    ['postgres'],
    ['redis'],
    ['wiremock', 'postgres', 'redis'],
    ['spa', 'postgres'],
  ] as Piece[][])('writes cucumber.mjs and no compose file for --with %s', (...pieces) => {
    expect(main(['init', dir, '--with', pieces.join(','), '--containers'])).toBe(0)
    const withSpa = pieces.includes('spa')
    expect(written()).toEqual(
      [
        ...NO_COMPOSE,
        'cucumber.mjs',
        ...(withSpa ? ['pages/home.page.ts', 'web/index.html'] : []),
      ].sort(),
    )
    const chosen = new Set<Piece>(pieces)
    if (withSpa) chosen.add('wiremock')
    const mjs = read('cucumber.mjs')
    expect(mjs).toContain(`from '@bearingsoftware/component-test-framework/testcontainers'`)
    expect(mjs).toContain('await startContainers({')
    expect(mjs).toContain('export default cucumberPreset()')
    for (const piece of ['wiremock', 'postgres', 'redis'] as const) {
      expect(mjs.includes(IMAGES[piece])).toBe(chosen.has(piece))
    }
    expect(read('features/example.feature')).not.toContain('docker-compose')
    expect(() =>
      execFileSync(process.execPath, ['--check', path.join(dir, 'cucumber.mjs')]),
    ).not.toThrow()
  })

  it('prints install and run steps with the testcontainers packages and no docker compose', () => {
    main(['init', dir, '--with', 'wiremock,postgres', '--containers'])
    const out = vi.mocked(console.log).mock.calls.flat().join('\n')
    expect(out).toContain('testcontainers @testcontainers/postgresql\n')
    expect(out).not.toContain('@testcontainers/redis')
    expect(out).not.toContain('docker compose')
    expect(out).toContain('npx cucumber-js')
  })

  it('rejects mailpit, which has no container, and writes nothing', () => {
    expect(main(['init', dir, '--with', 'mailpit', '--containers'])).toBe(2)
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('Mailpit')
    expect(written()).toEqual([])
  })

  it('leaves the output without --containers unchanged', () => {
    main(['init', dir])
    expect(written()).toEqual(BASE)
    expect(read('cucumber.js')).not.toContain('startContainers')
  })
})
