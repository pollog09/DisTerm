// The agent graph's event stream: what the core observed about how sessions talk to each other.
//
// Everything here is DISPLAY data. Nothing on this wire authorizes anything, and a message BODY is
// never on it (`recordDelivery` does not keep one, and neither does anything downstream): an edge
// says that one session sent another something, and how that went, never what was said.

/** How long a subagent label may be on the wire. A label is the task description when the tool call
 *  has one, and otherwise the start of its prompt (`normalize.ts` falls back), so it can carry prompt
 *  text: it is a capped display line, exactly what the canvas's subagent card already shows. */
export const AGENT_GRAPH_LABEL_MAX = 160

/** The newest events the core keeps per process. Bounded because it is a process-lifetime buffer. */
export const AGENT_GRAPH_LOG_CAPACITY = 2000

/** How many board-log lines one snapshot reads back. */
export const AGENT_GRAPH_HISTORY_CAP = 1000

export interface AgentGraphDeliveryEvent {
  kind: 'delivery'
  /** The trace id: the board-log line and the in-memory entry for one delivery share it. */
  id: string
  ts: number
  from: string
  to: string
  /** The outcome kind as traced (`AgentMessageOutcomeKind`). A string, not the union: the durable
   *  copy comes from a hand-editable file and an older build's kinds stay readable. */
  outcome: string
  /** Why it was refused, when the trace recorded it (`notPermitted` only). */
  reason?: string
}

export interface AgentGraphSubagentStartEvent {
  kind: 'subagent-start'
  id: string
  ts: number
  /** The session that started it. */
  nodeId: string
  /** The child's id (`agent_id` natively, `tool_use_id` from the tool path). */
  subId: string
  subagentType?: string
  label?: string
  /** The tool-path card this native start replaced (core/claude-subagent-lifecycle.ts). */
  supersedes?: string
}

export interface AgentGraphSubagentEndEvent {
  kind: 'subagent-end'
  id: string
  ts: number
  nodeId: string
  subId: string
}

/** A running subagent streamed output. One entry per subagent, replaced as it moves on, so a healthy
 *  long run is not read as a dead one without filling the buffer. */
export interface AgentGraphSubagentActivityEvent {
  kind: 'subagent-activity'
  /** `activity:<subId>`: stable, so a newer one replaces the older wherever they merge. */
  id: string
  ts: number
  nodeId: string
  subId: string
}

/** The CLI went away. What it was running went with it, but this is not a new run: a resume continues
 *  the same work. */
export interface AgentGraphSessionEndEvent {
  kind: 'session-end'
  id: string
  ts: number
  nodeId: string
}

/** The session really started over (`/clear`, a fresh launch), so what follows is a new run, and
 *  whatever it had running is no longer its own. A compaction or a resume is not this. */
export interface AgentGraphSessionResetEvent {
  kind: 'session-reset'
  id: string
  ts: number
  nodeId: string
}

/** The user started a new turn in this session. Everything a turn's subagents do is one ship run, so
 *  this is what separates a second `/ship-change` from a rejection inside the first. */
export interface AgentGraphTurnStartEvent {
  kind: 'turn-start'
  id: string
  ts: number
  nodeId: string
}

export type AgentGraphEvent =
  | AgentGraphDeliveryEvent
  | AgentGraphTurnStartEvent
  | AgentGraphSubagentStartEvent
  | AgentGraphSubagentEndEvent
  | AgentGraphSessionResetEvent
  | AgentGraphSessionEndEvent
  | AgentGraphSubagentActivityEvent

export interface AgentGraphSnapshot {
  /** Oldest first. */
  events: AgentGraphEvent[]
  /** Events this process's buffer has dropped since it started, oldest first. */
  dropped: number
  /** The buffer's size, so the UI can name the bound it is reporting. */
  capacity: number
  /** Where message history comes from: the project's board log, or only this process's memory (a
   *  cwd-less canvas or a disconnected SSH project has no durable log). */
  history: 'board-log' | 'memory'
  /** The board log held more lines than one read returns, so older messages are not counted. */
  historyTruncated: boolean
}

/** An empty answer, for a session that cannot reach the channel (an offline relay tab, a refusal). */
export function emptyAgentGraphSnapshot(): AgentGraphSnapshot {
  return { events: [], dropped: 0, capacity: AGENT_GRAPH_LOG_CAPACITY, history: 'memory', historyTruncated: false }
}

export type DeliveryClass = 'delivered' | 'queued' | 'failed' | 'refused'

const DELIVERY_CLASS: Readonly<Record<string, DeliveryClass>> = Object.assign(Object.create(null), {
  delivered: 'delivered',
  deliveredToReplacedTarget: 'delivered',
  queued: 'queued',
  // The paste landed or sat in a queue and then nothing proved it was read: not a refusal, not a
  // delivery.
  stalled: 'failed',
  expired: 'failed'
})

/**
 * Which colour of edge one trace is. Every kind not named above is a refusal, including one this
 * build has never heard of: an unknown outcome must not read as a success.
 */
export function deliveryClass(outcome: string): DeliveryClass {
  return DELIVERY_CLASS[outcome] ?? 'refused'
}

/** Newest wins on an id, oldest first in the result. Exported for the core's snapshot and the
 *  renderer's live merge, so the two cannot count one delivery twice in different ways. */
export function mergeAgentGraphEvents(...lists: ReadonlyArray<readonly AgentGraphEvent[]>): AgentGraphEvent[] {
  const byId = new Map<string, AgentGraphEvent>()
  for (const list of lists) for (const e of list) byId.set(e.id, e)
  return [...byId.values()].sort((a, b) => a.ts - b.ts)
}
