/* eslint-disable @typescript-eslint/no-require-imports */
import * as net from 'net'
import * as path from 'path'
import Module from 'module'

const childProcess = require('child_process') as { spawn: unknown }

/** One step the framework can register. */
export interface StepEntry {
  keyword: 'Given' | 'When' | 'Then' | 'Step'
  /** The Cucumber expression, or a regular expression as `/source/flags`. */
  expression: string
  /** The register function that registers it. */
  registeredBy: string
  /** The package entry point that exports that function. */
  entryPoint: 'core' | 'mailpit' | 'spa'
  /** Registered only when a suite calls the function, never on import of the package root. */
  optIn: boolean
}

export interface Group {
  registeredBy: string
  entryPoint: StepEntry['entryPoint']
  optIn: boolean
  run: () => void
}

// Every function that registers steps. A step registered some other way is
// missing from the catalogue, and the test that scans the sources for step
// definitions fails until it is added here.
const GROUPS: Group[] = [
  {
    registeredBy: 'registerApiSteps',
    entryPoint: 'core',
    optIn: false,
    run: () => reg().registerApiSteps(),
  },
  {
    registeredBy: 'registerRawApiSteps',
    entryPoint: 'core',
    optIn: false,
    run: () => reg().registerRawApiSteps(),
  },
  {
    registeredBy: 'registerSseSteps',
    entryPoint: 'core',
    optIn: false,
    run: () => reg().registerSseSteps(),
  },
  {
    registeredBy: 'registerResponseSteps',
    entryPoint: 'core',
    optIn: false,
    run: () => reg().registerResponseSteps(),
  },
  {
    registeredBy: 'registerWiremockSteps',
    entryPoint: 'core',
    optIn: false,
    run: () => reg().registerWiremockSteps(),
  },
  {
    registeredBy: 'registerDbSteps',
    entryPoint: 'core',
    optIn: false,
    run: () => reg().registerDbSteps(),
  },
  {
    registeredBy: 'registerRedisSteps',
    entryPoint: 'core',
    optIn: false,
    run: () => reg().registerRedisSteps(),
  },
  {
    registeredBy: 'registerServiceSteps',
    entryPoint: 'core',
    optIn: false,
    run: () => reg().registerServiceSteps(),
  },
  {
    registeredBy: 'registerUiSteps',
    entryPoint: 'core',
    optIn: false,
    run: () => reg().registerUiSteps(),
  },
  {
    registeredBy: 'registerWaitingSteps',
    entryPoint: 'core',
    optIn: true,
    run: () =>
      (require('./waiting.steps') as typeof import('./waiting.steps')).registerWaitingSteps(),
  },
  {
    registeredBy: 'registerRequestSteps',
    entryPoint: 'core',
    optIn: true,
    run: () =>
      (require('./request.steps') as typeof import('./request.steps')).registerRequestSteps(),
  },
  {
    registeredBy: 'registerMailpitSteps',
    entryPoint: 'mailpit',
    optIn: true,
    run: () =>
      (require('./mailpit.steps') as typeof import('./mailpit.steps')).registerMailpitSteps(),
  },
  {
    registeredBy: 'registerAccessibilitySteps',
    entryPoint: 'spa',
    optIn: true,
    run: () =>
      (require('../spa/browser') as typeof import('../spa/browser')).registerAccessibilitySteps(),
  },
]

function reg(): typeof import('./register') {
  return require('./register')
}

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown
type Internals = { _load: Loader }

const HOOKS_AND_SETUP = [
  'Before',
  'After',
  'BeforeAll',
  'AfterAll',
  'BeforeStep',
  'AfterStep',
  'setWorldConstructor',
  'setDefaultTimeout',
  'setDefinitionFunctionWrapper',
  'defineParameterType',
]

/**
 * Every step the framework can register, in registration order: the real
 * registrations, captured, not a list kept by hand.
 *
 * Each register function runs against a stand-in for `@cucumber/cucumber`
 * whose `Given`, `When`, `Then` and `defineStep` record the expression, and
 * whose hooks and setup calls do nothing. The package's modules are loaded
 * afresh for the capture, so a register-once guard already tripped in this
 * process doesn't hide steps, and the process's own registrations are left
 * as they were. The functions only define steps, but to be sure, opening a
 * socket or starting a process during the capture throws.
 *
 * Needs `@cucumber/cucumber`, a peer dependency; throws a clear error without it.
 */
export function stepCatalogue(): StepEntry[] {
  return captureSteps(GROUPS)
}

/** {@link stepCatalogue} for the given groups; the tests pass ones that throw. */
export function captureSteps(groups: Group[]): StepEntry[] {
  const root = path.resolve(__dirname, '..')
  const inPackage = (file: string) => file === root || file.startsWith(root + path.sep)

  let actual: typeof import('@cucumber/cucumber')
  try {
    actual = require('@cucumber/cucumber')
  } catch (err) {
    if (
      (err as { code?: string }).code === 'MODULE_NOT_FOUND' &&
      /Cannot find module '@cucumber\/cucumber'/.test((err as Error).message)
    ) {
      throw new Error(
        '@cucumber/cucumber is not installed. It is a peer dependency of the framework; install it to list steps.',
      )
    }
    throw err
  }

  const entries: StepEntry[] = []
  let group: Group = groups[0]
  const record = (keyword: StepEntry['keyword']) => (expression: string | RegExp) => {
    entries.push({
      keyword,
      expression: String(expression),
      registeredBy: group.registeredBy,
      entryPoint: group.entryPoint,
      optIn: group.optIn,
    })
  }
  const stub: Record<string, unknown> = {
    ...actual,
    Given: record('Given'),
    When: record('When'),
    Then: record('Then'),
    defineStep: record('Step'),
  }
  for (const name of HOOKS_AND_SETUP) stub[name] = () => {}

  const cache = require.cache
  const owned = () => Object.keys(cache).filter(inPackage)
  const saved = new Map(owned().map((file) => [file, cache[file]]))
  const internals = Module as unknown as Internals
  const originalLoad = internals._load
  const { connect } = net.Socket.prototype
  const { spawn } = childProcess
  const refuse = (what: string) => () => {
    throw new Error(`${what} during step capture`)
  }

  for (const file of saved.keys()) delete cache[file]
  internals._load = function (request, parent, isMain) {
    const from = (parent as { filename?: string } | null)?.filename
    if (request === '@cucumber/cucumber' && from && inPackage(from)) return stub
    return originalLoad.call(this, request, parent, isMain)
  }
  net.Socket.prototype.connect = refuse('a socket was opened') as typeof connect
  childProcess.spawn = refuse('a process was started')
  try {
    for (const g of groups) {
      group = g
      g.run()
    }
  } finally {
    internals._load = originalLoad
    net.Socket.prototype.connect = connect
    childProcess.spawn = spawn
    for (const file of owned()) delete cache[file]
    for (const [file, mod] of saved) cache[file] = mod
  }
  return entries
}
