import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as ts from 'typescript'

/**
 * Every module the entry point loads at run time, following relative imports
 * and leaving out `import type`, which compiles to nothing.
 */
function runtimeImports(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest)
    const specifiers: string[] = []
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
        // `import { type A, type B }` is erased too.
        const named = statement.importClause?.namedBindings
        const allTypes =
          !statement.importClause?.name &&
          named !== undefined &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((e) => e.isTypeOnly)
        if (!allTypes) specifiers.push((statement.moduleSpecifier as ts.StringLiteral).text)
      } else if (
        ts.isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        statement.moduleSpecifier
      ) {
        specifiers.push((statement.moduleSpecifier as ts.StringLiteral).text)
      }
    }
    // require('…') calls, as optional dependencies are loaded.
    const walk = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        specifiers.push(node.arguments[0].text)
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
    seen.set(file, specifiers)
    for (const spec of specifiers) {
      if (spec.startsWith('.')) visit(path.resolve(path.dirname(file), `${spec}.ts`))
    }
  }
  visit(entry)
  return seen
}

describe('the playwright-test entry point (COMPONENT-17)', () => {
  it('loads no Cucumber, directly or through anything it imports', () => {
    const graph = runtimeImports(path.resolve(__dirname, '..', 'playwright-test.ts'))
    const offenders = [...graph].filter(([, specs]) =>
      specs.some((s) => s.startsWith('@cucumber/')),
    )
    expect(offenders.map(([file]) => path.relative(__dirname, file))).toEqual([])
    // The walk reached the modules the fixtures are built from.
    const files = [...graph.keys()].map((f) => path.basename(f))
    expect(files).toEqual(
      expect.arrayContaining([
        'spa-server.ts',
        'coverage-collector.ts',
        'login.ts',
        'wiremock-client.ts',
      ]),
    )
  })

  it('would notice a module that does load Cucumber', () => {
    const graph = runtimeImports(path.resolve(__dirname, '..', 'spa.ts'))
    expect([...graph.values()].flat()).toContain('@cucumber/cucumber')
  })
})
