/**
 * Where the agent graph's boxes go. Pure, and the only file that knows about dagre.
 *
 * dagre rather than the canvas's own arrangers because this graph has BACK-EDGES (a reject loop is
 * the interesting part of a ship process), and it routes them: each edge comes back with waypoints,
 * which the edge component draws, so a loop goes around the stages instead of through them.
 */
import dagre from '@dagrejs/dagre'
import { isBackEdge, type GraphEdge, type GraphEdgeKind, type GraphNode, type GraphNodeKind } from './agentGraphModel'

export interface GraphPoint {
  x: number
  y: number
}

export interface LaidOutGraph {
  /** Top-left corner per node id, in flow coordinates. */
  positions: Map<string, GraphPoint>
  /** Waypoints per edge id, source end first. */
  routes: Map<string, GraphPoint[]>
}

const NODE_SIZE: Readonly<Record<GraphNodeKind, { width: number; height: number }>> = {
  session: { width: 224, height: 78 },
  stage: { width: 196, height: 68 },
  subagent: { width: 196, height: 68 },
  note: { width: 168, height: 48 },
  ghost: { width: 168, height: 48 }
}

export function agentGraphNodeSize(kind: GraphNodeKind): { width: number; height: number } {
  return NODE_SIZE[kind]
}

export function layoutAgentGraph(
  nodes: ReadonlyArray<Pick<GraphNode, 'id' | 'kind'>>,
  edges: ReadonlyArray<Pick<GraphEdge, 'id' | 'source' | 'target'> & Partial<Pick<GraphEdge, 'kind' | 'loop'>> & { labelWidth?: number }>
): LaidOutGraph {
  const g = new dagre.graphlib.Graph({ multigraph: true, compound: false })
  g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 56, edgesep: 24, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))
  const ids = new Set(nodes.map((n) => n.id))
  for (const n of nodes) g.setNode(n.id, { ...agentGraphNodeSize(n.kind) })
  // A reject loop is given to dagre the right way round and its route reversed afterwards, so the
  // stages stay in process order. Left to its own cycle breaking, dagre may break the cycle at a
  // forward edge instead, and the reviewer lands to the left of what it reviews. The same goes for
  // a reply: relations that say who leads (an opener, a wait, the process) are placed first, and a
  // message running against one already placed follows it, so an orchestrator sits left of its
  // stations however the chat between them went.
  const reversed = new Set<string>()
  const placed = new Set<string>()
  const lastPlaced = (kind?: GraphEdgeKind): boolean => kind === 'message'
  const ordered = [...edges.filter((e) => !lastPlaced(e.kind)), ...edges.filter((e) => lastPlaced(e.kind))]
  for (const e of ordered) {
    // An edge to a box that is not drawn would make dagre invent a zero-sized node for it.
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    const back = (!!e.kind && isBackEdge({ kind: e.kind, loop: e.loop })) || placed.has(`${e.target}>${e.source}`)
    if (back) reversed.add(e.id)
    const v = back ? e.target : e.source
    const w = back ? e.source : e.target
    placed.add(`${v}>${w}`)
    // A label is space dagre has to keep free, or it lands under the boxes on either side.
    g.setEdge({ v, w, name: e.id }, e.labelWidth ? { width: e.labelWidth, height: 18, labelpos: 'c' } : {})
  }
  dagre.layout(g)

  const positions = new Map<string, GraphPoint>()
  for (const n of nodes) {
    const box = g.node(n.id)
    positions.set(n.id, { x: box.x - box.width / 2, y: box.y - box.height / 2 })
  }
  const routes = new Map<string, GraphPoint[]>()
  for (const ref of g.edges()) {
    const points = (g.edge(ref) as { points?: GraphPoint[] }).points
    if (ref.name && points) routes.set(ref.name, reversed.has(ref.name) ? [...points].reverse() : points)
  }
  return { positions, routes }
}

/**
 * An SVG path through a route: straight runs with the corners rounded, so a routed loop reads as one
 * line rather than a polygon.
 */
export function routeToPath(points: readonly GraphPoint[], radius = 14): string {
  if (points.length === 0) return ''
  const fmt = (p: GraphPoint): string => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`
  let d = `M ${fmt(points[0])}`
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]
    const at = points[i]
    const next = points[i + 1]
    const inLen = Math.hypot(at.x - prev.x, at.y - prev.y)
    const outLen = Math.hypot(next.x - at.x, next.y - at.y)
    const r = Math.min(radius, inLen / 2, outLen / 2)
    if (r < 0.5) {
      d += ` L ${fmt(at)}`
      continue
    }
    const a = { x: at.x + ((prev.x - at.x) * r) / inLen, y: at.y + ((prev.y - at.y) * r) / inLen }
    const b = { x: at.x + ((next.x - at.x) * r) / outLen, y: at.y + ((next.y - at.y) * r) / outLen }
    d += ` L ${fmt(a)} Q ${fmt(at)} ${fmt(b)}`
  }
  if (points.length > 1) d += ` L ${fmt(points[points.length - 1])}`
  return d
}

/** Where an edge's label sits: the middle waypoint, which is on the line whatever the route does. */
export function routeMidpoint(points: readonly GraphPoint[]): GraphPoint {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length % 2 === 1) return points[(points.length - 1) / 2]
  const a = points[points.length / 2 - 1]
  const b = points[points.length / 2]
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** The length of a route, corners taken square: near enough to pace a mark along it. */
export function routeLength(points: readonly GraphPoint[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  return total
}

/** Marks per line. Fixed, so a long loop costs what a short step does. */
export const EDGE_CHEVRONS = 3
const CHEVRON_SPEED_PX_S = 60
const CHEVRON_MIN_S = 1.5

/** Seconds for a mark to run a route: about one speed on any line, without racing on a short one. */
export function chevronDuration(length: number): number {
  return Math.max(CHEVRON_MIN_S, length / CHEVRON_SPEED_PX_S)
}

/** Where each mark sits, as a fraction of the route, evenly spaced and clear of both ends. Still marks
 *  rest here, and moving ones start from here, so a line that starts moving does not jump. */
export function chevronStops(): number[] {
  return Array.from({ length: EDGE_CHEVRONS }, (_, i) => (i + 0.5) / EDGE_CHEVRONS)
}
