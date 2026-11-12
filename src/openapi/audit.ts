import * as fs from 'fs'
import * as path from 'path'
import type { MapEntry } from './map-file'
import { parseFeature } from './gherkin'
import { findOperation, type SpecOperation, type SpecResponse } from './spec'

/**
 * How the framework's steps name an operation: "I send the request x to the
 * login operation", "I authenticate with the request x to the login operation".
 */
export const DEFAULT_REFERENCE_PATTERNS = [/\bto the ([A-Za-z_$][\w$]*) operation\b/g]

/** How the framework's step asserts a status: "the response status should be 201". */
export const DEFAULT_STATUS_PATTERNS = [/\bthe response status should be (\d+)\b/]

/** Options for {@link auditCoverage}. */
export interface AuditOptions {
  /**
   * The spec's operations. Those with `responses` (from `loadSpecDetail`)
   * also get their documented statuses checked; others have none to check.
   */
  operations: (SpecOperation & { responses?: SpecResponse[] })[]
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
  /**
   * Patterns that find an asserted status, the status as the first group.
   * Default {@link DEFAULT_STATUS_PATTERNS}.
   */
  statusPatterns?: RegExp[]
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
  /**
   * Statuses scenarios assert after a reference to it, each with its pairs
   * as `<reference file:line> -> <assertion file:line>`.
   */
  statuses: { status: string; references: string[] }[]
  /** References, as `file:line`, with no status asserted before the next reference or the scenario's end. */
  unassertedReferences: string[]
}

/** What {@link auditCoverage} found. */
export interface AuditResult {
  operations: AuditedOperation[]
  /** Operations no feature references. */
  gaps: AuditedOperation[]
  /** Names features use that are neither a spec operation nor in the map: typos, or removed operations. */
  unknown: { name: string; where: string }[]
  /** Documented response statuses no scenario asserts. `default` is never one; `2XX` is met by any 2xx. */
  statusGaps: { operation?: string; method: string; path: string; status: string }[]
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
    statuses: [],
    unassertedReferences: [],
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

  const statusPatterns = options.statusPatterns ?? DEFAULT_STATUS_PATTERNS
  for (const file of options.featureFiles) {
    const text = fs.readFileSync(file, 'utf-8')
    if (hasOtherLanguage(text)) {
      // Keywords in another language aren't parsed; its references count as unasserted.
      console.warn(
        `${file}: a # language: other than en isn't supported; its statuses are not read`,
      )
      text.split('\n').forEach((line, i) => {
        if (/^\s*#/.test(line)) return
        for (const pattern of patterns) {
          for (const match of line.matchAll(globally(pattern))) {
            const op = match[1] ? byName.get(match[1]) : undefined
            const where = `${file}:${i + 1}`
            if (op && !op.unassertedReferences.includes(where)) op.unassertedReferences.push(where)
          }
        }
      })
      continue
    }
    for (const scenario of parseFeature(text)) {
      let open: { op: AuditedOperation; where: string } | undefined
      const closeUnasserted = () => {
        if (open && !open.op.unassertedReferences.includes(open.where)) {
          open.op.unassertedReferences.push(open.where)
        }
        open = undefined
      }
      for (const step of scenario.steps) {
        const where = `${file}:${step.line}`
        for (const pattern of patterns) {
          for (const match of step.text.matchAll(globally(pattern))) {
            const op = match[1] ? byName.get(match[1]) : undefined
            if (!op) continue
            closeUnasserted()
            open = { op, where }
          }
        }
        if (!open) continue
        const status = firstStatus(step.text, statusPatterns)
        if (status === undefined) continue
        const pair = `${open.where} -> ${where}`
        const entry = open.op.statuses.find((s) => s.status === status)
        if (!entry) open.op.statuses.push({ status, references: [pair] })
        else if (!entry.references.includes(pair)) entry.references.push(pair)
        open = undefined
      }
      closeUnasserted()
    }
  }

  const statusGaps: AuditResult['statusGaps'] = []
  options.operations.forEach((spec, i) => {
    const op = operations[i]
    const asserted = op.statuses.map((s) => s.status)
    for (const { status } of spec.responses ?? []) {
      if (/^default$/i.test(status)) continue
      const range = /^([1-5])XX$/i.exec(status)
      const met = range ? asserted.some((a) => a.startsWith(range[1])) : asserted.includes(status)
      if (!met) statusGaps.push({ operation: op.name, method: op.method, path: op.path, status })
    }
  })
  return {
    operations,
    gaps: operations.filter((op) => op.references.length === 0),
    unknown,
    statusGaps,
  }
}

function hasOtherLanguage(text: string): boolean {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('@')) continue
    const header = /^#\s*language:\s*(\S+)/.exec(trimmed)
    if (header) return header[1] !== 'en'
    if (!trimmed.startsWith('#')) return false
  }
  return false
}

function globally(pattern: RegExp): RegExp {
  return pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`)
}

function firstStatus(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const status = globally(pattern).exec(text)?.[1]
    if (status) return status
  }
  return undefined
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
