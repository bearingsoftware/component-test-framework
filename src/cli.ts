#!/usr/bin/env node
// `ctf`: OpenAPI tooling for component-test suites.
import * as fs from 'fs'
import * as path from 'path'
import { parseArgs } from 'util'
import { loadSpec, loadSpecDetail } from './openapi/spec'
import { generateOperationMap } from './openapi/generate'
import { checkOperationMaps, readAllowlist, type CheckPair } from './openapi/check'
import {
  auditCoverage,
  findFeatureFiles,
  DEFAULT_REFERENCE_PATTERNS,
  DEFAULT_STATUS_PATTERNS,
} from './openapi/audit'
import { readOperationMap } from './openapi/map-file'
import { checkStubs, existingFiles, generateStubs } from './openapi/stubs'
import { applyAllowlist, diffSpecs } from './openapi/diff'
import { collectEvidence } from './openapi/evidence'
import { stepCatalogue } from './steps/catalogue'
import { initProject, nextSteps, PIECES, type Piece } from './cli/init'

const HELP = `Usage: ctf <command> [options]

Commands:
  init [dir]                      Write a starter suite: cucumber.js, support/, a feature,
                                  docker-compose.yml and .env.example (dir defaults to .)
      --with <names>                Comma-separated: wiremock, postgres, redis, mailpit, spa
                                    (default wiremock; spa also brings wiremock)
      --containers                  Write cucumber.mjs, which starts the services in Docker
                                    with Testcontainers, instead of cucumber.js and
                                    docker-compose.yml (not for mailpit)
      --force                       Overwrite files that already exist

  generate-operation-map <spec>   Write a typed operation map for an OpenAPI spec
      --out <file>                  Write it here (default: print it)
      --check                       Fail if --out differs from what would be generated
      --include <regex>             Only operations whose name matches
      --exclude <regex>             Leave out operations whose name matches
      --import-from <module>        Where OperationMap comes from
                                    (default @bearingsoftware/component-test-framework/core)

  check-operation-map [<map> <spec>]  Fail when operation maps and specs disagree
      --complete                    Every spec operation must be in the map too
      --pair <map>=<spec>[=<base>]  Check another map (repeatable); <base> is
                                    that spec's base path, in place of --base-path
      --complete-pair <map>=<spec>[=<base>]
                                    Check another map that must cover its whole spec
      --allowlist <file>            Known gaps, one name or "METHOD /path" per line;
                                    an entry that matches nothing fails as stale

  audit-coverage <spec>           List spec operations no feature exercises
      --features <dir|file>         Feature files to search (repeatable, required)
      --map <file>                  The suite's operation map, naming unnamed operations
      --pattern <regex>             How features name an operation, the name in group 1
                                    (repeatable; default: "to the (\\w+) operation")
      --statuses                    Also list documented response statuses no scenario asserts
      --status-pattern <regex>      How features assert a status, the status in group 1
                                    (repeatable; default: "the response status should be (\\d+)")
      --fail-on-gaps                Exit 1 when any operation is unexercised
                                    (with --statuses, or any status is unasserted)
      --json                        Print the result as JSON, including statuses and statusGaps

  steps                           List every step the framework can register, from what its
                                  register...Steps functions register
      --json                        Print { version, steps } as JSON

  stubs <spec> --out <dir>        Write WireMock mappings from an OpenAPI spec's examples,
                                  to <dir>/mappings, one file per operation
      --include <regex>             Only operations whose name matches
      --exclude <regex>             Leave out operations whose name matches
      --all-statuses                A mapping for every documented status, not just the
                                    lowest 2xx
      --force                       Overwrite files that already exist

  stubs --check <spec> <dir>      Fail when the mappings in <dir>/mappings no longer
                                  match the spec
      --allowlist <file>            Known gaps, one mapping file name per line;
                                    an entry that matches nothing fails as stale
      --templated                   WireMock templates every response: skip bodies with {{
      --json                        Print the result as JSON

  api-diff <base> <head>          List what changed between two OpenAPI specs, and which are breaking
      --allowlist <file>            Accepted breaks, "METHOD /path" or "METHOD /path <rule>" per line;
                                    an entry that matches no breaking change fails as stale
      --out-flag <file>             Write true or false: whether a breaking change was found
      --json                        Print the result as JSON

  evidence                        Write test evidence for risk-gate, computed from files at a
                                  git base and the head, without running anything
      --base <git-ref>              The ref to compare against (required; needs its history)
      --head <git-ref>              The ref to evidence (default: the working tree)
      --spec <path>                 An OpenAPI spec (repeatable, required)
      --features <dir|file>         Feature files to read (repeatable, required)
      --map <file>                  The suite's operation map
      --allowlist <file>            api-diff allowlist: accepted breaks
      --pattern <regex>             How features name an operation (as audit-coverage)
      --status-pattern <regex>      How features assert a status (as audit-coverage)
      --out <dir>                   Write coverage-base.txt, coverage-head.txt, api-break.txt
                                    and evidence.json here (required)
                                    Exits 0 once written, never 1.

Exit status: 0 when all is well, 1 when a check finds problems (or the audit
finds gaps with --fail-on-gaps), 2 when the command can't run.

Shared options:
  --base-path <path>    Put in front of every spec path (default: from the spec's servers)
  --export-name <name>  The map's exported constant (default operationMap)
  --help                This text
`

