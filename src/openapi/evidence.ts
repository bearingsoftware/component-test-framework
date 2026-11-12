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
import { boundForEvidence, type TestStrength } from '../faults/report'

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
  /**
   * An api-diff allowlist file. It is read from the base, never the head: a change
   * can't accept its own breaks. One absent at base means no allowlist.
   */
  allowlist?: string
  /** Tags whose scenarios don't count, in addition to {@link DEFAULT_EXCLUDE_TAGS}. Case-insensitive. */
  excludeTags?: string[]
  /** Don't exclude {@link DEFAULT_EXCLUDE_TAGS}; only {@link excludeTags}. */
  noDefaultExclusions?: boolean
  patterns?: RegExp[]
  statusPatterns?: RegExp[]
  /**
   * A `ctf faults` test-strength.json to embed as `testStrength` in evidence.json,
   * bounded. It never feeds the coverage or api-break files.
   */
  testStrength?: string
  /** Directory the four files are written to. */
  out: string
  /** Where to run git; default the working directory. */
  cwd?: string
}

/** Scenarios tagged with these are not counted as asserting anything. */
export const DEFAULT_EXCLUDE_TAGS = ['@skip', '@pending', '@wip']

/** The tags excluded after the defaults and the options, lower-cased. */
export function effectiveExcludeTags(options: EvidenceOptions): string[] {
  const all = [
    ...(options.noDefaultExclusions ? [] : DEFAULT_EXCLUDE_TAGS),
    ...(options.excludeTags ?? []),
  ]
  return [...new Set(all.map((t) => (t.startsWith('@') ? t : `@${t}`).toLowerCase()))]
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
  tags: string[]
  excluded: boolean
  /** Heading lines, one per Scenario (an Outline has one). */
  headings: number[]
  /** `Examples:` lines whose own tags exclude them, while the Outline still counts. */
  blankedExamples: number[]
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

const CHUNK = 32 << 20

/**
 * Write the files of a commit under `dir`, whatever .gitattributes says
 * (`git archive` honours export-ignore). Contents come through `git cat-file
 * --batch` in bounded chunks. Symlinks and submodules are skipped.
 */
function materialise(cwd: string, sha: string, dir: string) {
  const listing = spawnSync('git', ['-C', cwd, 'ls-tree', '-r', '-z', '-l', '--full-tree', sha], {
    encoding: 'utf-8',
    maxBuffer: 1 << 28,
  })
  if (listing.status !== 0) {
    throw new EvidenceError(`git ls-tree ${sha} failed: ${listing.stderr?.trim()}`)
  }
  const entries: { sha: string; size: number; file: string }[] = []
  for (const record of listing.stdout.split('\0')) {
    const m = /^(\d+) blob\s+([0-9a-f]+)\s+(\d+|BAD)\t([\s\S]*)$/.exec(record)
    if (!m || m[1] === '120000') continue
    entries.push({ sha: m[2], size: Number(m[3]) || 0, file: m[4] })
  }
  const root = path.resolve(dir)
  let chunk: typeof entries = []
  let bytes = 0
  const flush = () => {
    if (chunk.length === 0) return
    const out = spawnSync('git', ['-C', cwd, 'cat-file', '--batch'], {
      input: `${chunk.map((e) => e.sha).join('\n')}\n`,
      maxBuffer: bytes + chunk.length * 128 + (1 << 20),
    })
    if (out.status !== 0) {
      throw new EvidenceError(`git cat-file failed: ${out.stderr?.toString().trim()}`)
    }
    let pos = 0
    for (const entry of chunk) {
      const eol = out.stdout.indexOf(0x0a, pos)
      const header = out.stdout.subarray(pos, eol).toString().split(' ')
      if (header[1] !== 'blob') {
        throw new EvidenceError(
          `${entry.file} (object ${entry.sha}) is missing from the repository; ` +
            `fetch the full history and objects, not a shallow or partial clone`,
        )
      }
      const size = Number(header[2])
      const target = path.resolve(root, entry.file)
      if (!target.startsWith(root + path.sep)) {
        console.warn(`ctf evidence: skipping ${entry.file}: it is outside the checkout`)
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, out.stdout.subarray(eol + 1, eol + 1 + size))
      }
      pos = eol + 1 + size + 1
    }
    chunk = []
    bytes = 0
  }
  for (const entry of entries) {
    if (bytes + entry.size > CHUNK) flush()
    chunk.push(entry)
    bytes += entry.size
  }
  flush()
}

function tagsAbove(lines: string[], index: number): string[] {
  const tags: string[] = []
  for (let i = index - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (t === '' || t.startsWith('#')) continue
    if (!t.startsWith('@')) break
    tags.unshift(...t.split(/\s+/).filter((x) => x.startsWith('@')))
  }
  return tags
}

