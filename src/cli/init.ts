// `ctf init`: the files a new suite starts from. Plain string templates, no
// template engine.
import * as fs from 'fs'
import * as path from 'path'

export const PIECES = ['wiremock', 'postgres', 'redis', 'mailpit', 'spa'] as const
export type Piece = (typeof PIECES)[number]

const PKG = '@bearingsoftware/component-test-framework'

/** The pieces to scaffold, in a fixed order. The SPA server forwards to WireMock, so `spa` brings it in. */
export function normalisePieces(pieces: Piece[]): Piece[] {
  const wanted = new Set<Piece>(pieces)
  if (wanted.has('spa')) wanted.add('wiremock')
  return PIECES.filter((p) => wanted.has(p))
}

const CUCUMBER_JS = `const { cucumberPreset } = require('${PKG}/preset')

module.exports = { default: cucumberPreset() }
`

const OPERATION_MAP = `import type { OperationMap } from '${PKG}/core'

// Each OpenAPI operationId and where it lives. \`ctf generate-operation-map\`
// can write this from a spec.
export const operationMap: OperationMap = {
  hello: { method: 'GET', path: '/hello' },
}
`

function setupTs(pieces: Piece[]): string {
  const has = (p: Piece) => pieces.includes(p)
  const coreImports = ['loadConfig', 'registerHooks', 'registerApiSteps', 'registerResponseSteps']
  const imports: string[] = []
  if (has('spa')) imports.push(`import * as path from 'path'`)
  imports.push(`import {\n${coreImports.map((n) => `  ${n},`).join('\n')}\n} from '${PKG}/core'`)
  if (has('wiremock')) imports.push(`import { registerWiremockSteps } from '${PKG}/wiremock'`)
  if (has('postgres')) imports.push(`import { registerDbSteps } from '${PKG}/postgres'`)
  if (has('redis')) imports.push(`import { registerRedisSteps } from '${PKG}/redis'`)
  if (has('mailpit')) imports.push(`import { registerMailpitSteps } from '${PKG}/mailpit'`)
  if (has('spa')) {
    imports.push(`import { registerUiSteps } from '${PKG}/playwright'`)
    imports.push(`import { registerSpaServer } from '${PKG}/spa'`)
    imports.push(`import { HomePage } from '../pages/home.page'`)
  }
  imports.push(`import { operationMap } from './operation-map'`)

  const body: string[] = ['const config = loadConfig()']
  if (has('spa')) {
    body.push(
      '',
      '// Serves web/ on WEB_PORT (default 3100) and forwards /api/* to WireMock.',
      'const spa = registerSpaServer({',
      `  distDir: path.resolve(__dirname, '..', 'web'),`,
      `  apiUrl: config.wiremockUrl,`,
      '})',
    )
  }
  const options: string[] = ['...config', 'operationMap']
  if (has('wiremock')) {
    options.push(
      '// WireMock stands in for the API under test. Set API_BASE_URL to use your own.',
      'apiBaseUrl: process.env.API_BASE_URL ?? config.wiremockUrl',
    )
  } else {
    options.push('wiremockUrl: undefined')
  }
  if (has('postgres')) {
    options.push(
      `databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'`,
    )
  }
  if (has('redis')) options.push(`redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379'`)
  if (has('spa')) options.push('webBaseUrl: spa.baseUrl', 'pages: { home: HomePage }')
  body.push(
    '',
    'registerHooks({',
    ...options.map((o) => `  ${o}${o.startsWith('//') ? '' : ','}`),
    '})',
  )

  const steps = ['registerApiSteps()', 'registerResponseSteps()']
  if (has('wiremock')) steps.push('registerWiremockSteps()')
  if (has('postgres')) steps.push('registerDbSteps()')
  if (has('redis')) steps.push('registerRedisSteps()')
  if (has('mailpit')) steps.push('registerMailpitSteps()')
  if (has('spa')) steps.push('registerUiSteps()')

  return `${imports.join('\n')}\n\n${body.join('\n')}\n\n${steps.join('\n')}\n`
}

