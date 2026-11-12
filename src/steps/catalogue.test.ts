import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type { StepEntry } from './catalogue'

const root = path.resolve(__dirname, '..', '..')
const src = path.join(root, 'src')
const out = path.join(root, 'node_modules', '.cache', 'ctf-catalogue-test')

// The catalogue loads the compiled register functions with require, which
// Vitest can't follow into TypeScript source (as in register.test.ts), so
// build the package to a scratch directory inside the repo, where the
// compiled code finds the same node_modules.
let catalogue: StepEntry[]
beforeAll(() => {
  fs.rmSync(out, { recursive: true, force: true })
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      root,
      '--outDir',
      out,
      '--declaration',
      'false',
      '--declarationMap',
      'false',
      '--sourceMap',
      'false',
    ],
    { cwd: root },
  )
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  catalogue = require(path.join(out, 'steps', 'catalogue.js')).stepCatalogue()
}, 240_000)

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__fixtures__' ? [] : sources(full)
    return /\.ts$/.test(e.name) && !/\.(test|spec|integration\.test)\.ts$/.test(e.name)
      ? [full]
      : []
  })
}

const CALL = /\b(Given|When|Then|defineStep)\(/g
const LITERAL =
  /^\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`|\/((?:[^/\\\n]|\\.)+)\/([a-z]*))/
const unescape = (s: string) => s.replace(/\\(.)/g, '$1')

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('step catalogue (COMPONENT-27)', () => {
  it('lists the steps with the function that registers each', () => {
    const status = catalogue.find((s) => s.expression === 'the response status should be {int}')
    expect(status).toEqual({
      keyword: 'Then',
      expression: 'the response status should be {int}',
      registeredBy: 'registerResponseSteps',
      entryPoint: 'core',
      optIn: false,
    })
    expect(new Set(catalogue.filter((s) => s.optIn).map((s) => s.registeredBy))).toEqual(
      new Set([
        'registerWaitingSteps',
        'registerRequestSteps',
        'registerMailpitSteps',
        'registerAccessibilitySteps',
      ]),
    )
    expect(catalogue.find((s) => s.registeredBy === 'registerRedisSteps')).toBeDefined()
    expect(catalogue.find((s) => s.expression.includes('GraphQL'))?.registeredBy).toBe(
      'registerWiremockSteps',
    )
  })

  it('contains every step written in src, none twice, and nothing src does not write', () => {
    const written: string[] = []
    for (const file of sources(src)) {
      const text = stripComments(fs.readFileSync(file, 'utf-8'))
      for (const call of text.matchAll(CALL)) {
        const rest = text.slice(call.index + call[1].length)
        const literal = LITERAL.exec(rest)
        const where = `${path.relative(root, file)}: ${call[0]}`
        // A step defined from a variable or in a loop can't be checked by reading the source.
        expect(literal, `${where} has no literal expression`).not.toBeNull()
        const [, single, double, template, source, flags] = literal!
        written.push(
          source === undefined
            ? unescape(single ?? double ?? template)
            : String(new RegExp(source, flags)),
        )
      }
    }
    expect(written.length).toBeGreaterThan(40)
    const listed = catalogue.map((s) => s.expression)
    expect(listed.filter((e) => !written.includes(e))).toEqual([])
    expect(written.filter((e) => !listed.includes(e))).toEqual([])
    expect(new Set(listed).size).toBe(listed.length)
  })

  it('registers nothing in the process that asks, so asking twice gives the same answer', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const again = require(path.join(out, 'steps', 'catalogue.js')).stepCatalogue()
    expect(again).toEqual(catalogue)
  })
})
