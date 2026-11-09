/**
 * The agent graph as the 3D view draws it. Pure: the same boxes and lines the 2D view renders,
 * reshaped for a force layout, plus how each one looks. The 3D component only renders this.
 *
 * The force layout writes its positions (`x`, `y`, `z`, velocities) onto the node objects and swaps a
 * link's `source`/`target` for node objects. So the objects are the layout's state: handing it new
 * ones for the same picture throws every node back to the start. `toGraph3dData` therefore keeps the
 * whole result while the structure is unchanged (`agentGraphStructureKey`, the 2D rule "layout is keyed
 * on structure, not content"), and keeps each surviving node object when it is not, so only what is
 * new has to find a place.
 */
import { forceX, forceY, forceZ, type Force } from 'd3-force-3d'
import { AGENT_CONFIG, FALLBACK_AGENT_COLOR, type BuiltinAgentId } from '@shared/agents/config'
import { agentGraphStructureKey, edgeInTransit, type AgentGraphModel, type GraphEdge, type GraphEdgeKind, type GraphNode, type GraphNodeKind } from './agentGraphModel'
import { graphEdgeColor, graphEdgeDashed, MCP_LINE, SKILL_LINE } from './agentGraphEdgeText'
import { GLOW_COLOR, sessionGlow, type GraphGlow } from './agentGraphNodeText'

/** A type, not an interface: the layout's node type has an index signature, which only a type
 *  literal satisfies. */
export type Graph3dNode = { id: string; kind: GraphNodeKind }

/** `source` and `target` are ids here; the layout replaces them with the node objects. */
export type Graph3dLink = { id: string; source: string | Graph3dNode; target: string | Graph3dNode; kind: GraphEdgeKind }

export interface Graph3dData {
  /** The structure this was built for. */
  key: string
  nodes: Graph3dNode[]
  links: Graph3dLink[]
}

const endId = (end: string | Graph3dNode): string => (typeof end === 'string' ? end : end.id)

export function toGraph3dData(model: Pick<AgentGraphModel, 'nodes' | 'edges'>, prev?: Graph3dData | null): Graph3dData {
  const key = agentGraphStructureKey(model)
  // A kind is not structure in 2D (a box keeps its place), but here it is the shape: a session that
  // turned ghost under the same id needs a new object, so the library builds it a new mesh.
  const sameKinds = !!prev && prev.nodes.length === model.nodes.length && model.nodes.every((n, i) => prev.nodes[i].kind === n.kind)
  if (prev && prev.key === key && sameKinds) return prev
  const oldNodes = new Map((prev?.nodes ?? []).map((n) => [n.id, n]))
  const oldLinks = new Map((prev?.links ?? []).map((l) => [l.id, l]))
  const nodes = model.nodes.map((n): Graph3dNode => {
    const old = oldNodes.get(n.id)
    return old && old.kind === n.kind ? old : { id: n.id, kind: n.kind }
  })
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // The layout swaps a line's ends for node objects, and keeps an end that is already an object. A line
  // still tied to a node object that was replaced would stay pinned to where that object froze.
  const endIsLive = (end: string | Graph3dNode, id: string): boolean => endId(end) === id && (typeof end === 'string' || byId.get(id) === end)
  const links: Graph3dLink[] = []
  for (const e of model.edges) {
    // The layout throws on a link to a node it was not given, as dagre invents one; neither is drawn.
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    const old = oldLinks.get(e.id)
    links.push(old && old.kind === e.kind && endIsLive(old.source, e.source) && endIsLive(old.target, e.target) ? old : { id: e.id, source: e.source, target: e.target, kind: e.kind })
  }
  return { key, nodes, links }
}

export type Graph3dShape = 'sphere' | 'icosahedron' | 'dodecahedron' | 'octahedron' | 'box' | 'tetrahedron'

export interface Graph3dNodeLook {
  shape: Graph3dShape
  /** World units. */
  radius: number
  /** A CSS colour: an agent's brand hex, or a role token to resolve against the theme. */
  color: string
  glow?: GraphGlow
  glowColor?: string
  /** A box the 2D view draws faded. */
  faded?: boolean
  label: string
}

const NODE_SHAPE: Readonly<Record<GraphNodeKind, { shape: Graph3dShape; radius: number }>> = {
  session: { shape: 'sphere', radius: 7 },
  harness: { shape: 'icosahedron', radius: 8 },
  stage: { shape: 'dodecahedron', radius: 5 },
  subagent: { shape: 'dodecahedron', radius: 5 },
  skill: { shape: 'octahedron', radius: 4.5 },
  mcp: { shape: 'box', radius: 4 },
  note: { shape: 'tetrahedron', radius: 4 },
  ghost: { shape: 'sphere', radius: 3.5 }
}