class UsageError extends Error {}

function pairOf(value: string, complete: boolean): CheckPair {
  const [map, spec, basePath, ...rest] = value.split('=')
  if (!map || !spec || rest.length > 0) {
    throw new UsageError(`expected <map>=<spec> or <map>=<spec>=<base path>, got ${value}`)
  }
  return { map, spec, complete, basePath }
}

function regex(value: string | undefined): RegExp | undefined {
  if (value === undefined) return undefined
  try {
    return new RegExp(value)
  } catch (err) {
    throw new UsageError(`not a valid regular expression: ${value} (${(err as Error).message})`)
  }
}

function init(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      with: { type: 'string' },
      force: { type: 'boolean' },
      containers: { type: 'boolean' },
    },
  })
  if (positionals.length > 1) throw new UsageError('init takes one directory')
  const names = (values.with ?? 'wiremock').split(',').filter(Boolean)
  const unknown = names.filter((n) => !(PIECES as readonly string[]).includes(n))
  if (unknown.length > 0 || names.length === 0) {
    throw new UsageError(
      `unknown --with name${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ') || '(none given)'}; valid names are ${PIECES.join(', ')}`,
    )
  }
  const containers = values.containers ?? false
  if (containers && names.includes('mailpit')) {
    throw new UsageError('--containers has no Mailpit container; drop mailpit from --with')
  }
  const dir = positionals[0] ?? '.'
  const keptTsconfig = fs.existsSync(path.join(dir, 'tsconfig.json'))
  for (const file of initProject(dir, names as Piece[], values.force ?? false, containers)) {
    console.log(`wrote ${path.join(dir, file)}`)
  }
  if (keptTsconfig) {
    console.log(
      `\nKept your tsconfig.json. ts-node needs "module": "commonjs", "moduleResolution": "node" and "esModuleInterop": true in it.`,
    )
  }
  console.log(nextSteps(dir, names as Piece[], containers))
  return 0
}

function generate(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      check: { type: 'boolean' },
      include: { type: 'string' },
      exclude: { type: 'string' },
      'import-from': { type: 'string' },
      'base-path': { type: 'string' },
      'export-name': { type: 'string' },
    },
  })
  const [spec] = positionals
  if (!spec || positionals.length > 1) throw new UsageError('generate-operation-map takes one spec')
  if (values.check && !values.out) throw new UsageError('--check needs --out')

  const output = generateOperationMap(loadSpec(spec, { basePath: values['base-path'] }), {
    // Relative to the file it's written into, so the header (and --check)
    // doesn't depend on where the command runs.
    specLabel: path
      .relative(values.out ? path.dirname(path.resolve(values.out)) : process.cwd(), spec)
      .split(path.sep)
      .join('/'),
    importFrom: values['import-from'],
    exportName: values['export-name'],
    include: regex(values.include),
    exclude: regex(values.exclude),
  })
  if (!values.out) {
    process.stdout.write(output)
    return 0
  }
  if (values.check) {
    const current = fs.existsSync(values.out)
      ? fs.readFileSync(values.out, 'utf-8').replace(/\r\n/g, '\n')
      : ''
    if (current === output) {
      console.log(`${values.out} is up to date with ${spec}`)
      return 0
    }
    console.error(
      `${values.out} is out of date with ${spec}: run ctf generate-operation-map ${spec} --out ${values.out}`,
    )
    return 1
  }
  fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true })
  fs.writeFileSync(values.out, output)
  console.log(`wrote ${values.out}`)
  return 0
}

