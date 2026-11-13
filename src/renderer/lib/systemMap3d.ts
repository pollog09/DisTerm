/**
 * The system map as the agent graph's 3D view draws it: the same parts and lines, as the planet kinds
 * the 3D view already knows (`PART_3D_KIND`), pinned in columns that recede in depth rather than left
 * to the force layout. Pure; `AgentGraph3D` renders the result through its optional props.
 */
import type { SystemMapPartKind } from '@shared/system-map'
import type { GraphEdge, GraphNode, GraphNodeKind } from './agentGraphModel'
import type { Vec3 } from './agentGraph3d'
import type { SystemMapBox, SystemMapLine, SystemMapPicture, SystemMapPlayStep } from './systemMapModel'

export const PART_3D_KIND: Readonly<Record<SystemMapPartKind, GraphNodeKind>> = { caller: 'note', service: 'session', store: 'skill', worker: 'stage', external: 'ghost' }
export const MAP3D_COLUMN_X = 70, MAP3D_ROW_Y = 36, MAP3D_COLUMN_DEPTH = 50

const KIND_NAME: Readonly<Record<SystemMapPartKind, string>> = {
  caller: 'Caller',
  service: 'Service',
  store: 'Store',
  worker: 'Worker',
  external: 'External'
}

export function systemMapPartNodeId(partId: string): string {
  return `part:${partId}`
}

export function systemMapTo3d(
  picture: SystemMapPicture,
  playing: readonly SystemMapPlayStep[],
  playStartedAt: number
): { nodes: GraphNode[]; edges: GraphEdge[]; pinned: Map<string, Vec3> } {
  const rowsInColumn = new Map<number, number>()
  for (const b of picture.boxes) rowsInColumn.set(b.column, Math.max(rowsInColumn.get(b.column) ?? 0, b.row + 1))
  const columns = picture.columns.length
  const nodes: GraphNode[] = []
  const pinned = new Map<string, Vec3>()
  for (const b of picture.boxes) {
    const id = systemMapPartNodeId(b.id)
    nodes.push({
      id,
      kind: PART_3D_KIND[b.kind],
      title: b.label,
      ...(b.subtitle ? { subtitle: b.subtitle } : {}),
      ...(b.touchers.length
        ? { activity: 'running' as const, live: b.touchers.map((t) => ({ id: t.key, type: t.title, startedAt: t.ts })) }
        : {})
    })
    const rows = rowsInColumn.get(b.column) ?? 1
    pinned.set(id, {
      x: (b.column - (columns - 1) / 2) * MAP3D_COLUMN_X,
      y: ((rows - 1) / 2 - b.row) * MAP3D_ROW_Y,
      z: -b.column * MAP3D_COLUMN_DEPTH
    })
  }
  const active = new Map<string, SystemMapPlayStep>()
  for (const step of playing) if (!active.has(step.lineId)) active.set(step.lineId, step)
  const edges: GraphEdge[] = picture.lines.map((line) => {
    const step = active.get(line.id)
    return {
      id: line.id,
      source: systemMapPartNodeId(line.from),
      target: systemMapPartNodeId(line.to),
      kind: 'observed',
      ...(step ? { lastEventTs: playStartedAt, ...(step.reverse ? { flow: 'reverse' as const } : {}) } : {})
    }
  })
  return { nodes, edges, pinned }
}

function minutesAgo(ts: number, now: number): string {
  const min = Math.floor((now - ts) / 60_000)
  return min < 1 ? 'just now' : `${min} min ago`
}

/** A part's hover text, in 2D (`title`) and 3D (the fly card). */
export function systemMapPartText(box: SystemMapBox, now: number): string[] {
  return [
    box.label,
    ...(box.subtitle ? [box.subtitle] : []),
    `${KIND_NAME[box.kind]} part`,
    ...(box.noFiles ? ['No files match its globs'] : []),
    ...box.touchers.map((t) => `Edited by ${t.title}, ${minutesAgo(t.ts, now)}`)
  ]
}

/** A line's hover text. */
export function systemMapLineText(line: SystemMapLine, boxes: readonly SystemMapBox[]): string[] {
  const label = (id: string): string => boxes.find((b) => b.id === id)?.label ?? id
  return [
    line.label ?? `${label(line.from)} → ${label(line.to)}`,
    line.implied ? 'Drawn for a flow step; the file declares no link here.' : undefined
  ].filter((t): t is string => t !== undefined)
}
