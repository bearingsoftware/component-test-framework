#!/usr/bin/env node
// `ctf`: OpenAPI tooling for component-test suites.
import * as fs from 'fs'
import * as path from 'path'
import { parseArgs } from 'util'
import { loadSpec } from './openapi/spec'
import { generateOperationMap } from './openapi/generate'
import { checkOperationMaps, readAllowlist, type CheckPair } from './openapi/check'
import { auditCoverage, findFeatureFiles, DEFAULT_REFERENCE_PATTERNS } from './openapi/audit'
import { readOperationMap } from './openapi/map-file'

const HELP = `Usage: ctf <command> [options]

Commands:
  generate-operation-map <spec>   Write a typed operation map for an OpenAPI spec
      --out <file>                  Write it here (default: print it)
      --check                       Fail if --out differs from what would be generated
      --include <regex>             Only operations whose name matches
      --exclude <regex>             Leave out operations whose name matches
      --import-from <module>        Where OperationMap comes from
                                    (default @bearingsoftware/component-test-framework/core)

  check-operation-map [<map> <spec>]  Fail when operation maps and specs disagree
      --complete                    Every spec operation must be in the map too
      --pair <map>=<spec>           Check another map (repeatable)
      --complete-pair <map>=<spec>  Check another map that must cover its whole spec
      --allowlist <file>            Known gaps, one name or "METHOD /path" per line;
                                    an entry that matches nothing fails as stale

  audit-coverage <spec>           List spec operations no feature exercises
      --features <dir|file>         Feature files to search (repeatable, required)
      --map <file>                  The suite's operation map, naming unnamed operations
      --pattern <regex>             How features name an operation, the name in group 1
                                    (repeatable; default: "to the (\\w+) operation")
      --fail-on-gaps                Exit 1 when any operation is unexercised
      --json                        Print the result as JSON

Shared options:
  --base-path <path>    Put in front of every spec path (default: from the spec's servers)
  --export-name <name>  The map's exported constant (default operationMap)
  --help                This text
`

class UsageError extends Error {}

function pairOf(value: string, complete: boolean): CheckPair {
  const at = value.lastIndexOf('=')
  if (at <= 0) throw new UsageError(`expected <map>=<spec>, got ${value}`)
  return { map: value.slice(0, at), spec: value.slice(at + 1), complete }
}

function regex(value: string | undefined): RegExp | undefined {
  if (value === undefined) return undefined
  try {
    return new RegExp(value)
  } catch (err) {
    throw new UsageError(`not a valid regular expression: ${value} (${(err as Error).message})`)
  }
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
    specLabel: spec,
    importFrom: values['import-from'],
    exportName: values['export-name'],
    include: regex(values.include),
    exclude: regex(values.exclude),
    command: `ctf generate-operation-map ${[spec, ...(values.out ? ['--out', values.out] : [])].join(' ')}`,
  })
  if (!values.out) {
    process.stdout.write(output)
    return 0
  }
  if (values.check) {
    const current = fs.existsSync(values.out) ? fs.readFileSync(values.out, 'utf-8') : ''
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
      'fail-on-gaps': { type: 'boolean' },
      json: { type: 'boolean' },
      'base-path': { type: 'string' },
      'export-name': { type: 'string' },
    },
  })
  if (positionals.length === 0) throw new UsageError('audit-coverage needs at least one spec')
  if (!values.features?.length) throw new UsageError('audit-coverage needs --features')

  const result = auditCoverage({
    operations: positionals.flatMap((spec) => loadSpec(spec, { basePath: values['base-path'] })),
    map: values.map ? readOperationMap(values.map, values['export-name']).entries : undefined,
    featureFiles: findFeatureFiles(values.features),
    patterns: values.pattern?.map((p) => regex(p) as RegExp) ?? DEFAULT_REFERENCE_PATTERNS,
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
  }
  return values['fail-on-gaps'] && result.gaps.length > 0 ? 1 : 0
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv
  try {
    if (!command || command === '--help' || command === 'help' || rest.includes('--help')) {
      process.stdout.write(HELP)
      return command ? 0 : 2
    }
    if (command === 'generate-operation-map') return generate(rest)
    if (command === 'check-operation-map') return check(rest)
    if (command === 'audit-coverage') return audit(rest)
    throw new UsageError(`unknown command: ${command}`)
  } catch (err) {
    const usage =
      err instanceof UsageError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
    console.error(`ctf: ${(err as Error).message}${usage ? '\nRun ctf --help for usage.' : ''}`)
    return usage ? 2 : 1
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2))
}
