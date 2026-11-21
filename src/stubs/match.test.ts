import { describe, it, expect } from 'vitest'
import { matches, parseMatch } from './match'
import type { CapturedRequest } from './match'

const req = (over: Partial<CapturedRequest> = {}): CapturedRequest => ({
  at: new Date(),
  method: 'POST',
  path: '/a',
  query: { k: 'v' },
  headers: { 'x-key': 'abc' },
  body: Buffer.from('hello; world'),
  text: 'hello; world',
  ...over,
})

describe('parseMatch', () => {
  it.each([
    ['', {}],
    ['path=/a', { path: '/a' }],
    ['path=/a; method=POST', { path: '/a', method: 'POST' }],
    ['query.k=v;header.X-Key=abc', { query: { k: 'v' }, header: { 'x-key': 'abc' } }],
    ['path=/a; body~hello; world', { path: '/a', bodyIncludes: 'hello; world' }],
  ])('parses %j', (spec, want) => {
    expect(parseMatch(spec)).toEqual(want)
  })

  it.each(['nonsense', 'color=red', 'query.=x'])('rejects %j', (spec) => {
    expect(() => parseMatch(spec)).toThrow(/match term/)
  })
})

describe('matches', () => {
  it('requires every given field', () => {
    expect(
      matches(req(), parseMatch('path=/a;method=post;query.k=v;header.x-key=abc;body~world')),
    ).toBe(true)
    expect(matches(req(), parseMatch('path=/b'))).toBe(false)
    expect(matches(req(), parseMatch('query.k=other'))).toBe(false)
    expect(matches(req(), parseMatch('header.x-key=nope'))).toBe(false)
    expect(matches(req(), parseMatch('body~absent'))).toBe(false)
  })

  it('never matches http fields on a raw message', () => {
    const raw = req({ method: undefined, path: undefined, query: undefined, headers: undefined })
    expect(matches(raw, { path: '/a' })).toBe(false)
    expect(matches(raw, { bodyIncludes: 'hello' })).toBe(true)
    expect(matches(raw)).toBe(true)
  })
})
