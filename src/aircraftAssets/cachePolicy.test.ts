import { describe, expect, test } from 'bun:test'

import { parseAircraftCacheMode } from './cachePolicy'

describe('aircraft cache policy', () => {
  test('parses valid cache modes', () => {
    expect(parseAircraftCacheMode('normal')).toBe('normal')
    expect(parseAircraftCacheMode('no-store')).toBe('no-store')
    expect(parseAircraftCacheMode('no-cache')).toBe('no-cache')
    expect(parseAircraftCacheMode('immutable')).toBe('immutable')
  })

  test('invalid mode falls back to normal', () => {
    expect(parseAircraftCacheMode('1')).toBe('normal')
    expect(parseAircraftCacheMode('')).toBe('normal')
    expect(parseAircraftCacheMode(undefined)).toBe('normal')
  })
})
