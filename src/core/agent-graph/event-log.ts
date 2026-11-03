import { randomUUID } from 'crypto'
import {
  AGENT_GRAPH_LABEL_MAX,
  AGENT_GRAPH_LOG_CAPACITY,
  type AgentGraphEvent
} from '../../shared/agent-graph'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import { oneLine } from '../../shared/one-line'

/** A tail chunk at most this often per subagent. Far inside the 20-minute staleness line. */
export const ACTIVITY_COALESCE_MS = 30_000
/** A killed child fires no end, so this is what bounds the open map. */
const MAX_OPEN = 512

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
  /** Open subagents, id to parent, so a tail chunk (which knows only the id) can name its session. */
  private readonly open = new Map<string, string>()
  private readonly activityAt = new Map<string, number>()

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
    if (!converted) return
    if (converted.kind === 'subagent-start') {
      if (converted.supersedes) this.forget(converted.supersedes)
      this.open.set(converted.subId, converted.nodeId)
      while (this.open.size > MAX_OPEN) this.forget(this.open.keys().next().value!)
    } else if (converted.kind === 'subagent-end') {
      this.forget(converted.subId)
    } else if (converted.kind === 'session-reset' || converted.kind === 'session-end') {
      for (const [subId, nodeId] of this.open) if (nodeId === converted.nodeId) this.forget(subId)
    }
    this.push(converted)
  }

  /**
   * A subagent streamed output. Without this a healthy run past the staleness line reads as dead,
   * disagreeing with the canvas card that is watching the same stream. Tails chunk constantly, so it
   * is coalesced, and one entry stands for one subagent however long it runs.
   */
  recordActivity(subId: string, now = Date.now()): void {
    const nodeId = this.open.get(subId)
    if (!nodeId) return
    if (now - (this.activityAt.get(subId) ?? 0) < ACTIVITY_COALESCE_MS) return
    this.activityAt.set(subId, now)
    const id = `activity:${subId}`
    this.events = this.events.filter((e) => e.id !== id)
    this.push({ kind: 'subagent-activity', id, ts: now, nodeId, subId })
  }

  private forget(subId: string): void {
    this.open.delete(subId)
    this.activityAt.delete(subId)
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
    this.open.clear()
    this.activityAt.clear()
    this.droppedCount = 0
  }
}

/** `SessionStart` sources that continue the same work rather than starting over. */
const CONTINUES_SESSION: ReadonlySet<string> = new Set(['compact', 'resume'])

/** One mirror event as a graph event; null for everything the graph does not draw. */
export function agentEventToGraphEvent(event: NormalizedAgentEvent, now: number): AgentGraphEvent | null {
  const id = randomUUID()
  if (event.kind === 'session' && event.sessionPhase === 'end') {
    return { kind: 'session-end', id, ts: now, nodeId: event.nodeId }
  }
  if (event.kind === 'session' && event.sessionPhase === 'start') {
    if (event.sessionSource && CONTINUES_SESSION.has(event.sessionSource)) return null
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
