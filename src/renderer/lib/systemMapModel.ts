/**
 * The system map as the graph view draws it (CLAUDE.md "System map" in docs/reference/agent-graph.md).
 * Pure: the repo's `docs/system-map.json` (already validated by `parseSystemMap`), the touches the
 * agent graph log recorded for it, and playback of its flows. 2D and 3D both draw from this.
 *
 * Structure is the parts and the lines; touches and playback are content and never move a box
 * (`systemMapStructureKey`), the same rule the agent graph's layout keeps.
 */
import type { AgentGraphEvent, AgentGraphMapTouchEvent } from '@shared/agent-graph'
import { WORKING_STALE_MS } from '@shared/agents/stale'
import { SYSTEM_MAP_KINDS, type SystemMap, type SystemMapMark, type SystemMapPartKind } from '@shared/system-map'

export interface SystemMapToucher {
  /** `${nodeId}:${subId ?? ''}` */
  key: string
  nodeId: string
  subId?: string
  title: string
  ts: number
}

export interface SystemMapBox {
  id: string
  label: string
  subtitle?: string
  kind: SystemMapPartKind
  column: number
  row: number
  noFiles: boolean
  touchers: SystemMapToucher[]
}

export interface SystemMapLine {
  /** `line:<from>><to>` */
  id: string
  from: string
  to: string
  label?: string
  /** Drawn for a flow step; the file declares no link between these parts. */
  implied: boolean
}

export interface SystemMapFlowEntry { id: string; name: string; steps: number }
export interface SystemMapFlowGroup { group: string; flows: SystemMapFlowEntry[] }

export interface SystemMapPicture {
  title: string
  /** Kinds present, in SYSTEM_MAP_KINDS order. */
  columns: SystemMapPartKind[]
  /** File order. */
  boxes: SystemMapBox[]
  lines: SystemMapLine[]
  /** Groups in first-seen order, flows in file order. */
  groups: SystemMapFlowGroup[]
  unmatchedEdits: number
  /** When the next lit part goes dark; absent when none is lit. */
  nextFadeAt?: number
}

export interface SystemMapPictureInput {
  map: SystemMap
  emptyParts: readonly string[]
  events: readonly AgentGraphEvent[]
  projectId: string
  /** This project's terminal nodes: id -> title. Touches from any other node are ignored. */
  sessions: ReadonlyMap<string, string>
  now: number
}

export function systemMapLineId(from: string, to: string): string {
  return `line:${from}>${to}`
}

export function buildSystemMapPicture(input: SystemMapPictureInput): SystemMapPicture {
  const { map, projectId, sessions, now } = input
  const present = new Set(map.parts.map((p) => p.kind))
  const columns = SYSTEM_MAP_KINDS.filter((k) => present.has(k))
  const empty = new Set(input.emptyParts)
  const rowsByKind = new Map<SystemMapPartKind, number>()
  const boxes: SystemMapBox[] = map.parts.map((part) => {
    const row = rowsByKind.get(part.kind) ?? 0
    rowsByKind.set(part.kind, row + 1)
    return {
      id: part.id,
      label: part.label,
      ...(part.subtitle ? { subtitle: part.subtitle } : {}),
      kind: part.kind,
      column: columns.indexOf(part.kind),
      row,
      noFiles: empty.has(part.id),
      touchers: []
    }
  })
  const byId = new Map(boxes.map((b) => [b.id, b]))

  const lines: SystemMapLine[] = map.links.map((l) => ({
    id: systemMapLineId(l.from, l.to),
    from: l.from,
    to: l.to,
    ...(l.label ? { label: l.label } : {}),
    implied: false
  }))
  const lineKeys = new Set(lines.map((l) => `${l.from}>${l.to}`))
  for (const flow of map.flows) {
    for (const step of flow.steps) {
      if (lineKeys.has(`${step.from}>${step.to}`) || lineKeys.has(`${step.to}>${step.from}`)) continue
      lineKeys.add(`${step.from}>${step.to}`)
      lines.push({ id: systemMapLineId(step.from, step.to), from: step.from, to: step.to, implied: true })
    }
  }

  const groups: SystemMapFlowGroup[] = []
  const groupIndex = new Map<string, SystemMapFlowGroup>()
  for (const flow of map.flows) {
    let g = groupIndex.get(flow.group)
    if (!g) {
      g = { group: flow.group, flows: [] }
      groupIndex.set(flow.group, g)
      groups.push(g)
    }
    g.flows.push({ id: flow.id, name: flow.name, steps: flow.steps.length })
  }

  let unmatchedEdits = 0
  let nextFadeAt: number | undefined
  const touchers = new Map<string, Map<string, SystemMapToucher>>()
  for (const e of input.events) {
    if (e.kind !== 'map-touch') continue
    const t = e as AgentGraphMapTouchEvent
    if (t.projectId !== projectId || !sessions.has(t.nodeId)) continue
    if (t.partId === undefined) {
      unmatchedEdits += t.count
      continue
    }
    if (!byId.has(t.partId) || now - t.ts >= WORKING_STALE_MS) continue
    const key = `${t.nodeId}:${t.subId ?? ''}`
    const sessionTitle = sessions.get(t.nodeId) || 'Session'
    const title = t.subId ? `${sessionTitle} › ${t.subType ?? 'subagent'}` : sessionTitle
    let forPart = touchers.get(t.partId)
    if (!forPart) touchers.set(t.partId, (forPart = new Map()))
    const prev = forPart.get(key)
    if (!prev || prev.ts < t.ts) {
      forPart.set(key, { key, nodeId: t.nodeId, ...(t.subId ? { subId: t.subId } : {}), title, ts: t.ts })
    }
    const fade = t.ts + WORKING_STALE_MS
    if (nextFadeAt === undefined || fade < nextFadeAt) nextFadeAt = fade
  }
  for (const [partId, forPart] of touchers) {
    byId.get(partId)!.touchers = [...forPart.values()].sort((a, b) => b.ts - a.ts)
  }

  return {
    title: map.title,
    columns,
    boxes,
    lines,
    groups,
    unmatchedEdits,
    ...(nextFadeAt !== undefined ? { nextFadeAt } : {})
  }
}

