import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { validateSchema } from './schema'
import { createRefResolver } from './spec'

const resolve = createRefResolver()

function errors(value: unknown, schema: Record<string, unknown>, root = schema) {
  return validateSchema(
    value,
    { value: schema, file: path.join(__dirname, 'x.yaml'), root },
    resolve,
  )
}

describe('validateSchema', () => {
  it.each([
    ['string', 'a', 1, 'expected string, got integer'],
    ['integer', 1, 1.5, 'expected integer, got number'],
    ['number', 1.5, 'x', 'expected number, got string'],
    ['boolean', true, 'true', 'expected boolean, got string'],
    ['array', [], {}, 'expected array, got object'],
    ['object', {}, [], 'expected object, got array'],
    ['null', null, 0, 'expected null, got integer'],
  ])('type %s', (type, good, bad, message) => {
    expect(errors(good, { type })).toEqual([])
    expect(errors(bad, { type })).toEqual([{ pointer: '', message }])
  })

  it('takes a number where an integer is a kind of number', () => {
    expect(errors(2, { type: 'number' })).toEqual([])
  })

  it('takes an array of types, and nullable', () => {
    const schema = { type: ['string', 'integer'] }
    expect(errors('a', schema)).toEqual([])
    expect(errors(1, schema)).toEqual([])
    expect(errors(true, schema)).toEqual([
      { pointer: '', message: 'expected string or integer, got boolean' },
    ])
    expect(errors(null, { type: 'string', nullable: true })).toEqual([])
    expect(errors(null, { type: 'string' })).toHaveLength(1)
    // The schema's own list isn't changed by checking.
    expect(errors(null, { type: ['string'], nullable: true })).toEqual([])
    expect(schema.type).toEqual(['string', 'integer'])
  })

  it('checks required, properties and additionalProperties: false, with pointers', () => {
    const schema = {
      type: 'object',
      required: ['id', 'name'],
      additionalProperties: false,
      properties: { id: { type: 'integer' }, name: { type: 'string' } },
    }
    expect(errors({ id: 1, name: 'a' }, schema)).toEqual([])
    expect(errors({ id: '1', extra: 1 }, schema)).toEqual([
      { pointer: '/name', message: "missing required property 'name'" },
      { pointer: '/id', message: 'expected integer, got string' },
      { pointer: '/extra', message: "additional property 'extra' is not allowed" },
    ])
    // Extra properties are fine unless the schema forbids them.
    expect(errors({ a: 1, b: 2 }, { type: 'object' })).toEqual([])
  })

  it('checks additionalProperties as a schema, for the properties not listed', () => {
    const schema = {
      properties: { id: { type: 'integer' } },
      additionalProperties: { type: 'string' },
    }
    expect(errors({ id: 1, a: 'x' }, schema)).toEqual([])
    expect(errors({ id: 1, a: 2 }, schema)).toEqual([
      { pointer: '/a', message: 'expected string, got integer' },
    ])
    // `true` and an absent keyword allow anything.
    expect(errors({ a: 2 }, { additionalProperties: true })).toEqual([])
  })

  it('escapes ~ and / in pointers', () => {
    expect(errors({ 'a/b~c': 1 }, { properties: { 'a/b~c': { type: 'string' } } })).toEqual([
      { pointer: '/a~1b~0c', message: 'expected string, got integer' },
    ])
  })

  it('checks items, with the index in the pointer', () => {
    expect(errors([1, 2], { type: 'array', items: { type: 'integer' } })).toEqual([])
    expect(errors([1, 'x', 3, 'y'], { type: 'array', items: { type: 'integer' } })).toEqual([
      { pointer: '/1', message: 'expected integer, got string' },
      { pointer: '/3', message: 'expected integer, got string' },
    ])
  })

  it('checks enum and const, by value', () => {
    expect(errors('a', { enum: ['a', 'b'] })).toEqual([])
    expect(errors({ k: [1] }, { enum: [{ k: [1] }] })).toEqual([])
    expect(errors('c', { enum: ['a', 'b'] })).toEqual([
      { pointer: '', message: 'not one of the enum values ["a","b"]' },
    ])
    expect(errors({ a: 1 }, { const: { a: 1 } })).toEqual([])
    expect(errors({ a: 2 }, { const: { a: 1 } })).toEqual([
      { pointer: '', message: 'expected the constant {"a":1}' },
    ])
  })

  it('checks allOf, anyOf and oneOf', () => {
    const all = { allOf: [{ required: ['a'] }, { properties: { b: { type: 'string' } } }] }
    expect(errors({ a: 1, b: 'x' }, all)).toEqual([])
    expect(errors({ b: 1 }, all)).toEqual([
      { pointer: '/a', message: "missing required property 'a'" },
      { pointer: '/b', message: 'expected string, got integer' },
    ])

    const any = { anyOf: [{ type: 'string' }, { type: 'integer' }] }
    expect(errors(1, any)).toEqual([])
    expect(errors(true, any)).toEqual([
      { pointer: '', message: 'does not match any schema in anyOf' },
    ])

    const one = { oneOf: [{ type: 'number' }, { type: 'integer' }, { type: 'string' }] }
    expect(errors('a', one)).toEqual([])
    expect(errors(true, one)).toEqual([
      { pointer: '', message: 'does not match any schema in oneOf' },
    ])
    expect(errors(1, one)).toEqual([
      { pointer: '', message: 'matches 2 schemas in oneOf, not one' },
    ])
  })

  it('follows $ref in the same document and in another file', () => {
    const root = { defs: { Id: { type: 'integer' } } }
    const schema = { properties: { id: { $ref: '#/defs/Id' } } }
    expect(errors({ id: 1 }, schema, root)).toEqual([])
    expect(errors({ id: 'x' }, schema, root)).toEqual([
      { pointer: '/id', message: 'expected integer, got string' },
    ])

    const across = { $ref: 'schemas.yaml#/Pet' }
    const here = path.join(__dirname, '__fixtures__', 'stubs', 'pets.yaml')
    const located = (value: unknown) =>
      validateSchema(value, { value: across, file: here, root: {} }, resolve)
    expect(located({ id: 1, name: 'a' })).toEqual([])
    expect(located({ id: 1, name: 'a', extra: true })).toEqual([
      { pointer: '/extra', message: "additional property 'extra' is not allowed" },
    ])
  })

  it('follows a recursive $ref as deep as the value goes, and stops there', () => {
    const root = {
      Node: {
        type: 'object',
        required: ['value'],
        properties: {
          value: { type: 'string' },
          children: { type: 'array', items: { $ref: '#/Node' } },
        },
      },
    }
    const schema = { $ref: '#/Node' }
    const tree = { value: 'a', children: [{ value: 'b', children: [{ value: 'c' }] }] }
    expect(errors(tree, schema, root)).toEqual([])
    expect(
      errors({ value: 'a', children: [{ value: 'b', children: [{}] }] }, schema, root),
    ).toEqual([
      { pointer: '/children/0/children/0/value', message: "missing required property 'value'" },
    ])
  })

  it("doesn't loop on a $ref that leads back to itself without going deeper", () => {
    const root = { A: { allOf: [{ $ref: '#/A' }, { type: 'string' }] } }
    expect(errors('x', { $ref: '#/A' }, root)).toEqual([])
    expect(errors(1, { $ref: '#/A' }, root)).toEqual([
      { pointer: '', message: 'expected string, got integer' },
    ])
  })
})
