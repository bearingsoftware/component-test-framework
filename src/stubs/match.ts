/** What a rule or a filter selects. Every field given must hold. */
export interface CaptureMatch {
  path?: string
  method?: string
  query?: Record<string, string>
  header?: Record<string, string>
  bodyIncludes?: string
}

/** One request or message a capture server received. */
export interface CapturedRequest {
  at: Date
  method?: string
  path?: string
  query?: Record<string, string>
  headers?: Record<string, string>
  body: Buffer
  text: string
  json?: unknown
}

/** Whether `request` satisfies `match`. Fields a tcp or udp message lacks never match. */
export function matches(request: CapturedRequest, match: CaptureMatch = {}): boolean {
  if (match.path !== undefined && request.path !== match.path) return false
  if (match.method !== undefined && request.method !== match.method.toUpperCase()) return false
  for (const [k, v] of Object.entries(match.query ?? {})) {
    if (request.query?.[k] !== v) return false
  }
  for (const [k, v] of Object.entries(match.header ?? {})) {
    if (request.headers?.[k.toLowerCase()] !== v) return false
  }
  if (match.bodyIncludes !== undefined && !request.text.includes(match.bodyIncludes)) return false
  return true
}

/**
 * Parse the compact form the steps use: terms separated by `;`, each
 * `path=/x`, `method=POST`, `query.NAME=value`, `header.NAME=value` or
 * `body~text`. `body~` takes the rest of the string, so it goes last and may
 * contain `;`. An empty string matches everything.
 */
export function parseMatch(spec: string): CaptureMatch {
  const match: CaptureMatch = {}
  let rest = spec
  while (rest.trim() !== '') {
    rest = rest.trimStart()
    if (rest.startsWith('body~')) {
      match.bodyIncludes = rest.slice('body~'.length)
      break
    }
    const semi = rest.indexOf(';')
    const term = (semi < 0 ? rest : rest.slice(0, semi)).trim()
    rest = semi < 0 ? '' : rest.slice(semi + 1)
    if (term === '') continue
    const eq = term.indexOf('=')
    const key = eq < 0 ? term : term.slice(0, eq)
    const value = eq < 0 ? '' : term.slice(eq + 1)
    if (eq < 0)
      throw new Error(`bad match term "${term}" in "${spec}": expected key=value or body~text`)
    if (key === 'path') match.path = value
    else if (key === 'method') match.method = value
    else if (key.startsWith('query.') && key.length > 'query.'.length) {
      ;(match.query ??= {})[key.slice('query.'.length)] = value
    } else if (key.startsWith('header.') && key.length > 'header.'.length) {
      ;(match.header ??= {})[key.slice('header.'.length).toLowerCase()] = value
    } else {
      throw new Error(
        `unknown match term "${term}" in "${spec}": use path=, method=, query.NAME=, header.NAME= or body~`,
      )
    }
  }
  return match
}
