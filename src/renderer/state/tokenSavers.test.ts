import { describe, expect, it } from 'vitest'
import { cacheState, formatClock } from './tokenSavers'

describe('cacheState', () => {
  const at = 1_000_000
  it('is warm, then cooling in the last minute, then cold', () => {
    expect(cacheState(at, 300_000, at + 10_000)).toEqual({ kind: 'warm', leftMs: 290_000 })
    expect(cacheState(at, 300_000, at + 250_000).kind).toBe('cooling')
    expect(cacheState(at, 300_000, at + 300_000)).toEqual({ kind: 'cold', leftMs: 0 })
  })
})

describe('formatClock', () => {
  it('shows m:ss, and h:mm:ss past an hour', () => {
    expect(formatClock(252_000)).toBe('4:12')
    expect(formatClock(500)).toBe('0:01')
    expect(formatClock(3_600_000)).toBe('1:00:00')
  })
})
