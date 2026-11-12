import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import {
  auditCoverage,
  findFeatureFiles,
  DEFAULT_REFERENCE_PATTERNS,
  DEFAULT_STATUS_PATTERNS,
  type AuditResult,
} from './audit'
import { applyAllowlist, diffSpecs, type Finding } from './diff'
import { parseFeature } from './gherkin'
import { readOperationMap } from './map-file'
import { readAllowlist } from './check'
import { loadSpecDetail } from './spec'

/** Options for {@link collectEvidence}. Paths are relative to the working directory, inside the repo. */
export interface EvidenceOptions {
  /** The git ref to compare against, e.g. `origin/main`. */
  base: string
  /** The git ref to evidence; default the working tree. */
  head?: string
  specs: string[]
  features: string[]
  map?: string
  basePath?: string
  /** An api-diff allowlist file, read from the head. */
  allowlist?: string
  patterns?: RegExp[]
  statusPatterns?: RegExp[]
  /** Directory the four files are written to. */
  out: string
  /** Where to run git; default the working directory. */
  cwd?: string
}

/** Thrown when evidence can't be computed, as opposed to there being nothing to report. */
export class EvidenceError extends Error {}

interface Pairs {
  asserted: number
  total: number
}

interface Gap {
  operation?: string
  method: string
  path: string
  status: string
}

interface Scenario {
  file: string
  name: string
  steps: string
  /** Operation names its steps use. */
  names: Set<string>
}

interface Side {
  operations: ReturnType<typeof loadSpecDetail>['operations']
  audit: AuditResult
  present: boolean
}

const percent = (p: Pairs) =>
  p.total === 0 ? 100 : Math.round((p.asserted / p.total) * 10000) / 100
const fixed = (n: number) => n.toFixed(2)
const normalise = (p: string) => p.replace(/\{[^}]*\}/g, '{}')
const opKey = (o: { method: string; path: string }) => `${o.method} ${normalise(o.path)}`
const gapKey = (g: Gap) => `${opKey(g)} ${g.status}`

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function resolveRef(cwd: string, ref: string, role: string): string {
  try {
    return git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  } catch {
    throw new EvidenceError(
      `${role} ref '${ref}' isn't a commit in this repository. In CI, check out with ` +
        `fetch-depth: 0, or fetch the base branch before running ctf evidence.`,
    )
  }
}

function materialise(cwd: string, sha: string, dir: string) {
  const archive = spawnSync('git', ['-C', cwd, 'archive', '--format=tar', sha], {
    maxBuffer: 1 << 30,
  })
  if (archive.status !== 0) {
    throw new EvidenceError(`git archive ${sha} failed: ${archive.stderr?.toString().trim()}`)
  }
  const tar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout })
  if (tar.status !== 0) {
    throw new EvidenceError(`could not unpack ${sha}: ${tar.stderr?.toString().trim()}`)
  }
}