function inheritedTags(lines: string[], heading: number): string[] {
  const tags = tagsAbove(lines, heading)
  const feature = lines.findIndex((l) => /^\s*Feature:/.test(l))
  for (let i = heading - 1; i > feature && i >= 0; i--) {
    if (/^\s*Rule:/.test(lines[i])) {
      tags.push(...tagsAbove(lines, i))
      break
    }
  }
  if (feature >= 0 && feature < heading) tags.push(...tagsAbove(lines, feature))
  return tags
}

/** The `Examples:` blocks of the Outline whose heading is at `heading` (0-based), with their tags. */
function examplesOf(lines: string[], heading: number): { line: number; tags: string[] }[] {
  const out: { line: number; tags: string[] }[] = []
  for (let i = heading + 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (SECTION.test(t)) break
    if (/^(Examples|Scenarios):/.test(t)) out.push({ line: i + 1, tags: tagsAbove(lines, i) })
  }
  return out
}

const SECTION = /^(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Example):/

/** The feature files, copied under `mirror` with excluded scenarios blanked, keeping line numbers. */
function mirrorFeatures(root: string, scenarios: Scenario[], mirror: string) {
  const byFile = new Map<string, number[]>()
  const examplesByFile = new Map<string, number[]>()
  for (const s of scenarios) {
    if (s.excluded) byFile.set(s.file, [...(byFile.get(s.file) ?? []), ...s.headings])
    else examplesByFile.set(s.file, [...(examplesByFile.get(s.file) ?? []), ...s.blankedExamples])
  }
  return (file: string) => {
    const rel = path.relative(root, file)
    const lines = fs.readFileSync(file, 'utf-8').split('\n')
    const key = rel.split(path.sep).join('/')
    for (const at of examplesByFile.get(key) ?? []) {
      let i = at - 1
      lines[i++] = ''
      while (i < lines.length && /^\s*(\||$)/.test(lines[i])) lines[i++] = ''
    }
    for (const heading of byFile.get(key) ?? []) {
      let i = heading - 1
      lines[i++] = ''
      while (i < lines.length) {
        const t = lines[i].trim()
        if (t.startsWith('@') || SECTION.test(t)) break
        lines[i++] = ''
      }
    }
    fs.mkdirSync(path.dirname(path.join(mirror, rel)), { recursive: true })
    fs.writeFileSync(path.join(mirror, rel), lines.join('\n'))
  }
}

function scenariosOf(
  files: string[],
  root: string,
  patterns: RegExp[],
  excludeTags: string[],
): Scenario[] {
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
      const tags = inheritedTags(lines, line - 1)
      const isExcluded = (list: string[]) => list.some((t) => excludeTags.includes(t.toLowerCase()))
      const examples = examplesOf(lines, line - 1)
      const blanked = examples.filter((e) => isExcluded(e.tags)).map((e) => e.line)
      const excluded =
        isExcluded(tags) || (examples.length > 0 && blanked.length === examples.length)
      tags.push(...examples.flatMap((e) => e.tags))
      const existing = byKey.get(key)
      if (existing) {
        existing.steps += `\n${entry.steps.join('\n')}`
        entry.names.forEach((n) => existing.names.add(n))
        existing.tags = [...new Set([...existing.tags, ...tags])].sort()
        existing.excluded &&= excluded
        existing.headings.push(line)
        existing.blankedExamples.push(...blanked)
      } else {
        byKey.set(key, {
          file: rel,
          name,
          steps: entry.steps.join('\n'),
          names: entry.names,
          tags: [...new Set(tags)].sort(),
          excluded,
          headings: [line],
          blankedExamples: blanked,
        })
      }
    }
  }
  return [...byKey.values()]
}

interface Features {
  scenarios: Scenario[]
  /** Where the features are, with excluded scenarios blanked. */
  mirror: string
}

function loadFeatures(
  root: string,
  mirror: string,
  options: EvidenceOptions,
  patterns: RegExp[],
): Features {
  const files = findFeatureFiles(
    options.features.map((f) => path.join(root, f)).filter((f) => fs.existsSync(f)),
  )
  const scenarios = scenariosOf(files, root, patterns, effectiveExcludeTags(options))
  const copy = mirrorFeatures(root, scenarios, mirror)
  for (const file of files) copy(file)
  return { scenarios, mirror }
}