function check(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      complete: { type: 'boolean' },
      pair: { type: 'string', multiple: true },
      'complete-pair': { type: 'string', multiple: true },
      allowlist: { type: 'string' },
      'base-path': { type: 'string' },
      'export-name': { type: 'string' },
    },
  })
  const pairs: CheckPair[] = []
  if (positionals.length === 2) {
    pairs.push({ map: positionals[0], spec: positionals[1], complete: values.complete })
  } else if (positionals.length !== 0) {
    throw new UsageError('check-operation-map takes a map and a spec, or --pair options')
  } else if (values.complete) {
    throw new UsageError('--complete applies to <map> <spec>; use --complete-pair with --pair')
  }
  for (const p of values.pair ?? []) pairs.push(pairOf(p, false))
  for (const p of values['complete-pair'] ?? []) pairs.push(pairOf(p, true))
  if (pairs.length === 0) throw new UsageError('check-operation-map needs a map and a spec')

  const result = checkOperationMaps(pairs, {
    basePath: values['base-path'],
    exportName: values['export-name'],
    allowlist: values.allowlist ? readAllowlist(values.allowlist) : undefined,
  })
  for (const problem of result.problems) console.error(`${problem.where}: ${problem.message}`)
  for (const key of result.stale) {
    console.error(`${values.allowlist}: '${key}' no longer matches any problem; remove it`)
  }
  const failures = result.problems.length + result.stale.length
  if (failures > 0) {
    console.error(`\n${failures} problem(s) between the operation map and the spec.`)
    return 1
  }
  const allowed = result.allowlisted.length ? ` (${result.allowlisted.length} allowlisted)` : ''
  console.log(`operation map and spec agree${allowed}`)
  return 0
}

function audit(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      features: { type: 'string', multiple: true },
      map: { type: 'string' },
      pattern: { type: 'string', multiple: true },
      'status-pattern': { type: 'string', multiple: true },
      statuses: { type: 'boolean' },
      'fail-on-gaps': { type: 'boolean' },
      json: { type: 'boolean' },
      'base-path': { type: 'string' },
      'export-name': { type: 'string' },
    },
  })
  if (positionals.length === 0) throw new UsageError('audit-coverage needs at least one spec')
  if (!values.features?.length) throw new UsageError('audit-coverage needs --features')

  const result = auditCoverage({
    operations: positionals.flatMap((spec) => {
      const options = { basePath: values['base-path'] }
      try {
        return loadSpecDetail(spec, options).operations
      } catch (err) {
        // A response the audit can't read must not break an audit that doesn't need it.
        if (values.statuses) throw err
        return loadSpec(spec, options)
      }
    }),
    map: values.map ? readOperationMap(values.map, values['export-name']).entries : undefined,
    featureFiles: findFeatureFiles(values.features),
    patterns: values.pattern?.map((p) => regex(p) as RegExp) ?? DEFAULT_REFERENCE_PATTERNS,
    statusPatterns:
      values['status-pattern']?.map((p) => regex(p) as RegExp) ?? DEFAULT_STATUS_PATTERNS,
  })
  if (values.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const op of result.gaps) {
      console.log(
        op.name ? `${op.name}\t${op.method} ${op.path}` : `(unnamed)\t${op.method} ${op.path}`,
      )
    }
    for (const ref of result.unknown) {
      console.error(`${ref.where}: '${ref.name}' is not an operation in the spec or the map`)
    }
    const covered = result.operations.length - result.gaps.length
    console.error(
      `\n${result.operations.length} operations, ${covered} exercised by a feature, ${result.gaps.length} not.`,
    )
    if (values.statuses) {
      for (const gap of result.statusGaps) {
        console.log(`${gap.operation ?? '(unnamed)'}\t${gap.method} ${gap.path}\t${gap.status}`)
      }
      console.error(
        `${result.statusGaps.length} documented response status(es) no scenario asserts.`,
      )
    }
  }
  const failing = result.gaps.length + (values.statuses ? result.statusGaps.length : 0)
  return values['fail-on-gaps'] && failing > 0 ? 1 : 0
}

