import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const root = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: unknown
  devDependencies: Record<string, string>
}
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8')

const optionalPackages = [
  '@playwright/test',
  '@axe-core/playwright',
  'istanbul-lib-coverage',
  'istanbul-lib-report',
  'istanbul-reports',
  'typescript',
  'testcontainers',
  '@testcontainers/postgresql',
  '@testcontainers/redis',
]

describe('package.json peer dependencies', () => {
  it('declares only @cucumber/cucumber as a peer', () => {
    expect(Object.keys(pkg.peerDependencies ?? {})).toEqual(['@cucumber/cucumber'])
  })

  it('has no peerDependenciesMeta, which GitHub Packages drops', () => {
    expect(pkg).not.toHaveProperty('peerDependenciesMeta')
  })

  it.each(optionalPackages)('keeps %s in devDependencies', (name) => {
    expect(pkg.devDependencies).toHaveProperty([name])
  })

  it.each(optionalPackages)('documents %s in the README', (name) => {
    expect(readme).toContain(`\`${name}\``)
  })
})