/** Parts' `id:kind` and lines' `id`, in order: what the layout depends on. Touches never change it. */
export function systemMapStructureKey(p: Pick<SystemMapPicture, 'boxes' | 'lines'>): string {
  return [...p.boxes.map((b) => `${b.id}:${b.kind}`), '|', ...p.lines.map((l) => l.id)].join(',')
}

export type SystemMapSelection = { kind: 'all' } | { kind: 'flow'; flowId: string }

export interface SystemMapPlayStep {
  flowId: string
  flowName: string
  index: number
  from: string
  to: string
  label: string
  mark?: SystemMapMark
  lineId: string
  /** The step runs against the line's direction (a link declared the other way). */
  reverse: boolean
}

/** Index -> the steps that move at that index. 'flow': one each. 'all': step i of every flow that has one, file order. */
export function systemMapPlaySteps(map: SystemMap, lines: readonly SystemMapLine[], selection: SystemMapSelection): SystemMapPlayStep[][] {
  const linkIds = new Set(lines.filter((l) => !l.implied).map((l) => l.id))
  const stepOf = (flowId: string, flowName: string, index: number, step: SystemMap['flows'][number]['steps'][number]): SystemMapPlayStep => {
    const forward = systemMapLineId(step.from, step.to)
    const backward = systemMapLineId(step.to, step.from)
    const lineId = linkIds.has(forward) ? forward : linkIds.has(backward) ? backward : impliedLineId(lines, step.from, step.to)
    return {
      flowId,
      flowName,
      index,
      from: step.from,
      to: step.to,
      label: step.label,
      ...(step.mark ? { mark: step.mark } : {}),
      lineId,
      reverse: lineId === backward
    }
  }
  const flows = selection.kind === 'flow' ? map.flows.filter((f) => f.id === selection.flowId) : map.flows
  const length = flows.reduce((max, f) => Math.max(max, f.steps.length), 0)
  const out: SystemMapPlayStep[][] = []
  for (let i = 0; i < length; i++) {
    const at: SystemMapPlayStep[] = []
    for (const f of flows) if (i < f.steps.length) at.push(stepOf(f.id, f.name, i, f.steps[i]))
    out.push(at)
  }
  return out
}

/** The implied line a step uses: drawn once, in the direction first seen, so it may be the reverse. */
function impliedLineId(lines: readonly SystemMapLine[], from: string, to: string): string {
  const forward = systemMapLineId(from, to)
  if (lines.some((l) => l.id === forward)) return forward
  const backward = systemMapLineId(to, from)
  return lines.some((l) => l.id === backward) ? backward : forward
}

export type SystemMapSpeed = 0.5 | 1 | 2
export const SYSTEM_MAP_SPEEDS: readonly SystemMapSpeed[] = [0.5, 1, 2]
export const SYSTEM_MAP_STEP_MS = 1600

export function systemMapStepMs(speed: SystemMapSpeed): number {
  return SYSTEM_MAP_STEP_MS / speed
}
