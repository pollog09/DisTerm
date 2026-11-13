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
export type Graph3dNode = { id: string; kind: GraphNodeKind; fx?: number; fy?: number; fz?: number }

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

/** What a planet's surface is painted as. Each kind of node is its own kind of world, so the picture
 *  still tells a session from a stage from a note once every node is round. */
export type Graph3dSurface = 'gas' | 'rock' | 'ice' | 'asteroid'

/** A node as a planet: what it is made of, and what it wears around it. */
export interface Graph3dPlanet {
  surface: Graph3dSurface
  /** A flat ring around its equator. */
  ring: boolean
  /** A thin haze past its edge. */
  atmosphere: boolean
  /** From the node's id, so the same node is always painted, tilted and turned the same way. */
  seed: number
}

export interface Graph3dNodeLook {
  planet: Graph3dPlanet
  /** World units. */
  radius: number
  /** A CSS colour: an agent's brand hex, or a role token to resolve against the theme. */
  color: string
  glow?: GraphGlow
  glowColor?: string
  /** A box the 2D view draws faded. */
  faded?: boolean
  label: string
  /** Which name wins when two would cover each other on screen: lower first. */
  labelRank: number
}

/** Sessions are the gas giants, the Harness the ringed hub, stages and subagents rocky worlds, skills and
 *  MCP servers icy moons (a server with a ring), notes asteroids. */
const NODE_BODY: Readonly<Record<GraphNodeKind, Omit<Graph3dPlanet, 'seed'> & { radius: number }>> = {
  session: { surface: 'gas', ring: false, atmosphere: true, radius: 7 },
  harness: { surface: 'gas', ring: true, atmosphere: false, radius: 6 },
  stage: { surface: 'rock', ring: false, atmosphere: false, radius: 5 },
  subagent: { surface: 'rock', ring: false, atmosphere: false, radius: 5 },
  skill: { surface: 'ice', ring: false, atmosphere: false, radius: 4.5 },
  mcp: { surface: 'ice', ring: true, atmosphere: false, radius: 4 },
  note: { surface: 'asteroid', ring: false, atmosphere: false, radius: 4 },
  ghost: { surface: 'rock', ring: false, atmosphere: false, radius: 3.5 }
}

