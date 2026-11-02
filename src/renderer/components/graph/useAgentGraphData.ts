import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AGENT_GRAPH_HISTORY_CAP,
  AGENT_GRAPH_LOG_CAPACITY,
  emptyAgentGraphSnapshot,
  mergeAgentGraphEvents,
  type AgentGraphEvent,
  type AgentGraphSnapshot
} from '@shared/agent-graph'
import type { ShipConfigResult } from '@shared/ship-config'
import type { AgentGraphApi, BoardLogApi } from '@shared/types'
import { errorText } from '@shared/error-text'

/** What this view may hold: everything the core can keep plus one full history read. */
const VIEW_EVENT_CAP = AGENT_GRAPH_LOG_CAPACITY + AGENT_GRAPH_HISTORY_CAP
/** A burst of board-log writes is one re-read. */
const RELOAD_MS = 1500

/** The project's graph history plus whatever arrives while the view is open. `mountedAt` is what the
 *  pulse compares against, so opening the view does not flash the whole past. */
export function useAgentGraphEvents(
  api: { agentGraph: AgentGraphApi; boardLog: Pick<BoardLogApi, 'onChanged'> } | undefined,
  projectId: string
): { snapshot: AgentGraphSnapshot | null; mountedAt: number } {
  // Held with the project it answers: another project's answer must never show while this one's read
  // is out, which over SSH can take seconds.
  const [held, setHeld] = useState<{ projectId: string; snapshot: AgentGraphSnapshot } | null>(null)
  const [mountedAt] = useState(() => Date.now())

  useEffect(() => {
    if (!api) return
    let alive = true
    let reload: ReturnType<typeof setTimeout> | undefined
    // Subscribed BEFORE the first read, and re-merged after it, so an event in between is not lost.
    const live: AgentGraphEvent[] = []
    const load = (): void => {
      api.agentGraph
        .snapshot(projectId)
        .catch(() => emptyAgentGraphSnapshot())
        .then((s) => {
          if (!alive) return
          setHeld({ projectId, snapshot: { ...s, events: mergeAgentGraphEvents(s.events, live) } })
        })
    }
    const offEvent = api.agentGraph.onEvent((event) => {
      live.push(event)
      if (live.length > AGENT_GRAPH_LOG_CAPACITY) live.shift()
      setHeld((cur) => {
        const base = cur?.projectId === projectId ? cur.snapshot : emptyAgentGraphSnapshot()
        const events = mergeAgentGraphEvents(base.events, [event])
        const over = Math.max(0, events.length - VIEW_EVENT_CAP)
        return { projectId, snapshot: { ...base, events: over ? events.slice(over) : events, dropped: base.dropped + over } }
      })
    })
    const offLog = api.boardLog.onChanged(projectId, () => {
      if (reload !== undefined) return
      reload = setTimeout(() => {
        reload = undefined
        load()
      }, RELOAD_MS)
    })
    load()
    return () => {
      alive = false
      clearTimeout(reload)
      offEvent()
      offLog()
    }
  }, [api, projectId])

  return { snapshot: held?.projectId === projectId ? held.snapshot : null, mountedAt }
}

/** The machine's ship config, re-read when the core says it changed. A failure is a named state:
 *  the view still draws what it observes. */
export function useShipConfig(
  api: { agentGraph: AgentGraphApi } | undefined,
  projectId: string
): { result: ShipConfigResult | null; reload: () => void } {
  const [held, setHeld] = useState<{ projectId: string; result: ShipConfigResult } | null>(null)
  const seq = useRef(0)

  const reload = useCallback(() => {
    if (!api) return
    const mine = ++seq.current
    api.agentGraph
      .readShipConfig(projectId)
      .catch((err: unknown): ShipConfigResult => ({ ok: false, reason: errorText(err) }))
      .then((r) => {
        if (mine === seq.current) setHeld({ projectId, result: r })
      })
  }, [api, projectId])

  useEffect(() => {
    if (!api) return
    reload()
    const off = api.agentGraph.onShipConfigChanged(projectId, reload)
    return () => {
      seq.current++
      off()
    }
  }, [api, projectId, reload])

  return { result: held?.projectId === projectId ? held.result : null, reload }
}