function loadSide(
  root: string,
  features: Features,
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
    .map((f) => path.join(features.mirror, f))
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
    return (
      path.relative(features.mirror, where.slice(0, i)).split(path.sep).join('/') + where.slice(i)
    )
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
  // Output left by an earlier run must not be read as this run's answer.
  for (const f of ['coverage-base.txt', 'coverage-head.txt', 'api-break.txt', 'evidence.json']) {
    fs.rmSync(path.join(options.out, f), { force: true })
  }
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
    return compute(resolved, tmp, baseRoot, headRoot, baseSha, headSha ?? 'worktree')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function compute(
  options: EvidenceOptions,
  tmp: string,
  baseRoot: string,
  headRoot: string,
  baseSha: string,
  headLabel: string,
) {
  const patterns = options.patterns ?? DEFAULT_REFERENCE_PATTERNS
  const statusPatterns = options.statusPatterns ?? DEFAULT_STATUS_PATTERNS
  const baseFeatures = loadFeatures(baseRoot, path.join(tmp, 'base-features'), options, patterns)
  const headFeatures = loadFeatures(headRoot, path.join(tmp, 'head-features'), options, patterns)

  // From the base: a change can't accept its own breaking changes.
  let allowlist: string[] = []
  let allowlistInfo:
    { path: string; source: 'base'; entries: string[]; headDiffers: boolean } | undefined
  if (options.allowlist) {
    const baseFile = path.join(baseRoot, options.allowlist)
    const headFile = path.join(headRoot, options.allowlist)
    const atBase = fs.existsSync(baseFile)
    const atHead = fs.existsSync(headFile)
    if (!atBase && !atHead) throw new EvidenceError(`allowlist ${options.allowlist} not found`)
    if (atBase) allowlist = readAllowlist(baseFile)
    const text = (f: string, there: boolean) => (there ? fs.readFileSync(f, 'utf-8') : undefined)
    allowlistInfo = {
      path: options.allowlist,
      source: 'base',
      entries: allowlist,
      headDiffers: text(baseFile, atBase) !== text(headFile, atHead),
    }
  }

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
  const statusesRemoved: { method: string; path: string; status: string }[] = []

  for (const spec of options.specs) {
    const base = loadSide(baseRoot, baseFeatures, spec, options, patterns, statusPatterns)
    const head = loadSide(headRoot, headFeatures, spec, options, patterns, statusPatterns)
    if (!head.present) throw new EvidenceError(`spec ${spec} not found at head`)

    const hp = pairsOf(head)
    // A spec new at head is neutral: it neither raises nor lowers coverage.
    const bp = base.present ? pairsOf(base) : hp
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
      const headKeys = new Set(
        head.operations.flatMap((op) =>
          op.responses.map((r) => `${opKey(op)} ${r.status.toUpperCase()}`),
        ),
      )
      for (const op of base.operations) {
        for (const r of op.responses) {
          if (/^default$/i.test(r.status)) continue
          if (!headKeys.has(`${opKey(op)} ${r.status.toUpperCase()}`)) {
            statusesRemoved.push({ method: op.method, path: op.path, status: r.status })
          }
        }
      }
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

  const baseScenarios = baseFeatures.scenarios
  const headScenarios = headFeatures.scenarios
  const id = (s: Scenario) => `${s.file}\u0000${s.name}`
  const baseById = new Map(baseScenarios.map((s) => [id(s), s]))
  const headById = new Map(headScenarios.map((s) => [id(s), s]))
  const ref = ({ file, name }: Scenario) => ({ file, name })
  const scenarios = {
    added: headScenarios.filter((s) => !baseById.has(id(s))).map(ref),
    removed: baseScenarios.filter((s) => !headById.has(id(s))).map(ref),
    changed: headScenarios.flatMap((s) => {
      const before = baseById.get(id(s))
      if (!before) return []
      const tagsChanged = before.tags.join(' ') !== s.tags.join(' ')
      return before.steps !== s.steps || tagsChanged ? [{ ...ref(s), tagsChanged }] : []
    }),
    excluded: {
      tags: effectiveExcludeTags(options),
      head: headScenarios.filter((s) => s.excluded).map(ref),
    },
  }

  // The spec moved, and no scenario naming the operation was added, removed or changed.
  const touches = (names: string[], list: Scenario[]) =>
    list
      .filter((s) => !s.excluded && names.some((n) => s.names.has(n)))
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
    apiDiff: { breaking, nonBreaking, suppressed, allowlist: allowlistInfo ?? null },
    scenarios,
    statusesRemoved,
    statusGaps: { head: headGaps, new: newGaps, closed: closedGaps },
    operations: { changedInSpec: [...changedOps.keys()].sort(), changedWithoutScenario },
    unasserted,
    ...(options.testStrength && { testStrength: readTestStrength(options.testStrength) }),
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

function readTestStrength(file: string) {
  let parsed: TestStrength
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as TestStrength
  } catch (err) {
    throw new EvidenceError(
      `--test-strength ${file} can't be read as JSON: ${(err as Error).message}`,
    )
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.survived)) {
    throw new EvidenceError(
      `--test-strength ${file} isn't a ctf faults test-strength.json (version 1)`,
    )
  }
  return boundForEvidence(parsed)
}

function packageVersion(): string {
  const file = path.join(__dirname, '..', '..', 'package.json')
  return (JSON.parse(fs.readFileSync(file, 'utf-8')) as { version: string }).version
}
