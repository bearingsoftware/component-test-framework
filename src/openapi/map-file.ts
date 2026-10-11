import * as fs from 'fs'
import type * as TS from 'typescript'

/** One entry of an operation map file, with where it is. */
export interface MapEntry {
  key: string
  method: string
  path: string
  line: number
}

/** What {@link readOperationMap} found. */
export interface MapFile {
  entries: MapEntry[]
  /** Properties that aren't a `{ method, path }` of plain strings, so can't be checked. */
  unreadable: { key: string; line: number; reason: string }[]
}

/**
 * Read an operation map from a `.ts` or `.js` file without running it: the
 * object literal exported as `exportName` (default `operationMap`), whose
 * properties are `{ method: '…', path: '…' }`. Entries may span lines and
 * carry comments. A JSON file is read as the map itself. Needs `typescript`
 * for `.ts` and `.js` files.
 */
export function readOperationMap(file: string, exportName = 'operationMap'): MapFile {
  const text = fs.readFileSync(file, 'utf-8')
  if (file.endsWith('.json')) return fromJson(JSON.parse(text) as Record<string, unknown>)

  let ts: typeof TS
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ts = require('typescript') as typeof TS
  } catch {
    throw new Error(
      `Reading ${file} needs the typescript package: npm install --save-dev typescript`,
    )
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const literal = findMapLiteral(ts, source, exportName)
  if (!literal) {
    throw new Error(`${file} has no object literal named ${exportName}`)
  }

  const lineOf = (node: TS.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1
  const result: MapFile = { entries: [], unreadable: [] }
  for (const prop of literal.properties) {
    const key = prop.name ? propertyName(ts, prop.name) : undefined
    if (!key || !ts.isPropertyAssignment(prop)) {
      result.unreadable.push({
        key: key ?? prop.getText(source).slice(0, 40),
        line: lineOf(prop),
        reason: 'not a plain property (a spread or a method)',
      })
      continue
    }
    const value = unwrap(ts, prop.initializer)
    const fields = ts.isObjectLiteralExpression(value) ? stringFields(ts, value) : {}
    if (!fields.method || !fields.path) {
      result.unreadable.push({
        key,
        line: lineOf(prop),
        reason: 'method or path is not a string literal',
      })
      continue
    }
    result.entries.push({
      key,
      method: fields.method.toUpperCase(),
      path: fields.path,
      line: lineOf(prop),
    })
  }
  return result
}

function fromJson(map: Record<string, unknown>): MapFile {
  const result: MapFile = { entries: [], unreadable: [] }
  for (const [key, value] of Object.entries(map)) {
    const entry = value as { method?: unknown; path?: unknown }
    if (typeof entry?.method === 'string' && typeof entry.path === 'string') {
      result.entries.push({ key, method: entry.method.toUpperCase(), path: entry.path, line: 0 })
    } else {
      result.unreadable.push({ key, line: 0, reason: 'method or path is not a string' })
    }
  }
  return result
}

/** Strip `as const`, `satisfies T`, `<T>x` and parentheses. */
function unwrap(ts: typeof TS, node: TS.Expression): TS.Expression {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    node = node.expression
  }
  return node
}

function findMapLiteral(
  ts: typeof TS,
  source: TS.SourceFile,
  exportName: string,
): TS.ObjectLiteralExpression | undefined {
  let found: TS.ObjectLiteralExpression | undefined
  const visit = (node: TS.Node) => {
    if (found) return
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === exportName &&
      node.initializer
    ) {
      const value = unwrap(ts, node.initializer)
      if (ts.isObjectLiteralExpression(value)) found = value
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function propertyName(ts: typeof TS, name: TS.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression))
    return name.expression.text
  return undefined
}

function stringFields(ts: typeof TS, obj: TS.ObjectLiteralExpression): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const name = propertyName(ts, prop.name)
    const value = unwrap(ts, prop.initializer)
    if (name && ts.isStringLiteralLike(value)) fields[name] = value.text
  }
  return fields
}
