import * as fs from 'fs'
import * as path from 'path'
import type { MapEntry } from './map-file'
import { findOperation, type SpecOperation } from './spec'

/**
 * How the framework's steps name an operation: "I send the request x to the
 * login operation", "I authenticate with the request x to the login operation".
 */
export const DEFAULT_REFERENCE_PATTERNS = [/\bto the ([A-Za-z_$][\w$]*) operation\b/g]

/** Options for {@link auditCoverage}. */
export interface AuditOptions {
  /** The spec's operations. */
  operations: SpecOperation[]
  /**
   * The suite's operation map, which names operations a spec without
   * operationIds leaves unnamed, and adds names features may use.
   */
  map?: MapEntry[]
  /** Feature files to search. */
  featureFiles: string[]
  /**
   * Patterns that find operation names in feature files, each with the name
   * as its first group. Default {@link DEFAULT_REFERENCE_PATTERNS}.
   */
  patterns?: RegExp[]
}

/** One spec operation and whether any feature exercises it. */
export interface AuditedOperation {
  /** Its operationId, or its name in the map; undefined when it has neither. */
  name?: string
  /** Every name features may use for it: its operationId and its map entries. */
  aliases: string[]
  method: string
  path: string
  /** Feature files that reference it, as `file:line`. */
  references: string[]
}

/** What {@link auditCoverage} found. */
export interface AuditResult {
  operations: AuditedOperation[]
  /** Operations no feature references. */
  gaps: AuditedOperation[]
  /** Names features use that are neither a spec operation nor in the map: typos, or removed operations. */
  unknown: { name: string; where: string }[]
}

/** Which spec operations the features exercise, and which they don't. */
export function auditCoverage(options: AuditOptions): AuditResult {
  const patterns = options.patterns ?? DEFAULT_REFERENCE_PATTERNS
  const operations: AuditedOperation[] = options.operations.map((op) => ({
    name: op.operationId,
    aliases: op.operationId ? [op.operationId] : [],
    method: op.method,
    path: op.path,
    references: [],
  }))
  // A map entry names the spec operation its request goes to; several
  // entries (one per test value, say) may name the same operation.
  for (const entry of options.map ?? []) {
    const index = options.operations.indexOf(
      findOperation(options.operations, entry.method, entry.path) as SpecOperation,
    )
    if (index < 0) continue
    const op = operations[index]
    op.name ??= entry.key
    if (!op.aliases.includes(entry.key)) op.aliases.push(entry.key)
  }
  const byName = new Map(operations.flatMap((op) => op.aliases.map((a) => [a, op] as const)))
  const mapKeys = new Set((options.map ?? []).map((e) => e.key))

  const unknown: AuditResult['unknown'] = []
  for (const file of options.featureFiles) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n')
    lines.forEach((text, i) => {
      if (/^\s*#/.test(text)) return
      for (const pattern of patterns) {
        const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`)
        for (const match of text.matchAll(global)) {
          const name = match[1]
          if (!name) continue
          const where = `${file}:${i + 1}`
          const op = byName.get(name)
          if (op) op.references.push(where)
          else if (!mapKeys.has(name)) unknown.push({ name, where })
        }
      }
    })
  }
  return { operations, gaps: operations.filter((op) => op.references.length === 0), unknown }
}

/** Every `.feature` file under the given files and directories. */
export function findFeatureFiles(roots: string[]): string[] {
  const files: string[] = []
  const walk = (entry: string) => {
    const stat = fs.statSync(entry)
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry).sort()) {
        if (child !== 'node_modules') walk(path.join(entry, child))
      }
    } else if (entry.endsWith('.feature')) {
      files.push(entry)
    }
  }
  for (const root of roots) walk(root)
  return files
}
