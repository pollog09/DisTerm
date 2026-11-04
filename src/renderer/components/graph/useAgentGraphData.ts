import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AGENT_GRAPH_HISTORY_CAP,
  AGENT_GRAPH_LOG_CAPACITY,
  emptyAgentGraphSnapshot,
  mergeAgentGraphEvents,
  type AgentGraphEvent,
  type AgentGraphSnapshot
} from '@shared/agent-graph'
import type { ShipConfigResult, ShipTemplateCreateResult } from '@shared/ship-config'
import type { AgentGraphApi, BoardLogApi } from '@shared/types'
import { errorText } from '@shared/error-text'
import { edgeInTransit, nextTransitChangeAt, type GraphEdge } from '../../lib/agentGraphModel'

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

export interface ShipTemplateState {
  busy: boolean
  /** The last answer for this project, until dismissed. */
  result: ShipTemplateCreateResult | null
  create: () => void
  dismiss: () => void
}

/** Setting a project up with the starter pipeline. The answer is held with the project it belongs to,
 *  and only that project's config is re-read for it: switching away mid-write must not put one project's
 *  answer, or one project's config, on another. */
export function useShipTemplate(
  api: { agentGraph: Pick<AgentGraphApi, 'createShipTemplate'> } | undefined,
  projectId: string,
  reloadShip: () => void
): ShipTemplateState {
  const [busyFor, setBusyFor] = useState<string | null>(null)
  const [held, setHeld] = useState<{ projectId: string; result: ShipTemplateCreateResult } | null>(null)
  const latest = useRef({ projectId, reloadShip })
  latest.current = { projectId, reloadShip }

  const create = useCallback(() => {
    if (!api) return
    setBusyFor(projectId)
    setHeld(null)
    api.agentGraph
      .createShipTemplate(projectId)
      .catch((err: unknown): ShipTemplateCreateResult => ({ ok: false, reason: 'failed', message: errorText(err) }))
      .then((result) => {
        setBusyFor(null)
        setHeld({ projectId, result })
        // A failure can have written some of it, and a retry needs to see what is there.
        if (latest.current.projectId === projectId) latest.current.reloadShip()
      })
  }, [api, projectId])

  return {
    busy: busyFor === projectId,
    result: held?.projectId === projectId ? held.result : null,
    create,
    dismiss: useCallback(() => setHeld(null), [])
  }
}

/** The ids of the lines something is passing along. A moment's transit ends with no event to say so, so
 *  one timer waits for it, like the view's stale timer. Nothing recent means no timer at all. */
export function useEdgesInTransit(edges: readonly GraphEdge[]): ReadonlySet<string> {
  const [tick, setTick] = useState(0)
  const { moving, nextAt } = useMemo(() => {
    const now = Date.now()
    return { moving: new Set(edges.filter((e) => edgeInTransit(e, now)).map((e) => e.id)), nextAt: nextTransitChangeAt(edges, now) }
    // `tick` stands for the clock: this reads it when a window it armed for has passed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, tick])
  useEffect(() => {
    if (nextAt === undefined) return
    const timer = setTimeout(() => setTick((t) => t + 1), Math.max(0, nextAt - Date.now()) + 1)
    return () => clearTimeout(timer)
  }, [nextAt, tick])
  return moving
}