/** FNV-1a over the id: a stable 32-bit number per node. */
export function graph3dSeed(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** How a planet sits when nothing turns it: an axial tilt and the face it shows, both from its seed. */
export function graph3dPlanetPose(seed: number): { tilt: number; turn: number } {
  return { tilt: (((seed >>> 8) % 1000) / 1000 - 0.5) * 0.8, turn: ((seed % 1000) / 1000) * Math.PI * 2 }
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

/** How a node looks: its planet by kind, a session's colour by agent, and the glow of its status. A run
 *  in progress glows as working, as its box's border does in 2D. */
export function graph3dNodeLook(node: GraphNode): Graph3dNodeLook {
  const { radius, ...body } = NODE_BODY[node.kind]
  const glow = sessionGlow(node) ?? (node.activity === 'running' ? 'working' : undefined)
  return {
    planet: { ...body, seed: graph3dSeed(node.id) },
    radius,
    color: nodeColor(node),
    ...(glow ? { glow, glowColor: GLOW_COLOR[glow] } : {}),
    ...(node.kind === 'ghost' ? { faded: true } : {}),
    label: node.runs ? `${node.title} ×${node.runs}` : node.title,
    labelRank: LABEL_RANK[node.kind]
  }
}

/** The sessions are what the graph is about, so their names are the last to give way. */
const LABEL_RANK: Readonly<Record<GraphNodeKind, number>> = {
  session: 0,
  harness: 1,
  stage: 2,
  subagent: 2,
  skill: 3,
  mcp: 3,
  note: 4,
  ghost: 5
}

/**
 * The current step: where work is going on right now, drawn as the system's sun. Of the nodes with
 * something running (a working session, a running box, a live subagent run), the one with the newest
 * event; a tie goes to the more important kind. Nothing running is no sun: the view never claims a step
 * that is not happening.
 */
export function graph3dCurrentStep(nodes: readonly GraphNode[]): string | null {
  let best: GraphNode | null = null
  for (const n of nodes) {
    const running = n.activity === 'running' || (n.kind === 'session' && n.state === 'working') || (n.live?.length ?? 0) > 0
    if (!running) continue
    const ts = n.lastEventTs ?? -Infinity
    const bestTs = best?.lastEventTs ?? -Infinity
    if (!best || ts > bestTs || (ts === bestTs && LABEL_RANK[n.kind] < LABEL_RANK[best.kind])) best = n
  }
  return best?.id ?? null
}

/** What a running world is doing: its newest live run's task, as the 2D box writes it under its name. */
export function graph3dTask(node: Pick<GraphNode, 'live'>): string | undefined {
  return [...(node.live ?? [])].reverse().find((run) => run.label)?.label
}

/** A line under a world's name: that it is the current step, or what it is doing now. */
export interface Graph3dCaption {
  kind: 'step' | 'task'
  text: string
}

export function graph3dCaptions(node: Pick<GraphNode, 'live'>, sun: boolean): Graph3dCaption[] {
  const task = graph3dTask(node)
  return [...(sun ? [{ kind: 'step' as const, text: 'CURRENT STEP' }] : []), ...(task ? [{ kind: 'task' as const, text: task }] : [])]
}

/** A name's place on screen, in CSS pixels from the view's top left. */
export interface Graph3dLabelBox {
  id: string
  left: number
  top: number
  width: number
  height: number
  /** Distance from the camera, for ties within a rank: the nearer name wins. */
  depth: number
  rank: number
}

/** Space kept between two names, in CSS pixels. */
export const LABEL_GAP_PX = 3

/**
 * The names to draw: by rank, then nearest first, each one that does not cover a name already kept. A
 * name that gives way is not lost: hovering its node shows it in the tooltip, and turning the view
 * brings it back. Labels sit at a fixed size on screen, so without this a turned graph stacks them.
 */
export function graph3dShownLabels(boxes: readonly Graph3dLabelBox[]): Set<string> {
  const kept: Graph3dLabelBox[] = []
  const covers = (a: Graph3dLabelBox, b: Graph3dLabelBox): boolean =>
    a.left < b.left + b.width + LABEL_GAP_PX &&
    b.left < a.left + a.width + LABEL_GAP_PX &&
    a.top < b.top + b.height + LABEL_GAP_PX &&
    b.top < a.top + a.height + LABEL_GAP_PX
  for (const box of [...boxes].sort((a, b) => a.rank - b.rank || a.depth - b.depth)) {
    if (!kept.some((k) => covers(k, box))) kept.push(box)
  }
  return new Set(kept.map((k) => k.id))
}

/**
 * The world scale that draws a sprite `px` CSS pixels tall at any distance. With `sizeAttenuation` off,
 * three multiplies a sprite's scale by its distance, so it covers `scale * cot(fov / 2)` of the half
 * height of the view whatever its depth.
 */
export function graph3dPixelScale(px: number, viewHeight: number, fovDegrees: number): number {
  return (2 * px * Math.tan((fovDegrees * Math.PI) / 360)) / Math.max(1, viewHeight)
}

export interface Graph3dLinkLook {
  /** The 2D line's colour token (`graphEdgeColor`). */
  color: string
  /** World units; a loop is drawn heavier, as in 2D. */
  width: number
  /** A dashed 2D line, drawn fainter here: a tube has no dash. */
  dashed: boolean
  /** World units. Every line but the Harness one carries an arrow, as in 2D; that one's is 0. */
  arrowLength: number
  /** The dot runs from target to source (`GraphEdge.flow`). */
  reverse: boolean
}

export function graph3dLinkLook(edge: GraphEdge): Graph3dLinkLook {
  return {
    color: graphEdgeColor(edge),
    width: edge.loop ? 1.6 : 0.7,
    dashed: graphEdgeDashed(edge),
    arrowLength: edge.kind !== 'harness' ? 4.5 : 0,
    reverse: edge.flow === 'reverse'
  }
}

/** Opacity a dashed line keeps in 3D, on top of its colour's own alpha. */
export const DASHED_LINK_ALPHA = 0.55

/** A flow particle's core radius, in world units: about three times a line's own radius (0.35). */
export const PARTICLE_RADIUS = 1.1
/** On a loop line, which is drawn heavier (width 1.6), the particle is bigger too. */
export const LOOP_PARTICLE_RADIUS = 1.5
/** The halo shell's radius, in core radii. */
export const PARTICLE_HALO_SPAN = 2

export interface Graph3dParticleLook {
  /** The line's colour token (`graphEdgeColor`), lifted toward the sky's opposite where it is worn. */
  color: string
  /** World units. */
  radius: number
  /** World units: the faint shell round the core. */
  haloRadius: number
}

export function graph3dParticleLook(edge: GraphEdge): Graph3dParticleLook {
  const radius = edge.loop ? LOOP_PARTICLE_RADIUS : PARTICLE_RADIUS
  return { color: graphEdgeColor(edge), radius, haloRadius: radius * PARTICLE_HALO_SPAN }
}

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

/** A translucent colour laid over an opaque one. A solid mesh has no alpha to spend, so a token like the
 *  45% tint is drawn as what it would look like on the panel, not as the full tint. */
export function compositeOver(c: Rgba, under: Rgba): Rgba {
  const mix = (top: number, bottom: number): number => clampByte(top * c.a + bottom * (1 - c.a))
  return { r: mix(c.r, under.r), g: mix(c.g, under.g), b: mix(c.b, under.b), a: 1 }
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
  /** A fly key is held down. */
  flying: boolean
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
  return s.engineRunning || s.particlesInFlight || s.liveMotion || s.pointerInside || s.flying || s.busyUntil > s.now
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

/** A way to fly the camera. */
export type Graph3dFlyMove = 'forward' | 'back' | 'left' | 'right' | 'up' | 'down'

/** By the key's place on the keyboard (`KeyboardEvent.code`), so W A S D sit under the same fingers
 *  on any layout. The arrows do the same as W A S D. */
const FLY_KEYS: Readonly<Record<string, Graph3dFlyMove>> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'up',
  ShiftLeft: 'down',
  ShiftRight: 'down'
}

/** The move a key makes, or null. A key held with ⌘, Ctrl or Alt is a shortcut, never a move, so the
 *  app's own chords (⌘W among them) still reach it while the view has focus. */
export function graph3dFlyMove(e: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): Graph3dFlyMove | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  return FLY_KEYS[e.code] ?? null
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** Fly speed, as a share per second of the distance to what the camera turns round, so a close look
 *  moves gently and a far one crosses the graph in a few seconds. Never slower than the floor. */
export const FLY_RATE = 0.35
export const FLY_MIN_SPEED = 25
/** A frame longer than this (a hitch, or the first after a pause) moves no further than this would. */
const FLY_MAX_STEP_S = 0.05

/**
 * How far the camera, and the point it turns round, move this frame. Forward is the way the camera
 * looks, left and right stay level, up and down are the world's. Both move by the same amount, so
 * dragging still turns the view round what is in front of it.
 */
export function graph3dFlyStep(camera: Vec3, target: Vec3, held: ReadonlySet<Graph3dFlyMove>, seconds: number): Vec3 {
  const toTarget = { x: target.x - camera.x, y: target.y - camera.y, z: target.z - camera.z }
  const distance = Math.hypot(toTarget.x, toTarget.y, toTarget.z)
  const f = distance > 0 ? { x: toTarget.x / distance, y: toTarget.y / distance, z: toTarget.z / distance } : { x: 0, y: 0, z: -1 }
  const level = Math.hypot(f.z, f.x)
  const r = level > 1e-6 ? { x: -f.z / level, y: 0, z: f.x / level } : { x: 1, y: 0, z: 0 }
  const axis = (a: Graph3dFlyMove, b: Graph3dFlyMove): number => (held.has(a) ? 1 : 0) - (held.has(b) ? 1 : 0)
  const ahead = axis('forward', 'back')
  const side = axis('right', 'left')
  const rise = axis('up', 'down')
  const dir = { x: f.x * ahead + r.x * side, y: f.y * ahead + rise, z: f.z * ahead + r.z * side }
  const length = Math.hypot(dir.x, dir.y, dir.z)
  if (length === 0) return { x: 0, y: 0, z: 0 }
  const step = (Math.max(FLY_MIN_SPEED, distance * FLY_RATE) * Math.min(Math.max(0, seconds), FLY_MAX_STEP_S)) / length
  return { x: dir.x * step, y: dir.y * step, z: dir.z * step }
}
