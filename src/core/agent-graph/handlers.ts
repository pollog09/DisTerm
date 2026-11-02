import { BoardLogStore } from '../board-log'
import type { BoardLogRouter } from '../board-log-handlers'
import type { CorePlatform } from '../platform'
import {
  AGENT_GRAPH_HISTORY_CAP,
  mergeAgentGraphEvents,
  type AgentGraphDeliveryEvent,
  type AgentGraphSnapshot
} from '../../shared/agent-graph'
import { IPC } from '../../shared/ipc'
import { oneLine } from '../../shared/one-line'
import { isSafeNodeId } from '../../shared/safe-id'
import type { BoardLogEntry } from '../../shared/types'
import { agentGraphLog, type AgentGraphLog } from './event-log'

const OUTCOME_MAX = 64
const REASON_MAX = 200

/**
 * The durable half of message history: `agent-message` lines of a project's board log.
 *
 * `.nodeterm/board-log.jsonl` sits in the project folder and anyone who can write there can write a
 * line, so nothing is taken on faith: a line missing a field or naming an unsafe node id is skipped.
 * What survives is drawn, and that is all it can do; a forged line adds an edge to a picture, it
 * proves nothing to anything.
 */
export function boardLogToDeliveries(entries: readonly BoardLogEntry[]): AgentGraphDeliveryEvent[] {
  const out: AgentGraphDeliveryEvent[] = []
  for (const entry of entries) {
    const event = entry?.event
    if (entry?.kind !== 'event' || event?.type !== 'agent-message') continue
    const { from, to, title, reason } = event
    if (typeof entry.id !== 'string' || !entry.id || typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)) continue
    if (typeof from !== 'string' || typeof to !== 'string' || !isSafeNodeId(from) || !isSafeNodeId(to)) continue
    if (typeof title !== 'string' || !title) continue
    const cleanReason = typeof reason === 'string' ? oneLine(reason).slice(0, REASON_MAX) : ''
    out.push({
      kind: 'delivery',
      id: entry.id,
      ts: entry.ts,
      from,
      to,
      outcome: oneLine(title).slice(0, OUTCOME_MAX),
      ...(cleanReason ? { reason: cleanReason } : {})
    })
  }
  return out
}

/** One project's graph history: its board log (when it has one) under this process's live buffer.
 *  The buffer spans every project of this core; the renderer keeps what touches the project's nodes
 *  and a relay peer's response is narrowed to its shared nodes (`narrowResponseForRole`). */
export async function readAgentGraphSnapshot(
  projectId: unknown,
  router: BoardLogRouter,
  log: AgentGraphLog = agentGraphLog,
  localStore = new BoardLogStore({})
): Promise<AgentGraphSnapshot> {
  const live = log.snapshot()
  let durable: BoardLogEntry[] | null = null
  if (typeof projectId === 'string' && projectId) {
    try {
      const route = router.route(projectId)
      if (route.kind === 'local') durable = await localStore.read(route.cwd, { cap: AGENT_GRAPH_HISTORY_CAP })
      else if (route.kind === 'remote') {
        durable = await new BoardLogStore({ remote: route.exec }).read(route.remoteCwd, { cap: AGENT_GRAPH_HISTORY_CAP })
      }
    } catch {
      durable = null // an unreachable log is the same fact as no log: memory only
    }
  }
  return {
    events: mergeAgentGraphEvents(durable ? boardLogToDeliveries(durable) : [], live.events),
    dropped: live.dropped,
    capacity: live.capacity,
    history: durable ? 'board-log' : 'memory',
    historyTruncated: !!durable && durable.length >= AGENT_GRAPH_HISTORY_CAP
  }
}

/** Registered once per shell, through `CorePlatform`, so desktop and Server Edition cannot drift.
 *  The router is the board log's own: the graph's history lives wherever that log lives. */
export function registerAgentGraphHandlers(
  platform: CorePlatform,
  router: BoardLogRouter,
  log: AgentGraphLog = agentGraphLog
): () => void {
  platform.handle(IPC.agentGraphSnapshot, (projectId: unknown) => readAgentGraphSnapshot(projectId, router, log))
  return log.onEvent((event) => platform.broadcast(IPC.agentGraphEvent, event))
}
