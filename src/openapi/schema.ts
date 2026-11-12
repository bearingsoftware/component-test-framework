import type { Located, RefResolver } from './spec'

/** One way a value doesn't fit its schema. */
export interface SchemaError {
  /** JSON pointer to the failing value in the checked value; empty for the root. */
  pointer: string
  message: string
}

type Json = Record<string, unknown>

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => deepEqual((a as Json)[k], (b as Json)[k]))
}

const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')

function check(
  value: unknown,
  loc: Located,
  pointer: string,
  resolve: RefResolver,
  active: Set<string>,
): SchemaError[] {
  const schema = loc.value as Json
  if (typeof schema.$ref === 'string') {
    // A $ref that leads back to itself without going deeper into the value would loop.
    const key = `${loc.file}|${schema.$ref}|${pointer}`
    if (active.has(key)) return []
    active.add(key)
    try {
      return check(value, resolve(schema.$ref, loc), pointer, resolve, active)
    } finally {
      active.delete(key)
    }
  }
  const sub = (s: unknown, v: unknown, p: string) =>
    s && typeof s === 'object' ? check(v, { ...loc, value: s as Json }, p, resolve, active) : []
  const errors: SchemaError[] = []
  const fail = (message: string, at = pointer) => errors.push({ pointer: at, message })

  if (value === null && schema.nullable === true) return errors

  if (schema.type !== undefined) {
    const types = [...(Array.isArray(schema.type) ? schema.type : [schema.type])] as string[]
    if (schema.nullable === true) types.push('null')
    const actual = typeOf(value)
    if (!types.some((t) => t === actual || (t === 'number' && actual === 'integer'))) {
      fail(`expected ${types.join(' or ')}, got ${actual}`)
      return errors
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    fail(`not one of the enum values ${JSON.stringify(schema.enum)}`)
  }
  if ('const' in schema && !deepEqual(schema.const, value)) {
    fail(`expected the constant ${JSON.stringify(schema.const)}`)
  }

  if (Array.isArray(schema.allOf)) {
    for (const s of schema.allOf) errors.push(...sub(s, value, pointer))
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((s) => sub(s, value, pointer).length === 0)) {
      fail('does not match any schema in anyOf')
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matching = schema.oneOf.filter((s) => sub(s, value, pointer).length === 0).length
    if (matching === 0) fail('does not match any schema in oneOf')
    else if (matching > 1) fail(`matches ${matching} schemas in oneOf, not one`)
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Json
    const properties = (schema.properties ?? {}) as Json
    for (const name of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!(name in object))
        fail(`missing required property '${name}'`, `${pointer}/${escape(name)}`)
    }
    for (const [name, child] of Object.entries(object)) {
      if (name in properties)
        errors.push(...sub(properties[name], child, `${pointer}/${escape(name)}`))
      else if (schema.additionalProperties === false) {
        fail(`additional property '${name}' is not allowed`, `${pointer}/${escape(name)}`)
      }
    }
  }
  if (Array.isArray(value) && schema.items && !Array.isArray(schema.items)) {
    value.forEach((item, i) => errors.push(...sub(schema.items, item, `${pointer}/${i}`)))
  }
  return errors
}

/**
 * Check a value against a JSON Schema, for the keywords that decide a
 * response's shape: `type` (also as a list, and with `nullable`), `required`,
 * `properties`, `additionalProperties: false`, `items`, `enum`, `const`,
 * `allOf`, `oneOf`, `anyOf` and `$ref`. Formats, patterns and numeric or
 * length limits aren't checked.
 */
export function validateSchema(
  value: unknown,
  schema: Located,
  resolve: RefResolver,
): SchemaError[] {
  return check(value, schema, '', resolve, new Set())
}