function scenariosOf(files: string[], root: string, patterns: RegExp[]): Scenario[] {
  const byKey = new Map<string, Scenario>()
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf-8')
    const lines = text.split(/\r?\n/)
    const rel = path.relative(root, file).split(path.sep).join('/')
    // An Outline's rows share one line, and count as one scenario.
    const byLine = new Map<number, { steps: string[]; names: Set<string> }>()
    for (const sc of parseFeature(text)) {
      const entry = byLine.get(sc.line) ?? { steps: [], names: new Set<string>() }
      byLine.set(sc.line, entry)
      for (const step of sc.steps) {
        entry.steps.push(step.text)
        for (const pattern of patterns) {
          const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`)
          for (const m of step.text.matchAll(global)) if (m[1]) entry.names.add(m[1])
        }
      }
    }
    for (const [line, entry] of byLine) {
      const name = (lines[line - 1] ?? '').replace(/^\s*[^:]+:\s*/, '').trim()
      const key = `${rel}\u0000${name}`
      const existing = byKey.get(key)
      if (existing) {
        existing.steps += `\n${entry.steps.join('\n')}`
        entry.names.forEach((n) => existing.names.add(n))
      } else {
        byKey.set(key, { file: rel, name, steps: entry.steps.join('\n'), names: entry.names })
      }
    }
  }
  return [...byKey.values()]
}

function loadSide(
  root: string,
  spec: string,
  options: EvidenceOptions,
  patterns: RegExp[],
  statusPatterns: RegExp[],
): Side {
  const specFile = path.join(root, spec)
  const present = fs.existsSync(specFile)
  const operations = present
    ? loadSpecDetail(specFile, { basePath: options.basePath }).operations
    : []
  const mapFile = options.map ? path.join(root, options.map) : undefined
  const featureRoots = options.features
    .map((f) => path.join(root, f))
    .filter((f) => fs.existsSync(f))
  const audit = auditCoverage({
    operations,
    map: mapFile && fs.existsSync(mapFile) ? readOperationMap(mapFile).entries : undefined,
    featureFiles: findFeatureFiles(featureRoots),
    patterns,
    statusPatterns,
  })
  // Report files relative to the repo, as `file:line`.
  const rel = (where: string) => {
    const i = where.lastIndexOf(':')
    return path.relative(root, where.slice(0, i)).split(path.sep).join('/') + where.slice(i)
  }
  for (const op of audit.operations) {
    op.unassertedReferences = op.unassertedReferences.map(rel)
  }
  return { operations, audit, present }
}

function pairsOf(side: Side): Pairs {
  const total = side.operations.reduce(
    (n, op) => n + op.responses.filter((r) => !/^default$/i.test(r.status)).length,
    0,
  )
  return { total, asserted: total - side.audit.statusGaps.length }
}

/**
 * Evidence for a change, computed statically from the files at two git refs:
 * status coverage, api breaks, scenario changes. Nothing is run. Writes
 * `coverage-base.txt`, `coverage-head.txt`, `api-break.txt` and `evidence.json`
 * to `options.out`, and returns the JSON.
 */
export function collectEvidence(options: EvidenceOptions) {
  if (options.specs.length === 0) throw new EvidenceError('evidence needs at least one --spec')
  if (options.features.length === 0) throw new EvidenceError('evidence needs --features')
  const cwd = options.cwd ?? process.cwd()
  let toplevel: string
  try {
    toplevel = git(cwd, ['rev-parse', '--show-toplevel'])
  } catch {
    throw new EvidenceError(`${cwd} is not inside a git repository`)
  }
  const repoPath = (p: string) =>
    path.relative(toplevel, path.resolve(cwd, p)).split(path.sep).join('/')
  const resolved: EvidenceOptions = {
    ...options,
    specs: options.specs.map(repoPath),
    features: options.features.map(repoPath),
    map: options.map && repoPath(options.map),
    allowlist: options.allowlist && repoPath(options.allowlist),
  }
  const baseSha = resolveRef(cwd, options.base, 'base')
  const headSha = options.head ? resolveRef(cwd, options.head, 'head') : undefined

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-evidence-'))
  try {
    const baseRoot = path.join(tmp, 'base')
    fs.mkdirSync(baseRoot)
    materialise(toplevel, baseSha, baseRoot)
    let headRoot = toplevel
    if (headSha) {
      headRoot = path.join(tmp, 'head')
      fs.mkdirSync(headRoot)
      materialise(toplevel, headSha, headRoot)
    }
    return compute(resolved, baseRoot, headRoot, baseSha, headSha ?? 'worktree')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function compute(
  options: EvidenceOptions,
  baseRoot: string,
  headRoot: string,
  baseSha: string,
  headLabel: string,
) {
  const patterns = options.patterns ?? DEFAULT_REFERENCE_PATTERNS
  const statusPatterns = options.statusPatterns ?? DEFAULT_STATUS_PATTERNS
  const allowlist = options.allowlist
    ? (() => {
        const file = path.join(headRoot, options.allowlist)
        if (!fs.existsSync(file))
          throw new EvidenceError(`allowlist ${options.allowlist} not found`)
        return readAllowlist(file)
      })()
    : []

  const total = { base: { asserted: 0, total: 0 }, head: { asserted: 0, total: 0 } }
  const breaking: Finding[] = []
  const nonBreaking: Finding[] = []
  let suppressed = 0
  const newGaps: (Gap & { operation?: string })[] = []
  const closedGaps: Gap[] = []
  let headGaps = 0
  const changedOps = new Map<string, string[]>()
  const unasserted: { operation: string; references: string[] }[] = []
  const specs: unknown[] = []

  for (const spec of options.specs) {
    const base = loadSide(baseRoot, spec, options, patterns, statusPatterns)
    const head = loadSide(headRoot, spec, options, patterns, statusPatterns)
    if (!head.present) throw new EvidenceError(`spec ${spec} not found at head`)

    const bp = pairsOf(base)
    const hp = pairsOf(head)
    total.base.asserted += bp.asserted
    total.base.total += bp.total
    total.head.asserted += hp.asserted
    total.head.total += hp.total

    let specBreaking: Finding[] = []
    if (base.present) {
      const diff = diffSpecs(path.join(baseRoot, spec), path.join(headRoot, spec), {
        basePath: options.basePath,
      })
      const allowed = applyAllowlist(diff.breaking, allowlist)
      specBreaking = allowed.breaking
      suppressed += allowed.allowlisted
      breaking.push(...specBreaking)
      nonBreaking.push(...diff.nonBreaking)
      const aliasesOf = (side: Side, op: string) =>
        side.audit.operations
          .filter((o) => `${o.method} ${o.path}` === op)
          .flatMap((o) => o.aliases)
      for (const f of [...diff.breaking, ...diff.nonBreaking]) {
        const names = changedOps.get(f.operation) ?? []
        for (const a of [...aliasesOf(base, f.operation), ...aliasesOf(head, f.operation)]) {
          if (!names.includes(a)) names.push(a)
        }
        changedOps.set(f.operation, names)
      }
    }

    const baseGapKeys = new Set(base.audit.statusGaps.map(gapKey))
    const headGapKeys = new Set(head.audit.statusGaps.map(gapKey))
    headGaps += head.audit.statusGaps.length
    for (const g of head.audit.statusGaps) if (!baseGapKeys.has(gapKey(g))) newGaps.push(g)
    for (const g of base.audit.statusGaps) if (!headGapKeys.has(gapKey(g))) closedGaps.push(g)
    for (const op of head.audit.operations) {
      if (op.unassertedReferences.length > 0) {
        unasserted.push({
          operation: op.name ?? `${op.method} ${op.path}`,
          references: op.unassertedReferences,
        })
      }
    }

    specs.push({
      path: spec,
      presentAtBase: base.present,
      coverage: {
        base: fixed(percent(bp)),
        head: fixed(percent(hp)),
        pairs: { base: bp, head: hp },
      },
      apiBreak: specBreaking.length > 0,
    })
  }

  const scenarioRoots = (root: string) =>
    findFeatureFiles(
      options.features.map((f) => path.join(root, f)).filter((f) => fs.existsSync(f)),
    )
  const baseScenarios = scenariosOf(scenarioRoots(baseRoot), baseRoot, patterns)
  const headScenarios = scenariosOf(scenarioRoots(headRoot), headRoot, patterns)
  const id = (s: Scenario) => `${s.file}\u0000${s.name}`
  const baseById = new Map(baseScenarios.map((s) => [id(s), s]))
  const headById = new Map(headScenarios.map((s) => [id(s), s]))
  const ref = ({ file, name }: Scenario) => ({ file, name })
  const scenarios = {
    added: headScenarios.filter((s) => !baseById.has(id(s))).map(ref),
    removed: baseScenarios.filter((s) => !headById.has(id(s))).map(ref),
    changed: headScenarios
      .filter((s) => baseById.has(id(s)) && baseById.get(id(s))?.steps !== s.steps)
      .map(ref),
  }

  // The spec moved, and no scenario naming the operation was added, removed or changed.
  const touches = (names: string[], list: Scenario[]) =>
    list
      .filter((s) => names.some((n) => s.names.has(n)))
      .map((s) => `${id(s)}\u0000${s.steps}`)
      .sort()
  const changedWithoutScenario = [...changedOps]
    .filter(([, names]) => {
      const before = touches(names, baseScenarios)
      const after = touches(names, headScenarios)
      return before.length === after.length && before.every((s, i) => s === after[i])
    })
    .map(([op]) => op)
    .sort()

  const coverage = { base: percent(total.base), head: percent(total.head) }
  const evidence = {
    version: 1,
    base: baseSha,
    head: headLabel,
    generatedBy: `ctf evidence ${packageVersion()}`,
    specs,
    coverage: {
      base: coverage.base,
      head: coverage.head,
      delta: Math.round((coverage.head - coverage.base) * 100) / 100,
      noDocumentedStatuses: total.base.total === 0 || total.head.total === 0,
      pairs: total,
    },
    apiDiff: { breaking, nonBreaking, suppressed },
    scenarios,
    statusGaps: { head: headGaps, new: newGaps, closed: closedGaps },
    operations: { changedInSpec: [...changedOps.keys()].sort(), changedWithoutScenario },
    unasserted,
    notComputed: ['retries', 'flakeHistory'],
  }

  fs.mkdirSync(options.out, { recursive: true })
  fs.writeFileSync(path.join(options.out, 'coverage-base.txt'), fixed(coverage.base))
  fs.writeFileSync(path.join(options.out, 'coverage-head.txt'), fixed(coverage.head))
  fs.writeFileSync(path.join(options.out, 'api-break.txt'), String(breaking.length > 0))
  fs.writeFileSync(
    path.join(options.out, 'evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
  return evidence
}

function packageVersion(): string {
  const file = path.join(__dirname, '..', '..', 'package.json')
  return (JSON.parse(fs.readFileSync(file, 'utf-8')) as { version: string }).version
}
