import { execFileSync } from 'child_process'
import * as path from 'path'
import { isFault, selectorMatches, type Fault } from './inject'

export interface Tolerated {
  stub: string
  fault: Fault
}

/** `METHOD path fault` per line (a GRAPHQL stub is `GRAPHQL endpoint operation fault`); `#` comments and blank lines are ignored. */
export function parseAllowlist(text: string, where = 'allowlist'): Tolerated[] {
  return text.split('\n').flatMap((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) return []
    const words = line.split(/\s+/)
    const fault = words.pop() as string
    if (words.length < 2 || !isFault(fault)) {
      throw new Error(`${where}:${i + 1}: expected "METHOD path fault", got "${line}"`)
    }
    return [{ stub: [words[0].toUpperCase(), ...words.slice(1)].join(' '), fault }]
  })
}

/**
 * Reads `<ref>:<path>` from git, never from the working tree, so a change
 * can't excuse its own surviving faults. A file absent at the ref is empty.
 */
export function readAllowlistAtBase(spec: string, cwd = process.cwd()): Tolerated[] {
  const at = spec.indexOf(':')
  if (at <= 0 || at === spec.length - 1) {
    throw new Error(`--allowlist takes <base-ref>:<path>, got "${spec}"`)
  }
  const ref = spec.slice(0, at)
  const rel = path
    .relative(cwd, path.resolve(cwd, spec.slice(at + 1)))
    .split(path.sep)
    .join('/')
  const git = (args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  } catch {
    throw new Error(`allowlist ref '${ref}' isn't a commit in this repository`)
  }
  let text: string
  try {
    text = git(['show', `${ref}:./${rel}`])
  } catch {
    console.error(`ctf faults: allowlist ${rel} does not exist at ${ref}; no faults are tolerated`)
    return []
  }
  return parseAllowlist(text, `${ref}:${rel}`)
}

export function isTolerated(list: Tolerated[], stub: string, fault: Fault): boolean {
  return list.some((t) => t.fault === fault && (t.stub === stub || selectorMatches(t.stub, stub)))
}
