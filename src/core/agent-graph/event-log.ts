import { randomUUID } from 'crypto'
import {
  AGENT_GRAPH_LABEL_MAX,
  AGENT_GRAPH_LOG_CAPACITY,
  type AgentGraphEvent
} from '../../shared/agent-graph'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import { oneLine } from '../../shared/one-line'

/**
 * What this process observed about how sessions talk to each other: deliveries (every outcome,
 * refusals included) and subagent lifecycles, normalized into one bounded stream.
 *
 * It sits beside the sources rather than replacing them. `recordDelivery` keeps its own ring and the
 * board log stays the durable record; subagents have no durable record at all, so a restart forgets
 * them, exactly as it forgets their canvas cards.
 *
 * BOUNDED, AND IT SAYS SO: past the capacity the oldest event goes and `dropped` counts it, so the
 * view can tell the user its counts have a horizon instead of presenting them as the whole history.
 */
export class AgentGraphLog {
  private events: AgentGraphEvent[] = []
  private droppedCount = 0
  private readonly listeners = new Set<(event: AgentGraphEvent) => void>()

  constructor(readonly capacity = AGENT_GRAPH_LOG_CAPACITY) {}

  push(event: AgentGraphEvent): void {
    this.events.push(event)
    if (this.events.length > this.capacity) {
      const over = this.events.length - this.capacity
      this.events.splice(0, over)
      this.droppedCount += over
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A display stream must not fail the delivery or the hook event that fed it.
      }
    }
  }

  /** The subagent half of the mirror's event path. Everything else on that path is state, which the
   *  renderer already holds (`agent:status`). */
  recordAgentEvent(event: NormalizedAgentEvent, now = Date.now()): void {
    const converted = agentEventToGraphEvent(event, now)
    if (converted) this.push(converted)
  }

  snapshot(): { events: AgentGraphEvent[]; dropped: number; capacity: number } {
    return { events: [...this.events], dropped: this.droppedCount, capacity: this.capacity }
  }

  onEvent(listener: (event: AgentGraphEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  clear(): void {
    this.events = []
    this.droppedCount = 0
  }
}

/** One mirror event as a graph event; null for everything the graph does not draw. */
export function agentEventToGraphEvent(event: NormalizedAgentEvent, now: number): AgentGraphEvent | null {
  const id = randomUUID()
  if (event.kind === 'session' && event.sessionPhase) {
    return { kind: 'session-reset', id, ts: now, nodeId: event.nodeId }
  }
  if (event.kind === 'state' && event.newTurn) return { kind: 'turn-start', id, ts: now, nodeId: event.nodeId }
  if (!event.toolUseId) return null
  if (event.kind === 'subagent-end') {
    return { kind: 'subagent-end', id, ts: now, nodeId: event.nodeId, subId: event.toolUseId }
  }
  if (event.kind !== 'subagent-start') return null
  const label = event.taskLabel ? oneLine(event.taskLabel).slice(0, AGENT_GRAPH_LABEL_MAX) : ''
  return {
    kind: 'subagent-start',
    id,
    ts: now,
    nodeId: event.nodeId,
    subId: event.toolUseId,
    ...(event.subagentType ? { subagentType: event.subagentType } : {}),
    ...(label ? { label } : {}),
    ...(event.supersedes ? { supersedes: event.supersedes } : {})
  }
}

/** The process's one log: every delivery and every mirror event of this core feeds it. */
export const agentGraphLog = new AgentGraphLog()