const NEUTRAL = 'rgba(var(--tint-rgb), 0.45)'

function nodeColor(node: GraphNode): string {
  switch (node.kind) {
    case 'session':
      return node.agentId ? (AGENT_CONFIG[node.agentId as BuiltinAgentId]?.color ?? FALLBACK_AGENT_COLOR) : FALLBACK_AGENT_COLOR
    case 'skill':
      return SKILL_LINE
    case 'mcp':
      return MCP_LINE
    case 'note':
      return 'var(--state-automation)'
    case 'stage':
    case 'subagent':
      return node.color ? `var(--sys-${node.color})` : NEUTRAL
    default:
      return NEUTRAL
  }
}

/** How a node looks: its shape by kind, a session's colour by agent, and the glow of its status. A run
 *  in progress glows as working, as its box's border does in 2D. */
export function graph3dNodeLook(node: GraphNode): Graph3dNodeLook {
  const { shape, radius } = NODE_SHAPE[node.kind]
  const glow = sessionGlow(node) ?? (node.activity === 'running' ? 'working' : undefined)
  return {
    shape,
    radius,
    color: nodeColor(node),
    ...(glow ? { glow, glowColor: GLOW_COLOR[glow] } : {}),
    ...(node.kind === 'ghost' ? { faded: true } : {}),
    label: node.runs ? `${node.title} ×${node.runs}` : node.title
  }
}

export interface Graph3dLinkLook {
  /** The 2D line's colour token (`graphEdgeColor`). */
  color: string
  /** World units; a loop is drawn heavier, as in 2D. */
  width: number
  /** A dashed 2D line, drawn fainter here: a tube has no dash. */
  dashed: boolean
  /** Every line but the Harness one carries an arrow, as in 2D. */
  arrow: boolean
  /** The dot runs from target to source (`GraphEdge.flow`). */
  reverse: boolean
}

export function graph3dLinkLook(edge: GraphEdge): Graph3dLinkLook {
  return {
    color: graphEdgeColor(edge),
    width: edge.loop ? 1.1 : 0.45,
    dashed: graphEdgeDashed(edge),
    arrow: edge.kind !== 'harness',
    reverse: edge.flow === 'reverse'
  }
}

/** Opacity a dashed line keeps in 3D, on top of its colour's own alpha. */
export const DASHED_LINK_ALPHA = 0.55

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const clampByte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
const clampUnit = (n: number): number => Math.max(0, Math.min(1, n))

/**
 * A resolved CSS colour, in the forms a browser's computed style hands back: hex, `rgb()`/`rgba()` with
 * commas or spaces, and `color(srgb …)`, which is what Chromium computes a `color-mix()` to. Anything
 * else is null, so the caller keeps its fallback rather than drawing black.
 */
export function parseCssColor(value: string): Rgba | null {
  const s = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,8})$/.exec(s)
  if (hex) {
    const h = hex[1]
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => parseInt(c + c, 16))
      return { r, g, b, a: h.length === 4 ? a / 255 : 1 }
    }
    if (h.length === 6 || h.length === 8) {
      const n = (i: number): number => parseInt(h.slice(i, i + 2), 16)
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
    }
    return null
  }
  const fn = /^(rgba?|color)\((.*)\)$/.exec(s)
  if (!fn) return null
  let body = fn[2].trim()
  let srgb = false
  if (fn[1] === 'color') {
    if (!body.startsWith('srgb ')) return null
    srgb = true
    body = body.slice(5)
  }
  const [channels, slashAlpha] = body.split('/').map((p) => p.trim())
  const parts = channels.split(/[\s,]+/).filter(Boolean)
  if (parts.length < 3) return null
  const num = (p: string, unit: number): number => (p.endsWith('%') ? (parseFloat(p) / 100) * unit : parseFloat(p))
  const alphaText = slashAlpha ?? parts[3]
  const rgb = parts.slice(0, 3).map((p) => (srgb ? num(p, 1) * 255 : num(p, 255)))
  const a = alphaText === undefined ? 1 : num(alphaText, 1)
  if ([...rgb, a].some((n) => Number.isNaN(n))) return null
  return { r: clampByte(rgb[0]), g: clampByte(rgb[1]), b: clampByte(rgb[2]), a: clampUnit(a) }
}

/** The form the 3D library and three.js both read; the alpha becomes the material's opacity. */
export function rgbaString(c: Rgba): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`
}

export function rgbHex(c: Rgba): string {
  return `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

/** Satellites one box carries: one per live subagent run, the newest kept. More is a count in its text. */
export const MAX_SATELLITES = 8

