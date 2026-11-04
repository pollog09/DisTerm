import { randomUUID } from 'crypto'
import {
  AGENT_GRAPH_LABEL_MAX,
  AGENT_GRAPH_LOG_CAPACITY,
  mergeAgentGraphEvents,
  type AgentGraphAccessEvent,
  type AgentGraphEvent
} from '../../shared/agent-graph'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import type { ToolAccess } from '../../shared/agents/tool-access'
import { oneLine } from '../../shared/one-line'

/** A tail chunk at most this often per subagent. Far inside the 20-minute staleness line. */
export const ACTIVITY_COALESCE_MS = 30_000
/** A killed child fires no end, so this is what bounds the open map. */
const MAX_OPEN = 512
/** Distinct (session, subagent, skill or server) rows kept. The oldest goes first, and is counted as dropped. */
export const MAX_ACCESS_KEYS = 1024

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
  /** One row per access key, least recently called first, which is what bounds it. Apart from the
   *  ring: a swarm of subagents must not push deliveries and subagent starts out of it. */
  private readonly accessRows = new Map<string, AgentGraphAccessEvent>()

  constructor(readonly capacity = AGENT_GRAPH_LOG_CAPACITY) {}

  push(event: AgentGraphEvent): void {
    this.events.push(event)
    if (this.events.length > this.capacity) {
      const over = this.events.length - this.capacity
      this.events.splice(0, over)
      this.droppedCount += over
    }
    this.notify(event)
  }

  private notify(event: AgentGraphEvent): void {
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

  /**
   * A session, or one of its subagents, used a skill or an MCP server. NOT a mirror event: the
   * mirror's consumers (state, Eco, messaging, the renderer) must not hear of it. It is display data
   * for this log only, fed by the hook server after the pane-origin gate.
   *
   * One replaced row per key with a running count, pushed every time: each push is what the view
   * animates as one dot. The count is since this process started, and the key map is bounded; the
   * oldest key's row goes with it and counts as dropped, so the view says its counts have a horizon.
   */
  recordAccess(nodeId: string, access: ToolAccess, now = Date.now()): void {
    // A typed `/name` is its own row: the person typing it and the model calling it are different
    // facts, and the view only draws the typed kind when the machine says it is a skill or command.
    // `|` is outside every name alphabet, so a skill called `x:typed` cannot land on the typed `/x`.
    const id = `access:${nodeId}:${access.subId ?? ''}:${access.target}:${access.name}${access.typed ? '|typed' : ''}`
    const count = (this.accessRows.get(id)?.count ?? 0) + 1
    this.accessRows.delete(id)
    const row: AgentGraphAccessEvent = {
      kind: 'access',
      id,
      ts: now,
      nodeId,
      ...(access.subId ? { subId: access.subId } : {}),
      ...(access.subType ? { subType: access.subType } : {}),
      target: access.target,
      name: access.name,
      ...(access.tool ? { tool: access.tool } : {}),
      ...(access.typed ? { typed: true as const } : {}),
      count
    }
    this.accessRows.set(id, row)
    while (this.accessRows.size > MAX_ACCESS_KEYS) {
      this.accessRows.delete(this.accessRows.keys().next().value!)
      this.droppedCount++
    }
    this.notify(row)
  }

  private forget(subId: string): void {
    this.open.delete(subId)
    this.activityAt.delete(subId)
  }

  snapshot(): { events: AgentGraphEvent[]; dropped: number; capacity: number } {
    return { events: mergeAgentGraphEvents(this.events, [...this.accessRows.values()]), dropped: this.droppedCount, capacity: this.capacity }
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
    this.accessRows.clear()
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
