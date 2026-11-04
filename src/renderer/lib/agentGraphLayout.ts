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
  ghost: { width: 168, height: 48 },
  harness: { width: 196, height: 92 },
  skill: { width: 168, height: 52 },
  mcp: { width: 168, height: 52 }
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
  // The harness comes first of all: its lines point at every session, which ranks it leftmost, and
  // what is used (skills, MCP) points away from sessions, so it lands to their right.
  const firstPlaced = (kind?: GraphEdgeKind): boolean => kind === 'harness'
  const ordered = [
    ...edges.filter((e) => firstPlaced(e.kind)),
    ...edges.filter((e) => !lastPlaced(e.kind) && !firstPlaced(e.kind)),
    ...edges.filter((e) => lastPlaced(e.kind))
  ]
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
