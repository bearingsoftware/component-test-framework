type Mapping = Record<string, unknown>

export const FAULTS = ['status500', 'emptyBody', 'connectionReset'] as const
export type Fault = (typeof FAULTS)[number]

export interface FaultSpec {
  /** A stub selector: `METHOD path`, or `GRAPHQL <endpoint> <operationName>`. */
  stub: string
  fault: Fault
}

const URL_FORMS = ['url', 'urlPath', 'urlPathTemplate', 'urlPathPattern', 'urlPattern'] as const

export function isFault(value: string): value is Fault {
  return (FAULTS as readonly string[]).includes(value)
}

/** Parses `<stub selector>=<fault>`, the form of CTF_FAULT. Throws on anything else. */
export function parseFaultSpec(text: string): FaultSpec {
  const at = text.lastIndexOf('=')
  const stub = at < 0 ? '' : text.slice(0, at).trim()
  const fault = at < 0 ? '' : text.slice(at + 1).trim()
  const bad = (why: string) =>
    new Error(
      `CTF_FAULT=${JSON.stringify(text)} is not valid: ${why}. ` +
        `Use "<METHOD path>=<fault>" or "GRAPHQL <endpoint> <operationName>=<fault>", ` +
        `with a fault of ${FAULTS.join(', ')}.`,
    )
  if (!isFault(fault)) throw bad(`unknown fault "${fault}"`)
  const words = stub.split(/\s+/).filter(Boolean)
  if (words[0] === 'GRAPHQL') {
    if (words.length !== 3) throw bad('a GRAPHQL selector needs an endpoint and an operation name')
  } else if (words.length < 2 || !/^[A-Za-z]+$/.test(words[0])) {
    throw bad('a selector is an HTTP method and a path')
  }
  return { stub: normaliseKey(stub), fault }
}

function normaliseKey(key: string): string {
  const [first, ...rest] = key.split(/\s+/).filter(Boolean)
  return [first.toUpperCase(), ...rest].join(' ')
}

function graphqlOperation(mapping: Mapping): string | undefined {
  const find = (node: unknown): string | undefined => {
    if (Array.isArray(node)) return node.map(find).find((n) => n !== undefined)
    if (!node || typeof node !== 'object') return undefined
    const obj = node as Record<string, unknown>
    const m = obj.matchesJsonPath as Record<string, unknown> | undefined
    if (m && m.expression === '$.operationName' && typeof m.equalTo === 'string') return m.equalTo
    return Object.values(obj)
      .map(find)
      .find((n) => n !== undefined)
  }
  return find((mapping.request as Mapping | undefined)?.bodyPatterns)
}

/**
 * The key a stub is selected by: `METHOD <url form>` taking the first of url,
 * urlPath, urlPathTemplate, urlPathPattern, urlPattern as the request has it
 * (the method is ANY when the request has none), or, for a stub that matches
 * a GraphQL operation by name, `GRAPHQL <url form> <operationName>`.
 */
export function stubKey(mapping: Mapping): string {
  const request = (mapping.request ?? {}) as Record<string, unknown>
  const form = URL_FORMS.find((k) => typeof request[k] === 'string')
  const where = form ? (request[form] as string) : ''
  const operation = graphqlOperation(mapping)
  if (operation) return `GRAPHQL ${where} ${operation}`
  const method = typeof request.method === 'string' ? request.method.toUpperCase() : 'ANY'
  return `${method} ${where}`
}

/** A selector matches a key exactly, or as a prefix when it ends in `*`. */
export function selectorMatches(selector: string, key: string): boolean {
  const s = normaliseKey(selector)
  return s.endsWith('*') ? key.startsWith(s.slice(0, -1)) : s === key
}

export function applyFault(mapping: Mapping, fault: Fault): Mapping {
  const response = { ...((mapping.response ?? {}) as Mapping) }
  for (const k of ['jsonBody', 'body', 'base64Body', 'bodyFileName']) delete response[k]
  switch (fault) {
    case 'status500':
      response.status = 500
      response.jsonBody = { error: 'injected fault' }
      response.headers = { 'Content-Type': 'application/json' }
      break
    case 'emptyBody':
      response.body = ''
      break
    case 'connectionReset':
      response.fault = 'CONNECTION_RESET_BY_PEER'
      break
  }
  return { ...mapping, response }
}

/** The rewrite CTF_FAULT asks for, or undefined when it is unset or empty. */
export function faultFromEnv(env: NodeJS.ProcessEnv = process.env): FaultSpec | undefined {
  return env.CTF_FAULT ? parseFaultSpec(env.CTF_FAULT) : undefined
}
