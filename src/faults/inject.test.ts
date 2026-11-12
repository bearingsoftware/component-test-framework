import { describe, it, expect } from 'vitest'
import { applyFault, faultFromEnv, parseFaultSpec, selectorMatches, stubKey } from './inject'
import { graphql } from '../mocking/graphql'

describe('parseFaultSpec', () => {
  it.each([
    ['GET /pricing/prices/*=status500', { stub: 'GET /pricing/prices/*', fault: 'status500' }],
    ['get /a=emptyBody', { stub: 'GET /a', fault: 'emptyBody' }],
    ['POST /a?x=1=connectionReset', { stub: 'POST /a?x=1', fault: 'connectionReset' }],
    [
      'GRAPHQL /v1/graphql/ account=status500',
      { stub: 'GRAPHQL /v1/graphql/ account', fault: 'status500' },
    ],
  ])('reads %s', (text, expected) => {
    expect(parseFaultSpec(text)).toEqual(expected)
  })

  it.each([
    ['GET /a', 'unknown fault'],
    ['GET /a=slow', 'unknown fault "slow"'],
    ['/a=status500', 'a selector is an HTTP method and a path'],
    ['=status500', 'a selector is an HTTP method and a path'],
    ['GRAPHQL /g=status500', 'needs an endpoint and an operation name'],
  ])('rejects %s', (text, why) => {
    expect(() => parseFaultSpec(text)).toThrow(why)
  })
})

describe('faultFromEnv', () => {
  it('is undefined when unset or empty', () => {
    expect(faultFromEnv({})).toBeUndefined()
    expect(faultFromEnv({ CTF_FAULT: '' })).toBeUndefined()
  })
  it('throws clearly on a bad value', () => {
    expect(() => faultFromEnv({ CTF_FAULT: 'nonsense' })).toThrow(
      /CTF_FAULT="nonsense" is not valid/,
    )
  })
})

describe('stubKey', () => {
  it.each([
    [{ request: { method: 'get', url: '/a?b=1' } }, 'GET /a?b=1'],
    [{ request: { method: 'GET', urlPath: '/a' } }, 'GET /a'],
    [{ request: { method: 'GET', urlPathTemplate: '/a/{id}' } }, 'GET /a/{id}'],
    [{ request: { method: 'GET', urlPathPattern: '/a/.*' } }, 'GET /a/.*'],
    [{ request: { urlPath: '/a' } }, 'ANY /a'],
  ])('keys %j as %s', (mapping, key) => {
    expect(stubKey(mapping)).toBe(key)
  })

  it('keys a GraphQL operation stub by endpoint and operation name', () => {
    const gql = graphql.endpoint('/v1/graphql/')
    expect(stubKey(gql.query('account').willReturnData({}).build())).toBe(
      'GRAPHQL /v1/graphql/ account',
    )
    expect(stubKey(gql.mutation('obtainKrakenToken').willReturnData({}).build())).toBe(
      'GRAPHQL /v1/graphql/ obtainKrakenToken',
    )
  })
})

describe('selectorMatches', () => {
  it('matches exactly, or by prefix with a trailing *', () => {
    expect(selectorMatches('GET /a', 'GET /a')).toBe(true)
    expect(selectorMatches('GET /a', 'GET /a/b')).toBe(false)
    expect(selectorMatches('GET /a/*', 'GET /a/b')).toBe(true)
    expect(selectorMatches('get /a/*', 'GET /a/b')).toBe(true)
    expect(selectorMatches('POST /a/*', 'GET /a/b')).toBe(false)
    expect(selectorMatches('GRAPHQL /g account', 'GRAPHQL /g account')).toBe(true)
    expect(selectorMatches('GRAPHQL /g account', 'GRAPHQL /g accounts')).toBe(false)
  })
})

describe('applyFault', () => {
  const mapping = {
    request: { method: 'GET', urlPath: '/a' },
    response: { status: 201, jsonBody: { price: 1 }, headers: { X: 'y' } },
  }
  it('status500 swaps in a 500 with an error body', () => {
    expect(applyFault(mapping, 'status500').response).toEqual({
      status: 500,
      jsonBody: { error: 'injected fault' },
      headers: { 'Content-Type': 'application/json' },
    })
  })
  it('emptyBody keeps the status and headers, with no body', () => {
    expect(applyFault(mapping, 'emptyBody').response).toEqual({
      status: 201,
      body: '',
      headers: { X: 'y' },
    })
  })
  it('connectionReset sets the WireMock fault', () => {
    expect(applyFault(mapping, 'connectionReset').response).toMatchObject({
      fault: 'CONNECTION_RESET_BY_PEER',
    })
  })
  it('does not change the mapping it is given', () => {
    const before = JSON.stringify(mapping)
    applyFault(mapping, 'status500')
    expect(JSON.stringify(mapping)).toBe(before)
  })
})
