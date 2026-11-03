import { describe, it, expect, vi } from 'vitest'
import { SHIP_LEASE_MS, SHIP_LEASE_RENEW_MS } from '../../shared/ship-config'
import { buildAgentApi } from './ws-bridge'
import { IPC } from '../../shared/ipc'

function fakeClient() {
  const subs: Array<{ channel: string }> = []
  const requests: Array<{ channel: string; arg: unknown }> = []
  return {
    subs,
    requests,
    subscribe: (channel: string, _fn: (...a: unknown[]) => void) => {
      subs.push({ channel })
      return () => {}
    },
    request: (channel: string, arg?: unknown) => {
      requests.push({ channel, arg })
      return Promise.resolve()
    }
  }
}

describe('buildAgentApi agentGraph', () => {
  it('holds a renewed lease on ship config while subscribed, and releases it', () => {
    vi.useFakeTimers()
    try {
      const casts: Array<{ channel: string; args: unknown[] }> = []
      const unsub = vi.fn()
      const client = { subscribe: vi.fn(() => unsub), request: vi.fn(), cast: (channel: string, ...args: unknown[]) => casts.push({ channel, args }) }
      const off = buildAgentApi(client as never).agentGraph.onShipConfigChanged('P', () => {})
      expect(client.subscribe).toHaveBeenCalledWith(IPC.shipConfigChanged('P'), expect.any(Function))
      expect(casts).toHaveLength(1)
      const [first] = casts
      expect(first.channel).toBe(IPC.shipConfigSubscribe)
      expect(first.args[0]).toBe('P')
      const leaseId = first.args[1]
      expect(typeof leaseId).toBe('string')

      vi.advanceTimersByTime(SHIP_LEASE_RENEW_MS)
      expect(casts).toHaveLength(2)
      expect(casts[1]).toEqual({ channel: IPC.shipConfigSubscribe, args: ['P', leaseId] })
      expect(SHIP_LEASE_RENEW_MS * 2).toBeLessThan(SHIP_LEASE_MS) // a throttled renewal does not lapse it

      off()
      expect(unsub).toHaveBeenCalled()
      expect(casts[2]).toEqual({ channel: IPC.shipConfigUnsubscribe, args: ['P', leaseId] })
      vi.advanceTimersByTime(SHIP_LEASE_RENEW_MS * 3)
      expect(casts).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('buildAgentApi', () => {
  it('onAgentStatus / onSubagentActivity subscribe to the right channels and return an unsub', () => {
    const c = fakeClient()
    const api = buildAgentApi(c as never)
    const un1 = api.onAgentStatus(() => {})
    const un2 = api.onSubagentActivity(() => {})
    expect(c.subs).toEqual([
      { channel: IPC.agentStatus },
      { channel: IPC.agentSubagentActivity }
    ])
    expect(typeof un1).toBe('function')
    expect(typeof un2).toBe('function')
  })

  it('ackDone fires a fire-and-forget request on the ack-done channel', () => {
    const c = fakeClient()
    const api = buildAgentApi(c as never)
    api.ackDone('nt-x')
    expect(c.requests).toEqual([{ channel: IPC.agentAckDone, arg: 'nt-x' }])
  })
})
