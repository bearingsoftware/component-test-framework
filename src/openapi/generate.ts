import type { SpecOperation } from './spec'

/** Options for {@link generateOperationMap}. */
export interface GenerateOptions {
  /** The spec, as named in the file's header comment. */
  specLabel: string
  /** Where `OperationMap` is imported from. Default `@bearingsoftware/component-test-framework/core`. */
  importFrom?: string
  /** The exported constant's name. Default `operationMap`. */
  exportName?: string
  /** Keep only operations whose name matches. */
  include?: RegExp
  /** Leave out operations whose name matches. */
  exclude?: RegExp
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * A name for an operation without an `operationId`, from its method and
 * path: `GET /projects/{id}/remediable` is `getProjectsByIdRemediable`.
 */
export function operationName(method: string, route: string): string {
  const words = route
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const param = /^\{(.+)\}$/.exec(segment)
      return param ? `by-${param[1]}` : segment
    })
    .join('-')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  const name = [method.toLowerCase(), ...words.map((w) => w[0].toUpperCase() + w.slice(1))].join('')
  return /^[0-9]/.test(name) ? `_${name}` : name
}

/** Every operation with a name: its `operationId`, or one made from its method and path. */
export function namedOperations(operations: SpecOperation[]): (SpecOperation & { name: string })[] {
  const used = new Set(operations.map((op) => op.operationId).filter(Boolean) as string[])
  return operations.map((op) => {
    if (op.operationId) return { ...op, name: op.operationId }
    // From the spec's path: the base path isn't part of the name.
    let name = operationName(op.method, op.route)
    for (let n = 2; used.has(name); n++) name = `${operationName(op.method, op.route)}${n}`
    used.add(name)
    return { ...op, name }
  })
}

/** A typed `operation-map.ts` for a spec's operations. */
export function generateOperationMap(
  operations: SpecOperation[],
  options: GenerateOptions,
): string {
  const exportName = options.exportName ?? 'operationMap'
  const named = namedOperations(operations).filter(
    (op) => (!options.include || options.include.test(op.name)) && !options.exclude?.test(op.name),
  )
  const quote = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  const lines = [
    `// Generated from ${options.specLabel} by ctf generate-operation-map.`,
    '// Regenerate it rather than editing it; ctf check-operation-map checks it against the spec.',
    `import type { OperationMap } from ${quote(options.importFrom ?? '@bearingsoftware/component-test-framework/core')}`,
    '',
    `export const ${exportName} = {`,
  ]
  for (const op of named) {
    if (op.summary)
      lines.push(`  /** ${op.summary.replace(/\*\//g, '*\\/').replace(/\s+/g, ' ').trim()} */`)
    // A bare or quoted __proto__ would set the object's prototype instead.
    const key =
      op.name === '__proto__'
        ? `['__proto__']`
        : IDENTIFIER.test(op.name)
          ? op.name
          : quote(op.name)
    lines.push(`  ${key}: { method: ${quote(op.method)}, path: ${quote(op.path)} },`)
  }
  lines.push(
    '} as const satisfies OperationMap',
    '',
    `/** An operation the map names. */`,
    `export type OperationName = keyof typeof ${exportName}`,
    '',
  )
  return lines.join('\n')
}
