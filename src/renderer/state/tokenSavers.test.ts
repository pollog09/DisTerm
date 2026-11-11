// @vitest-environment jsdom
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

import { afterEach, vi } from 'vitest'
import { HANDOFF_READY_EVENT, settleHandoffs, useTokenSavers } from './tokenSavers'
import type { TokenSaversSnapshot } from '@shared/token-savers'

describe('settleHandoffs', () => {
  afterEach(() => useTokenSavers.setState({ pendingHandoff: {} }))
  const snapWith = (handoffs: TokenSaversSnapshot['handoffs']) => ({ handoffs }) as TokenSaversSnapshot
  it('opens a node once the requested handoff file arrives, and only once', () => {
    const fired = vi.fn()
    window.addEventListener(HANDOFF_READY_EVENT, fired)
    useTokenSavers.setState({ pendingHandoff: { n1: 100_000 } })
    settleHandoffs(snapWith({ n1: { file: '/f-old.md', at: 10_000 } }), 101_000)
    expect(fired).not.toHaveBeenCalled()
    settleHandoffs(snapWith({ n1: { file: '/f.md', at: 100_500 } }), 102_000)
    settleHandoffs(snapWith({ n1: { file: '/f.md', at: 100_500 } }), 102_100)
    expect(fired).toHaveBeenCalledTimes(1)
    expect((fired.mock.calls[0][0] as CustomEvent).detail).toEqual({ nodeId: 'n1', file: '/f.md' })
    window.removeEventListener(HANDOFF_READY_EVENT, fired)
  })
  it('gives up on a request after five minutes', () => {
    useTokenSavers.setState({ pendingHandoff: { n1: 0 } })
    settleHandoffs(snapWith({}), 6 * 60_000)
    expect(useTokenSavers.getState().pendingHandoff).toEqual({})
  })
})
