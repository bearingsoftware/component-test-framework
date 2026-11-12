// Fails on a broken relative link or #anchor in README.md, docs/** and examples/**.
import * as fs from 'node:fs'
import * as path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules'
      ? markdownFiles(full)
      : e.name.endsWith('.md')
        ? [full]
        : []
  })
}

// Lines outside fenced code blocks.
function proseLines(file) {
  let fenced = false
  const out = []
  fs.readFileSync(file, 'utf-8')
    .split('\n')
    .forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
      else if (!fenced) out.push([i + 1, line])
    })
  return out
}

const slug = (heading) =>
  heading
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- _]/gu, '')
    .replace(/ /g, '-')

const anchorCache = new Map()
function anchors(file) {
  if (!anchorCache.has(file)) {
    const seen = new Map()
    const set = new Set()
    for (const [, line] of proseLines(file)) {
      const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
      if (!m) continue
      const base = slug(m[1])
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      set.add(n ? `${base}-${n}` : base)
    }
    anchorCache.set(file, set)
  }
  return anchorCache.get(file)
}

const files = [
  path.join(root, 'README.md'),
  ...markdownFiles(path.join(root, 'docs')),
  ...markdownFiles(path.join(root, 'examples')),
]
const problems = []
for (const file of files) {
  const rel = path.relative(root, file)
  for (const [lineNo, line] of proseLines(file)) {
    const text = line.replace(/`[^`]*`/g, '')
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1]
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
      const [pathPart, fragment] = target.split('#')
      const dest = pathPart ? path.resolve(path.dirname(file), pathPart) : file
      if (!fs.existsSync(dest)) {
        problems.push(`${rel}:${lineNo}: ${target} does not exist`)
        continue
      }
      if (fragment && dest.endsWith('.md') && !anchors(dest).has(fragment)) {
        problems.push(`${rel}:${lineNo}: ${target} has no heading #${fragment}`)
      }
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  console.error(`\n${problems.length} broken link(s)`)
  process.exit(1)
}
console.log(`${files.length} files, all relative links and anchors resolve`)
