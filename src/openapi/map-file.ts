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
  // A file that doesn't parse can yield entries that aren't what it says.
  const syntax =
    (source as unknown as { parseDiagnostics?: TS.Diagnostic[] }).parseDiagnostics ?? []
  if (syntax.length > 0) {
    const first = syntax[0]
    const line =
      first.start === undefined ? 0 : source.getLineAndCharacterOfPosition(first.start).line + 1
    throw new Error(`${file}:${line}: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`)
  }
  const literal = findMapLiteral(ts, source, exportName)
  if (!literal) {
    throw new Error(
      `${file} has no top-level object literal named ${exportName}: the map must be ` +
        `\`const ${exportName} = { … }\` (exported or not), or pass --export-name`,
    )
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
  // At runtime the last of two entries with one key wins, so the earlier one
  // would be checked for nothing.
  const lastLine = new Map(result.entries.map((e) => [e.key, e.line]))
  for (const entry of result.entries) {
    if (lastLine.get(entry.key) !== entry.line) {
      result.unreadable.push({
        key: entry.key,
        line: entry.line,
        reason: `duplicate key: the entry on line ${lastLine.get(entry.key)} replaces it`,
      })
    }
  }
  result.entries = result.entries.filter((e) => lastLine.get(e.key) === e.line)
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

/** The object literal assigned to `exportName` by a top-level declaration. */
function findMapLiteral(
  ts: typeof TS,
  source: TS.SourceFile,
  exportName: string,
): TS.ObjectLiteralExpression | undefined {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== exportName) continue
      const value = declaration.initializer && unwrap(ts, declaration.initializer)
      if (value && ts.isObjectLiteralExpression(value)) return value
    }
  }
  return undefined
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
