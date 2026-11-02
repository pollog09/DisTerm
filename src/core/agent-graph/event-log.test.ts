import { afterEach, describe, expect, it } from 'vitest'
import { recordDelivery, resetAgentMessageTraceForTests } from '../agents/agent-message-trace'
import { AGENT_GRAPH_LABEL_MAX, deliveryClass, mergeAgentGraphEvents, type AgentGraphEvent } from '../../shared/agent-graph'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import { AgentGraphLog, agentEventToGraphEvent, agentGraphLog } from './event-log'

const delivery = (id: string, ts = 1): AgentGraphEvent => ({ kind: 'delivery', id, ts, from: 'a', to: 'b', outcome: 'delivered' })
const agentEvent = (over: Partial<NormalizedAgentEvent>): NormalizedAgentEvent =>
  ({ nodeId: 'n', agentId: 'claude', kind: 'state', ...over }) as NormalizedAgentEvent

describe('AgentGraphLog', () => {
  it('keeps the newest events and counts what it dropped', () => {
    const log = new AgentGraphLog(3)
    for (const id of ['1', '2', '3', '4', '5']) log.push(delivery(id))
    const s = log.snapshot()
    expect(s.events.map((e) => e.id)).toEqual(['3', '4', '5'])
    expect(s.dropped).toBe(2)
    expect(s.capacity).toBe(3)
  })

  it('a listener that throws does not stop the push or the next listener', () => {
    const log = new AgentGraphLog()
    const seen: string[] = []
    log.onEvent(() => {
      throw new Error('boom')
    })
    log.onEvent((e) => seen.push(e.id))
    expect(() => log.push(delivery('x'))).not.toThrow()
    expect(seen).toEqual(['x'])
    expect(log.snapshot().events).toHaveLength(1)
  })

  it('an unsubscribed listener hears nothing more', () => {
    const log = new AgentGraphLog()
    const seen: string[] = []
    const off = log.onEvent((e) => seen.push(e.id))
    off()
    log.push(delivery('x'))
    expect(seen).toEqual([])
  })
})

describe('agentEventToGraphEvent', () => {
  it('keeps subagent lifecycles and session resets, and nothing else', () => {
    expect(agentEventToGraphEvent(agentEvent({ kind: 'state', state: 'working' }), 5)).toBeNull()
    expect(agentEventToGraphEvent(agentEvent({ kind: 'subagent-start' }), 5)).toBeNull() // no id, no card
    expect(agentEventToGraphEvent(agentEvent({ kind: 'subagent-start', toolUseId: 't', subagentType: 'implementer' }), 5))
      .toMatchObject({ kind: 'subagent-start', nodeId: 'n', subId: 't', subagentType: 'implementer', ts: 5 })
    expect(agentEventToGraphEvent(agentEvent({ kind: 'subagent-end', toolUseId: 't' }), 5))
      .toMatchObject({ kind: 'subagent-end', subId: 't' })
    expect(agentEventToGraphEvent(agentEvent({ kind: 'session', sessionPhase: 'start' } as Partial<NormalizedAgentEvent>), 5))
      .toMatchObject({ kind: 'session-reset', nodeId: 'n' })
  })

  it('a label is one bounded line', () => {
    const e = agentEventToGraphEvent(agentEvent({ kind: 'subagent-start', toolUseId: 't', taskLabel: `a\nb${'x'.repeat(4000)}` }), 5)
    expect(e && e.kind === 'subagent-start' && e.label).toMatch(/^ab?x*/)
    const label = e && e.kind === 'subagent-start' ? e.label ?? '' : ''
    expect(label.length).toBeLessThanOrEqual(AGENT_GRAPH_LABEL_MAX)
    expect(label).not.toContain('\n')
  })
})

describe('deliveryClass', () => {
  it('never reads an unknown outcome as a success', () => {
    expect(deliveryClass('delivered')).toBe('delivered')
    expect(deliveryClass('deliveredToReplacedTarget')).toBe('delivered')
    expect(deliveryClass('queued')).toBe('queued')
    expect(deliveryClass('stalled')).toBe('failed')
    expect(deliveryClass('expired')).toBe('failed')
    expect(deliveryClass('notPermitted')).toBe('refused')
    expect(deliveryClass('rateLimited')).toBe('refused')
    expect(deliveryClass('somethingNew')).toBe('refused')
    expect(deliveryClass('__proto__')).toBe('refused')
  })
})

describe('mergeAgentGraphEvents', () => {
  it('counts one delivery once across its two copies, oldest first', () => {
    const merged = mergeAgentGraphEvents([delivery('b', 2), delivery('a', 1)], [delivery('b', 2), delivery('c', 3)])
    expect(merged.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('recordDelivery feeds the graph', () => {
  afterEach(() => {
    agentGraphLog.clear()
    resetAgentMessageTraceForTests()
  })

  it('a refusal is on the stream with its reason, and no body exists to leak', async () => {
    await recordDelivery(
      { sourceNodeId: 's', sourceTitle: 'S', targetNodeId: 't', outcome: 'notPermitted', reason: 'messaging-off', bodyChars: 12 },
      { appendBoardLog: async () => false, now: () => 42, traceId: () => 'trace-1' }
    )
    const [e] = agentGraphLog.snapshot().events
    expect(e).toEqual({ kind: 'delivery', id: 'trace-1', ts: 42, from: 's', to: 't', outcome: 'notPermitted', reason: 'messaging-off' })
  })
})