/** What moves on one node while frames run. Only what is true moves: a box turns and breathes while
 *  work it stands for is running, and each live subagent run is a satellite around it. */
export interface Graph3dNodeMotion {
  /** The core turns: a subagent or stage with a run going on. A session sphere would not show it. */
  spin: boolean
  /** The halo swells and fades: a box with a live subagent run. A session that is only working keeps
   *  its still halo, because a turn can last hours and its breath would hold frames all that time. */
  breathe: boolean
  /** Live run ids, oldest first, at most `MAX_SATELLITES`. */
  satellites: string[]
}

export function graph3dNodeMotion(node: GraphNode): Graph3dNodeMotion {
  const live = node.live ?? []
  const running = node.activity === 'running' || live.length > 0
  return {
    spin: running && node.kind !== 'session' && node.kind !== 'ghost',
    breathe: running,
    satellites: live.slice(-MAX_SATELLITES).map((r) => r.id)
  }
}

/**
 * Whether anything on screen is moving because something is happening: a box breathing or carrying a
 * satellite, or a line in transit by the 2D rule (`edgeInTransit`). This is what keeps frames running on
 * a graph whose layout has settled, so it answers no for anything that is merely there.
 */
export function graph3dHasLiveMotion(nodes: readonly GraphNode[], edges: readonly GraphEdge[], now: number): boolean {
  if (edges.some((e) => edgeInTransit(e, now))) return true
  return nodes.some((n) => {
    const m = graph3dNodeMotion(n)
    return m.breathe || m.satellites.length > 0
  })
}

/** How often a line in transit sends another particle, so a running hand-off reads as a stream. */
export const STREAM_EVERY_MS = 900

/** What keeps the 3D view drawing frames. */
export interface Graph3dLoopInput {
  /** Mounted and not covered by the terminal modal. */
  shown: boolean
  /** The window is focused and visible: the same gate that pauses every CSS loop. */
  watched: boolean
  /** The force layout is still moving nodes. */
  engineRunning: boolean
  /** A particle is still travelling along a line. */
  particlesInFlight: boolean
  /** The pointer is over the view: hover, a drag that turns the camera, the wheel. */
  pointerInside: boolean
  /** Something is running (`graph3dHasLiveMotion`), and Reduce Motion is off. */
  liveMotion: boolean
  /** A camera move or a redraw was asked for until then. */
  busyUntil: number
  now: number
}

/**
 * Whether the render loop runs. A WebGL loop is a frame every vsync, as a running CSS animation is
 * (CLAUDE.md "Idle energy"), so it runs only while something on screen can change and somebody can see
 * it: a settled graph nobody is pointing at costs no frames at all.
 */
export function graph3dLoopShouldRun(s: Graph3dLoopInput): boolean {
  if (!s.shown || !s.watched) return false
  return s.engineRunning || s.particlesInFlight || s.liveMotion || s.pointerInside || s.busyUntil > s.now
}

/** How hard every pair of nodes pushes apart (`forceManyBody`). */
export const GRAPH3D_CHARGE = -140

/**
 * How hard each node is pulled toward the middle, on each axis (`forceX`/`forceY`/`forceZ`). The
 * library's own `center` force only moves the whole graph's centroid, so two parts with no line between
 * them (a ship template beside the sessions) pushed each other apart with nothing pulling back: eight
 * line lengths apart, and fitting both left every node a speck. This keeps them about two lines apart
 * and leaves a line's own length alone.
 */
export const GRAPH3D_GRAVITY = 0.1

/** The pull toward the screen's plane is this many times stronger. The first view looks down the depth
 *  axis, and with an even pull nodes sat behind each other there. At 2.5 the graph is about a sixth as
 *  deep as it is wide: the first view shows nodes side by side, and turning it still shows depth. */
export const GRAPH3D_DEPTH_FLATTEN = 2.5

/** The forces the view adds to the library's own `link`, `charge` and `center`, by name. */
export function graph3dLayoutForces(): Record<string, Force> {
  return {
    x: forceX(0).strength(GRAPH3D_GRAVITY),
    y: forceY(0).strength(GRAPH3D_GRAVITY),
    z: forceZ(0).strength(GRAPH3D_GRAVITY * GRAPH3D_DEPTH_FLATTEN)
  }
}

/** Layout settings. Under reduced motion the layout is computed before the first frame and never
 *  animates; otherwise it settles on screen and stops. */
export function graph3dEngineSettings(reducedMotion: boolean): { warmupTicks: number; cooldownTicks: number; cooldownTime: number } {
  return reducedMotion ? { warmupTicks: 300, cooldownTicks: 0, cooldownTime: 0 } : { warmupTicks: 0, cooldownTicks: 300, cooldownTime: 4000 }
}
