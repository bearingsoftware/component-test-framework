import { describe, it, expect } from 'vitest'
import { requireApiBaseUrl } from './config'

describe('requireApiBaseUrl (COMPONENT-5)', () => {
  const config = { apiBaseUrl: '', wiremockUrl: '', fixturesDir: './fixtures' }

  it('returns the configured URL', () => {
    expect(requireApiBaseUrl({ ...config, apiBaseUrl: 'http://api.test' })).toBe('http://api.test')
  })

  // Before this, a missing URL produced requests to "undefined/path".
  it('throws a configuration error when no URL is set', () => {
    expect(() => requireApiBaseUrl(config)).toThrow(/apiBaseUrl is not configured/)
  })
})
