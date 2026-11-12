/** One step of a scenario, after Background steps and Outline rows are applied. */
export interface ParsedStep {
  text: string
  /** 1-based line of the step in the feature file. */
  line: number
}

/** A scenario as Cucumber would run it: Background steps first, an Outline row per scenario. */
export interface ParsedScenario {
  name: string
  line: number
  steps: ParsedStep[]
}

interface Block {
  name: string
  line: number
  steps: ParsedStep[]
  outline: boolean
  /** Set on a Background: whose steps it holds. */
  background?: 'feature' | 'rule'
  examples: { header: string[]; rows: string[][] }[]
}

const STEP = /^(?:Given|When|Then|And|But|\*)\s+(.*\S)\s*$/
const HEADING =
  /^(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples|Scenarios):/

function cells(line: string): string[] {
  const out: string[] = []
  let cell = ''
  const inner = line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === '\\' && (inner[i + 1] === '|' || inner[i + 1] === '\\')) {
      cell += inner[++i]
    } else if (ch === '|') {
      out.push(cell.trim())
      cell = ''
    } else {
      cell += ch
    }
  }
  out.push(cell.trim())
  return out
}

/**
 * The scenarios in a feature file's text, for the audit: doc strings, data
 * tables, comments and tags are never steps; Scenario Outlines expand to one
 * scenario per Examples row; a Rule's Background follows the Feature's.
 */
export function parseFeature(text: string): ParsedScenario[] {
  const scenarios: ParsedScenario[] = []
  let featureBackground: ParsedStep[] = []
  let ruleBackground: ParsedStep[] = []
  let current: Block | undefined
  let inRule = false
  let inExamples = false
  let fence: string | undefined

  const finish = () => {
    if (!current) return
    const block = current
    current = undefined
    if (block.background === 'feature') featureBackground = block.steps
    if (block.background === 'rule') ruleBackground = block.steps
    if (block.background) return
    const prefix = [...featureBackground, ...ruleBackground]
    if (!block.outline) {
      scenarios.push({
        name: block.name,
        line: block.line,
        steps: [...prefix, ...block.steps],
      })
      return
    }
    for (const { header, rows } of block.examples) {
      for (const row of rows) {
        const fill = (s: string) =>
          s.replace(/<([^<>]*)>/g, (whole, key: string) => {
            const i = header.indexOf(key)
            return i >= 0 && i < row.length ? row[i] : whole
          })
        scenarios.push({
          name: fill(block.name),
          line: block.line,
          steps: [...prefix, ...block.steps].map((s) => ({ ...s, text: fill(s.text) })),
        })
      }
    }
  }

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (fence) {
      if (line.startsWith(fence)) fence = undefined
      return
    }
    if (line === '' || line.startsWith('#') || line.startsWith('@')) return
    if (line.startsWith('"""') || line.startsWith('```')) {
      fence = line.slice(0, 3)
      return
    }
    if (line.startsWith('|')) {
      if (inExamples && current) {
        const examples = current.examples[current.examples.length - 1]
        if (!examples.header.length && examples.rows.length === 0) examples.header = cells(line)
        else examples.rows.push(cells(line))
      }
      return
    }
    const heading = HEADING.exec(line)
    if (heading) {
      const name = line.slice(heading[0].length).trim()
      switch (heading[1]) {
        case 'Feature':
          finish()
          featureBackground = []
          ruleBackground = []
          inRule = false
          break
        case 'Rule':
          finish()
          ruleBackground = []
          inRule = true
          break
        case 'Background':
          finish()
          current = {
            name,
            line: i + 1,
            steps: [],
            outline: false,
            background: inRule ? 'rule' : 'feature',
            examples: [],
          }
          break
        case 'Examples':
        case 'Scenarios':
          if (current) {
            current.examples.push({ header: [], rows: [] })
            inExamples = true
          }
          break
        default:
          finish()
          current = {
            name,
            line: i + 1,
            steps: [],
            outline: heading[1] === 'Scenario Outline' || heading[1] === 'Scenario Template',
            examples: [],
          }
      }
      inExamples = heading[1] === 'Examples' || heading[1] === 'Scenarios'
      return
    }
    const step = STEP.exec(line)
    if (step && current) {
      inExamples = false
      current.steps.push({ text: step[1], line: i + 1 })
    }
  })
  finish()
  return scenarios
}