function evidence(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      spec: { type: 'string', multiple: true },
      features: { type: 'string', multiple: true },
      map: { type: 'string' },
      allowlist: { type: 'string' },
      pattern: { type: 'string', multiple: true },
      'status-pattern': { type: 'string', multiple: true },
      out: { type: 'string' },
      'base-path': { type: 'string' },
    },
  })
  if (positionals.length > 0) throw new UsageError('evidence takes options only')
  if (!values.base) throw new UsageError('evidence needs --base')
  if (!values.spec?.length) throw new UsageError('evidence needs --spec')
  if (!values.features?.length) throw new UsageError('evidence needs --features')
  if (!values.out) throw new UsageError('evidence needs --out')

  const result = collectEvidence({
    base: values.base,
    head: values.head,
    specs: values.spec,
    features: values.features,
    map: values.map,
    basePath: values['base-path'],
    allowlist: values.allowlist,
    patterns: values.pattern?.map((p) => regex(p) as RegExp),
    statusPatterns: values['status-pattern']?.map((p) => regex(p) as RegExp),
    out: values.out,
  })
  console.log(
    `wrote ${values.out}: coverage ${result.coverage.base.toFixed(2)} -> ${result.coverage.head.toFixed(2)}, ` +
      `api break ${result.apiDiff.breaking.length > 0}`,
  )
  return 0
}

function steps(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: 'boolean' } },
  })
  if (positionals.length > 0) throw new UsageError('steps takes no arguments')
  const catalogue = stepCatalogue()
  if (values.json) {
    console.log(JSON.stringify({ version: 1, steps: catalogue }, null, 2))
    return 0
  }
  const rows = catalogue.map((s) => [
    s.keyword,
    s.expression,
    `${s.registeredBy} (${s.entryPoint})${s.optIn ? ' opt-in' : ''}`,
  ])
  const widths = [0, 1].map((c) => Math.max(...rows.map((r) => r[c].length)))
  for (const r of rows) {
    console.log(`${r[0].padEnd(widths[0])}  ${r[1].padEnd(widths[1])}  ${r[2]}`)
  }
  console.error(`\n${catalogue.length} steps.`)
  return 0
}