function exampleFeature(pieces: Piece[]): string {
  if (pieces.includes('spa')) {
    return `Feature: Example
  A scenario against the page in web/, served by the SPA server.

  @ui
  Scenario: The home page loads
    Given I navigate to the home page
    Then I should see greeting on the home page
`
  }
  if (pieces.includes('wiremock')) {
    return `Feature: Example
  A scenario against the WireMock in docker-compose.yml, which stands in for
  the API under test until you point API_BASE_URL at your own.

  Scenario: A stubbed endpoint answers
    Given the example API at "/hello" returns HTTP 200
    When I send the request _empty to the hello operation
    Then the response status should be 200
    And the example API at "/hello" was called 1 time
`
  }
  if (pieces.includes('postgres')) {
    return `Feature: Example
  A scenario against the Postgres in docker-compose.yml.

  Scenario: The database answers
    Then the pg_database table contains 1 row matching "datname = 'postgres'"
`
  }
  if (pieces.includes('redis')) {
    return `Feature: Example
  A scenario against the Redis in docker-compose.yml.

  Scenario: The cache starts empty
    Then the Valkey key "example" does not exist
`
  }
  return `Feature: Example
  A scenario against the Mailpit in docker-compose.yml.

  Scenario: The inbox starts empty
    Then exactly 0 emails arrive for "nobody@example.test" within 1s
`
}

const SERVICES: Record<Exclude<Piece, 'spa'>, string> = {
  wiremock: `  wiremock:
    image: wiremock/wiremock:3.13.2
    ports:
      - "\${WIREMOCK_PORT:-8443}:8080"
`,
  postgres: `  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD: postgres
    ports:
      - "\${POSTGRES_PORT:-5432}:5432"
`,
  redis: `  redis:
    image: redis:7-alpine
    ports:
      - "\${REDIS_PORT:-6379}:6379"
`,
  mailpit: `  mailpit:
    image: axllent/mailpit:v1.33
    ports:
      - "\${MAILPIT_PORT:-8025}:8025"
      - "\${MAILPIT_SMTP_PORT:-1025}:1025"
`,
}

function dockerCompose(pieces: Piece[]): string {
  const services = pieces
    .filter((p): p is Exclude<Piece, 'spa'> => p !== 'spa')
    .map((p) => SERVICES[p])
  return `services:\n${services.join('')}`
}

function envExample(pieces: Piece[]): string {
  const lines: string[] = []
  if (pieces.includes('wiremock')) {
    lines.push('WIREMOCK_URL=http://localhost:8443', '# API_BASE_URL=http://localhost:8080')
  }
  if (pieces.includes('postgres')) {
    lines.push('DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres')
  }
  if (pieces.includes('redis')) lines.push('REDIS_URL=redis://localhost:6379')
  if (pieces.includes('mailpit')) lines.push('MAILPIT_URL=http://localhost:8025')
  if (pieces.includes('spa')) lines.push('WEB_PORT=3100')
  return `${lines.join('\n')}\n`
}

const HOME_PAGE = `import { BasePage } from '${PKG}/playwright'

export class HomePage extends BasePage {
  get url() {
    return '/'
  }
}
`

const WEB_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Example</title>
  </head>
  <body>
    <h1 data-testid="greeting">Hello</h1>
  </body>
</html>
`

/** Every file `ctf init` writes for these pieces, by path relative to the target directory. */
export function templates(pieces: Piece[]): Record<string, string> {
  const files: Record<string, string> = {
    'cucumber.js': CUCUMBER_JS,
    'support/setup.ts': setupTs(pieces),
    'support/operation-map.ts': OPERATION_MAP,
    'features/example.feature': exampleFeature(pieces),
    'docker-compose.yml': dockerCompose(pieces),
    '.env.example': envExample(pieces),
  }
  if (pieces.includes('spa')) {
    files['pages/home.page.ts'] = HOME_PAGE
    files['web/index.html'] = WEB_INDEX
  }
  return files
}

/** Write the scaffold into `dir`. Throws, naming the files, when any exist and `force` isn't set. */
export function initProject(dir: string, pieces: Piece[], force: boolean): string[] {
  const files = templates(normalisePieces(pieces))
  const names = Object.keys(files)
  if (!force) {
    const existing = names.filter((n) => fs.existsSync(path.join(dir, n)))
    if (existing.length > 0) {
      throw new Error(
        `won't overwrite ${existing.map((n) => path.join(dir, n)).join(', ')}; use --force to replace ${existing.length === 1 ? 'it' : 'them'}`,
      )
    }
  }
  for (const name of names) {
    const target = path.join(dir, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, files[name])
  }
  return names
}
