import * as fs from 'fs'
import { readOperationMap } from './map-file'
import { findOperation, loadSpec, type SpecOperation } from './spec'

/** A map and the spec to check it against. */
export interface CheckPair {
  map: string
  spec: string
  /**
   * Every spec operation must be in the map, not just every map entry in
   * the spec. For a map meant to cover the whole API; leave it off for a
   * suite's subset.
   */
  complete?: boolean
  /** A base path for this pair's spec, in place of {@link CheckOptions.basePath}. */
  basePath?: string
}

/** Options for {@link checkOperationMaps}. */
export interface CheckOptions {
  /** See {@link LoadSpecOptions.basePath}. */
  basePath?: string
  /** The map's exported name. Default `operationMap`. */
  exportName?: string
  /**
   * Known gaps, each an operation name or `METHOD /path`, that aren't
   * reported. An entry that no longer matches a problem is reported as stale.
   */
  allowlist?: Iterable<string>
}

/** One mismatch between a map and its spec. */
export interface Problem {
  /** The operation it's about: a name, or `METHOD /path` for an unnamed one. */
  key: string
  /** Where it was found, `file:line` when the line is known. */
  where: string
  message: string
}

/** What {@link checkOperationMaps} found. */
export interface CheckResult {
  problems: Problem[]
  /** Problems the allowlist accounted for. */
  allowlisted: Problem[]
  /** Allowlist entries that matched nothing: remove them. */
  stale: string[]
}

/**
 * Check operation maps against their specs, both ways: every map entry must
 * be a spec operation, by `operationId` or, for a spec without ids, by
 * method and path; with `complete`, every spec operation must be mapped.
 * Path parameter names may differ (`{id}` and `{projectId}` match).
 */
export function checkOperationMaps(pairs: CheckPair[], options: CheckOptions = {}): CheckResult {
  const found: Problem[] = []
  for (const pair of pairs) {
    const spec = loadSpec(pair.spec, { basePath: pair.basePath ?? options.basePath })
    found.push(...checkPair(pair, spec, options.exportName))
  }

  const allowlist = new Set(options.allowlist ?? [])
  const used = new Set<string>()
  const result: CheckResult = { problems: [], allowlisted: [], stale: [] }
  for (const problem of found) {
    if (allowlist.has(problem.key)) {
      used.add(problem.key)
      result.allowlisted.push(problem)
    } else {
      result.problems.push(problem)
    }
  }
  result.stale = [...allowlist].filter((key) => !used.has(key)).sort()
  return result
}

function checkPair(pair: CheckPair, spec: SpecOperation[], exportName?: string): Problem[] {
  const map = readOperationMap(pair.map, exportName)
  const problems: Problem[] = []
  const at = (line: number) => (line ? `${pair.map}:${line}` : pair.map)
  const describe = (op: { method: string; path: string }) => `${op.method} ${op.path}`

  for (const bad of map.unreadable) {
    problems.push({
      key: bad.key,
      where: at(bad.line),
      message: `entry '${bad.key}' can't be checked: ${bad.reason}`,
    })
  }

  const byId = new Map(
    spec.filter((op) => op.operationId).map((op) => [op.operationId as string, op]),
  )
  const mapped = new Set<SpecOperation>()

  for (const entry of map.entries) {
    const named = byId.get(entry.key)
    if (named) {
      mapped.add(named)
      // Where the request actually goes: a more specific route may take it.
      const routed = findOperation(spec, entry.method, entry.path)
      if (routed !== named) {
        const target = routed?.operationId ? `'${routed.operationId}' ` : ''
        problems.push({
          key: entry.key,
          where: at(entry.line),
          message: routed
            ? `'${entry.key}' is ${describe(entry)} in the map, which ${pair.spec} routes to ` +
              `${target}(${describe(routed)}), not to '${entry.key}' (${describe(named)})`
            : `'${entry.key}' is ${describe(entry)} in the map but ${describe(named)} in ${pair.spec}`,
        })
      }
      continue
    }
    const route = findOperation(spec, entry.method, entry.path)
    if (route?.operationId) {
      mapped.add(route)
      problems.push({
        key: entry.key,
        where: at(entry.line),
        message: `'${entry.key}' (${describe(entry)}) is called '${route.operationId}' in ${pair.spec}`,
      })
    } else if (route) {
      // A spec without operationIds: the map names it, matched by route.
      mapped.add(route)
    } else {
      problems.push({
        key: entry.key,
        where: at(entry.line),
        message: `'${entry.key}' (${describe(entry)}) is not in ${pair.spec}`,
      })
    }
  }

  if (pair.complete) {
    for (const op of spec) {
      if (mapped.has(op)) continue
      const key = op.operationId ?? describe(op)
      problems.push({
        key,
        where: pair.map,
        message: `${op.operationId ? `'${op.operationId}' (${describe(op)})` : describe(op)} is in ${pair.spec} but not in the map`,
      })
    }
  }
  return problems
}

/** Read an allowlist file: one entry per line, `#` starts a comment. */
export function readAllowlist(file: string): string[] {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .map((line) => line.split('#', 1)[0].trim())
    .filter(Boolean)
}