function stubs(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      check: { type: 'boolean' },
      include: { type: 'string' },
      exclude: { type: 'string' },
      'all-statuses': { type: 'boolean' },
      force: { type: 'boolean' },
      allowlist: { type: 'string' },
      json: { type: 'boolean' },
      templated: { type: 'boolean' },
      'base-path': { type: 'string' },
    },
  })
  const basePath = values['base-path']

  if (values.check) {
    if (positionals.length !== 2) throw new UsageError('stubs --check takes a spec and a directory')
    if (values.out) throw new UsageError('--out is for writing stubs, not for --check')
    const [spec, dir] = positionals
    const result = checkStubs(spec, dir, {
      basePath,
      allowlist: values.allowlist ? readAllowlist(values.allowlist) : undefined,
      templated: values.templated,
    })
    if (values.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      for (const w of result.warnings) console.error(`${w.where}: warning: ${w.message}`)
      for (const p of result.problems) console.error(`${p.where}: ${p.message}`)
      for (const key of result.stale) {
        console.error(`${values.allowlist}: '${key}' no longer matches any problem; remove it`)
      }
    }
    const failures = result.problems.length + result.stale.length
    if (failures > 0) {
      if (!values.json) console.error(`\n${failures} problem(s) between the stubs and the spec.`)
      return 1
    }
    if (!values.json) {
      const allowed = result.allowlisted.length ? ` (${result.allowlisted.length} allowlisted)` : ''
      console.log(`stubs and spec agree${allowed}`)
    }
    return 0
  }

  if (values.allowlist || values.json || values.templated) {
    throw new UsageError('--allowlist, --json and --templated are for --check')
  }
  const [spec] = positionals
  if (!spec || positionals.length > 1) throw new UsageError('stubs takes one spec')
  if (!values.out) throw new UsageError('stubs needs --out <dir>')
  const { mappings, skipped, warnings } = generateStubs(spec, {
    basePath,
    include: regex(values.include),
    exclude: regex(values.exclude),
    allStatuses: values['all-statuses'],
  })
  const existing = existingFiles(values.out, mappings)
  if (existing.length > 0 && !values.force) {
    throw new Error(`won't overwrite ${existing.join(', ')}; pass --force to replace them`)
  }
  for (const { file, mapping } of mappings) {
    const target = path.join(values.out, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(mapping, null, 2)}\n`)
    console.log(`wrote ${target}`)
  }
  for (const s of skipped) console.error(`skipped ${s.operation}: ${s.reason}`)
  for (const w of warnings) console.error(`warning: ${w.operation}: ${w.reason}`)
  return 0
}

function apiDiff(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'base-path': { type: 'string' },
      json: { type: 'boolean' },
      allowlist: { type: 'string' },
      'out-flag': { type: 'string' },
    },
  })
  // A flag left by an earlier run must not be read as this run's answer.
  if (values['out-flag']) fs.rmSync(values['out-flag'], { force: true })
  if (positionals.length !== 2) throw new UsageError('api-diff takes a base spec and a head spec')
  const [base, head] = positionals

  const diff = diffSpecs(base, head, { basePath: values['base-path'] })
  const allowed = applyAllowlist(
    diff.breaking,
    values.allowlist ? readAllowlist(values.allowlist) : [],
  )
  const breaking = allowed.breaking
  const shown = diff.nonBreaking.filter((f) => f.rule !== 'description-changed')

  if (values.json) {
    console.log(JSON.stringify({ version: 1, breaking, nonBreaking: diff.nonBreaking }, null, 2))
  } else {
    for (const f of breaking)
      console.log(`breaking  ${f.rule}  ${f.operation}  ${f.location}  ${f.detail}`)
    for (const f of shown)
      console.log(`non-breaking  ${f.rule}  ${f.operation}  ${f.location}  ${f.detail}`)
    const allowedNote = allowed.allowlisted ? `, ${allowed.allowlisted} allowlisted` : ''
    console.log(`${breaking.length} breaking, ${shown.length} non-breaking${allowedNote}`)
  }
  for (const line of allowed.stale) {
    console.error(`${values.allowlist}: '${line}' no longer matches any breaking change; remove it`)
  }
  if (values['out-flag']) fs.writeFileSync(values['out-flag'], String(breaking.length > 0))
  return breaking.length > 0 || allowed.stale.length > 0 ? 1 : 0
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv
  try {
    if (!command) {
      process.stderr.write(HELP)
      return 2
    }
    if (command === '--help' || command === 'help' || rest.includes('--help')) {
      process.stdout.write(HELP)
      return 0
    }
    if (command === 'init') return init(rest)
    if (command === 'generate-operation-map') return generate(rest)
    if (command === 'check-operation-map') return check(rest)
    if (command === 'audit-coverage') return audit(rest)
    if (command === 'stubs') return stubs(rest)
    if (command === 'api-diff') return apiDiff(rest)
    if (command === 'steps') return steps(rest)
    if (command === 'evidence') return evidence(rest)
    throw new UsageError(`unknown command: ${command}`)
  } catch (err) {
    const usage =
      err instanceof UsageError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
    console.error(`ctf: ${(err as Error).message}${usage ? '\nRun ctf --help for usage.' : ''}`)
    // Couldn't run, as distinct from ran and found problems.
    return 2
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2))
}
