/**
 * Where the system map's boxes go: one column per part kind present (callers to outside services, left
 * to right), parts in file order down each column, every column centred on the tallest. Pure. No
 * dagre: a system map is read by column, and the columns are its meaning, so they are not left to a
 * layout engine. Hand-placed positions are not a feature (docs/reference/agent-graph.md "System map").
 */
import type { GraphPoint } from './agentGraphLayout'
import type { SystemMapBox, SystemMapLine } from './systemMapModel'

export const PART_W = 200, PART_H = 64, COL_GAP = 140, ROW_GAP = 28, SAME_COLUMN_BULGE = 40

export interface SystemMapLayout {
  /** Top-left corner per part id, in flow coordinates. */
  positions: Map<string, { x: number; y: number }>
  /** Waypoints per line id, source end first. */
  routes: Map<string, GraphPoint[]>
}

export function layoutSystemMap(boxes: readonly SystemMapBox[], lines: readonly SystemMapLine[], columnCount: number): SystemMapLayout {
  const rowsInColumn = new Array<number>(Math.max(0, columnCount)).fill(0)
  for (const b of boxes) rowsInColumn[b.column] = Math.max(rowsInColumn[b.column] ?? 0, b.row + 1)
  const tallest = rowsInColumn.reduce((max, n) => Math.max(max, n), 0)
  const positions = new Map<string, { x: number; y: number }>()
  const column = new Map<string, number>()
  for (const b of boxes) {
    const rows = rowsInColumn[b.column] ?? 0
    positions.set(b.id, {
      x: b.column * (PART_W + COL_GAP),
      y: b.row * (PART_H + ROW_GAP) + ((tallest - rows) * (PART_H + ROW_GAP)) / 2
    })
    column.set(b.id, b.column)
  }
  const routes = new Map<string, GraphPoint[]>()
  for (const line of lines) {
    const s = positions.get(line.from)
    const t = positions.get(line.to)
    if (!s || !t) continue
    const sc = column.get(line.from)!
    const tc = column.get(line.to)!
    const sMid = s.y + PART_H / 2
    const tMid = t.y + PART_H / 2
    if (sc < tc) routes.set(line.id, [{ x: s.x + PART_W, y: sMid }, { x: t.x, y: tMid }])
    else if (sc > tc) routes.set(line.id, [{ x: s.x, y: sMid }, { x: t.x + PART_W, y: tMid }])
    else {
      const right = s.x + PART_W
      routes.set(line.id, [
        { x: right, y: sMid },
        { x: right + SAME_COLUMN_BULGE, y: sMid },
        { x: right + SAME_COLUMN_BULGE, y: tMid },
        { x: right, y: tMid }
      ])
    }
  }
  return { positions, routes }
}
