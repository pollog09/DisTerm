import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph'
import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
  BufferAttribute,
  CanvasTexture,
  DirectionalLight,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NormalBlending,
  type PerspectiveCamera,
  Points,
  PointsMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
  BufferGeometry,
  type Object3D
} from 'three'
import { edgeInTransit, type GraphEdge, type GraphNode } from '../../lib/agentGraphModel'
import { graphEdgeLabel, graphEdgeTitle } from '../../lib/agentGraphEdgeText'
import { MAX_FLOW_DOTS } from '../../lib/agentGraphLayout'
import { graphNodeTextLines } from '../../lib/agentGraphNodeText'
import {
  DASHED_LINK_ALPHA,
  GRAPH3D_CHARGE,
  graph3dEngineSettings,
  graph3dFlyMove,
  graph3dFlyStep,
  type Graph3dFlyMove,
  graph3dCurrentStep,
  graph3dHasLiveMotion,
  graph3dLayoutForces,
  graph3dLinkLook,
  graph3dLoopShouldRun,
  graph3dNodeLook,
  graph3dNodeMotion,
  graph3dPixelScale,
  graph3dPlanetPose,
  graph3dShownLabels,
  STREAM_EVERY_MS,
  type Graph3dLabelBox,
  type Graph3dNodeMotion,
  compositeOver,
  parseCssColor,
  rgbaString,
  rgbHex,
  toGraph3dData,
  type Graph3dData,
  type Graph3dLink,
  type Graph3dNode,
  type Graph3dPlanet,
  type Rgba
} from '../../lib/agentGraph3d'
import { useReducedMotion, useWindowWatched } from '../../lib/reducedMotion'
import { useAgentGraphDisplay } from '../../state/agentGraphDisplay'
import { WEBGL_LOST_NOTICE, WEBGL_UNAVAILABLE_NOTICE } from '../../lib/webgl'
import { paintCorona, paintGlow, paintNebula, paintSurface, SURFACE_HEIGHT, SURFACE_WIDTH, tone } from './planetSurface'

/**
 * The agent graph in 3D: the same boxes and lines as the 2D view, as a force layout you can turn. This
 * module is its own chunk, fetched only when the 3D view opens, because three.js is most of its weight.
 *
 * It holds a WebGL context and a frame loop, which is what this view must not leave running: the loop
 * runs only while something can change and somebody can see it (`graph3dLoopShouldRun`), and unmounting
 * disposes the scene, the controls and the renderer and gives the context back.
 */

export interface AgentGraph3DProps {
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
  /** The 2D view's per-event stream: a line's newest event, or 0 when it is older than the view. */
  pulseOf: (ts: number | undefined) => number
  showMachine: boolean
  /** False while something covers the view (the terminal modal). */
  shown: boolean
  onNodeClick: (node: GraphNode) => void
  /** WebGL could not start, or its context was lost: the caller shows the 2D view with this notice. */
  onUnsupported: (notice: string) => void
}

type Graph = ForceGraph3DInstance<Graph3dNode, Graph3dLink>
type LinkWithPhotons = Graph3dLink & { __singleHopPhotonsObj?: { children: unknown[] } }

/** What the card of keys lists, in the order a newcomer needs it. */
const FLY_HELP: ReadonlyArray<readonly [readonly string[], string]> = [
  [['W', 'A', 'S', 'D'], 'Fly around'],
  [['Space', 'Shift'], 'Up and down'],
  [['Drag'], 'Turn the view'],
  [['Scroll'], 'Zoom'],
  [['Click'], 'Open terminal']
]

const FIT_PADDING = 40
const FLY_MS = 600
/** How long the camera may still be settling after the pointer leaves. */
const LEAVE_GRACE_MS = 800
const GATE_CHECK_MS = 250
/** Of a line's length per frame: about a second and a half on a 60 Hz display. */
const PARTICLE_SPEED = 0.011
const LABEL_MAX = 40
/** A name's height on screen, in CSS pixels, whatever its depth or the zoom. */
const LABEL_PX = 22
/** World units between a node's top and the bottom of its name. */
const LABEL_LIFT = 1.2

/** Satellite size and how far out it orbits, as fractions of its box's radius. */
const SATELLITE_RADIUS = 0.2
const SATELLITE_ORBIT = 1.85
/** Radians per second. */
const ORBIT_SPEED = 1.2
const SPIN_SPEED = 0.8
const BREATHE_SPEED = 2.4
/** The current step is drawn this much bigger than its kind. Only drawn: the layout keeps its size. */
const SUN_SCALE = 1.7
/** The corona's width, in the sun's radii. */
const CORONA_SPAN = 15
const GLOW_SPAN = 4
const STARS = 520
const STAR_FIELD = 700

const FALLBACK_TEXT: Rgba = { r: 200, g: 200, b: 200, a: 0.85 }
const FALLBACK_PANEL: Rgba = { r: 40, g: 40, b: 40, a: 1 }
const FALLBACK_LINE: Rgba = { r: 150, g: 150, b: 150, a: 0.6 }

/** A sphere, or for an asteroid a lumpy rock: each corner pushed in or out by where it points, so the
 *  copies of one corner in the unindexed mesh move together and the surface stays closed. */
function geometryFor(planet: Graph3dPlanet, radius: number): BufferGeometry {
  if (planet.surface !== 'asteroid') return new SphereGeometry(radius, 40, 28)
  const rock = new IcosahedronGeometry(radius, 1)
  const at = rock.getAttribute('position')
  const k = 1 + (planet.seed % 7)
  for (let i = 0; i < at.count; i++) {
    const [x, y, z] = [at.array[i * 3], at.array[i * 3 + 1], at.array[i * 3 + 2]].map((v) => v / radius)
    const lump = 1 + 0.2 * Math.sin(x * 3.1 * k + y * 1.7) * Math.cos(z * 2.3 + y * k) - 0.1 * Math.abs(y)
    at.array.set([x * radius * lump, y * radius * lump * 0.85, z * radius * lump], i * 3)
  }
  at.needsUpdate = true
  rock.computeVertexNormals()
  return rock
}

/** The planet's map, or null where there is no 2D canvas (the label sprite's rule). */
function surfaceTexture(planet: Graph3dPlanet, base: Rgba): CanvasTexture | null {
  const canvas = document.createElement('canvas')
  canvas.width = SURFACE_WIDTH
  canvas.height = SURFACE_HEIGHT
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d')
  } catch {
    ctx = null
  }
  if (!ctx) return null
  paintSurface(ctx, planet.surface, base, planet.seed)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

/** Resolves a CSS colour (a role token or a literal) against the live theme, by reading it back from
 *  an element inside the view. Cached until the theme changes. */
function colorResolver(host: HTMLElement): { get(color: string, fallback: Rgba): Rgba; reset(): void; dispose(): void } {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  host.appendChild(probe)
  const cache = new Map<string, Rgba>()
  return {
    get(color, fallback) {
      const hit = cache.get(color)
      if (hit) return hit
      probe.style.color = ''
      probe.style.color = color
      const parsed = (probe.style.color ? parseCssColor(getComputedStyle(probe).color) : null) ?? parseCssColor(color) ?? fallback
      cache.set(color, parsed)
      return parsed
    },
    reset: () => cache.clear(),
    dispose: () => probe.remove()
  }
}

/** Canvas pixels of a one-line name's pill; a caption adds a second, smaller line under it. */
const PILL_HEIGHT = 46
const CAPTION_HEIGHT = 32

function labelSprite(
  text: string,
  ink: Rgba,
  panel: Rgba,
  strong: boolean,
  caption?: { text: string; color: Rgba }
): { sprite: Sprite; aspect: number; tall: number } | null {
  const canvas = document.createElement('canvas')
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d')
  } catch {
    ctx = null
  }
  if (!ctx) return null
  const shown = text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text
  const font = `${strong ? 700 : 600} 30px system-ui, -apple-system, "Segoe UI", sans-serif`
  ctx.font = font
  const height = PILL_HEIGHT + (caption ? CAPTION_HEIGHT : 0)
  const captionFont = '700 22px system-ui, -apple-system, "Segoe UI", sans-serif'
  let width = Math.ceil(ctx.measureText(shown).width) + 28
  if (caption) {
    ctx.font = captionFont
    width = Math.max(width, Math.ceil(ctx.measureText(caption.text).width + caption.text.length * 2) + 28)
  }
  canvas.width = width
  canvas.height = height
  ctx.font = font
  ctx.fillStyle = rgbaString({ ...panel, a: 0.82 })
  ctx.beginPath()
  ctx.roundRect(1, 1, width - 2, height - 2, 12)
  ctx.fill()
  ctx.strokeStyle = rgbaString({ ...ink, a: 0.18 })
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.fillStyle = rgbaString({ ...ink, a: 1 })
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillText(shown, width / 2, PILL_HEIGHT / 2 + 1)
  if (caption) {
    ctx.font = captionFont
    ctx.letterSpacing = '2px'
    ctx.fillStyle = rgbaString({ ...caption.color, a: 1 })
    ctx.fillText(caption.text, width / 2, PILL_HEIGHT + CAPTION_HEIGHT / 2 - 7)
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  // A fixed size on screen, drawn over lines and nodes: a name a line runs through, or one that grows
  // to cover its neighbours as the camera nears it, is what made the turned view hard to read.
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false }))
  sprite.center.set(0.5, 0)
  sprite.renderOrder = 20
  return { sprite, aspect: width / height, tall: height / PILL_HEIGHT }
}

/** A white light painted once and tinted by each sprite that wears it, or null with no 2D canvas. */
function lightTexture(size: number, paint: (ctx: CanvasRenderingContext2D, size: number) => void): CanvasTexture | null {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d')
  } catch {
    ctx = null
  }
  if (!ctx) return null
  paint(ctx, size)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

/** Light round a world, under it in draw order, never taking the pointer. */
function lightSprite(map: CanvasTexture | null): Sprite {
  const sprite = new Sprite(new SpriteMaterial({ map, transparent: true, depthWrite: false }))
  sprite.raycast = noPick
  sprite.renderOrder = -1
  return sprite
}

interface NodeVisual {
  group: Group
  core: Mesh<BufferGeometry, MeshLambertMaterial>
  planet: Graph3dPlanet
  /** Its axial tilt and the face it shows at rest. */
  pose: { tilt: number; turn: number }
  /** What the map was painted from, so it is painted again only when that changes. */
  surfaceKey: string
  atmosphere: Mesh<BufferGeometry, MeshBasicMaterial> | null
  rings: Array<Mesh<BufferGeometry, MeshBasicMaterial>>
  /** The soft light in its own colour round every world. */
  glow: Sprite
  /** This node is the current step, drawn as the sun. */
  sun: boolean
  halo: Mesh<BufferGeometry, MeshBasicMaterial>
  aura: Mesh<BufferGeometry, MeshBasicMaterial>
  /** Turns as one, so each satellite keeps its place on the ring. */
  orbit: Group
  satellites: Array<{ id: string; mesh: Mesh<BufferGeometry, MeshBasicMaterial> }>
  radius: number
  motion: Graph3dNodeMotion
  /** Where in its breath this node starts, so a row of running boxes does not swell in step. */
  phase: number
  label: Sprite | null
  labelKey: string
  labelRank: number
  /** Width over height of the name's pill. */
  labelAspect: number
  /** The name's height on screen, in CSS pixels: taller with a caption. */
  labelPx: number
}

const noPick = (): void => {}
const pickLabel = Sprite.prototype.raycast

const REST: Graph3dNodeMotion = { spin: false, breathe: false, satellites: [] }

/** A fixed scatter of faint points behind the graph. It never moves, so it costs no frames. */
function starField(): Points<BufferGeometry, PointsMaterial> {
  const positions = new Float32Array(STARS * 3)
  // Deterministic, so a remount draws the same sky.
  let seed = 7
  const rand = (): number => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
  for (let i = 0; i < STARS; i++) {
    const u = rand() * 2 - 1
    const t = rand() * Math.PI * 2
    const r = STAR_FIELD * (0.55 + 0.45 * rand())
    const k = Math.sqrt(1 - u * u)
    positions.set([r * k * Math.cos(t), r * u, r * k * Math.sin(t)], i * 3)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  const stars = new Points(geometry, new PointsMaterial({ size: 1.6, sizeAttenuation: true, transparent: true, opacity: 0.35, depthWrite: false }))
  stars.raycast = noPick
  return stars
}

/** A node's light lives outside the node, so it goes when the node does. */
function dropGlow(visual: NodeVisual): void {
  visual.glow.parent?.remove(visual.glow)
  visual.glow.material.dispose()
}

function disposeSprite(sprite: Sprite): void {
  sprite.material.map?.dispose()
  sprite.material.dispose()
}

type Hover = { kind: 'node' | 'link'; id: string } | null

export default function AgentGraph3D({ nodes, edges, pulseOf, showMachine, shown, onNodeClick, onUnsupported }: AgentGraph3DProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  const reduced = useReducedMotion()
  const watched = useWindowWatched()
  const [hover, setHover] = useState<Hover>(null)
  const [pointer, setPointer] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const hoverRef = useRef<Hover>(null)
  hoverRef.current = hover
  const pointerRef = useRef({ x: 0, y: 0 })

  // What the accessors read. The library keeps the accessors it was given, so they read refs and
  // a change of content swaps what the refs hold, not the accessors.
  const nodesById = useRef(new Map<string, GraphNode>())
  const edgesById = useRef(new Map<string, GraphEdge>())
  nodesById.current = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  edgesById.current = useMemo(() => new Map(edges.map((e) => [e.id, e])), [edges])
  const callbacks = useRef({ onNodeClick, onUnsupported })
  callbacks.current = { onNodeClick, onUnsupported }
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced

  const dataRef = useRef<Graph3dData | null>(null)
  const data = useMemo(() => (dataRef.current = toGraph3dData({ nodes: nodes as GraphNode[], edges: edges as GraphEdge[] }, dataRef.current)), [nodes, edges])

  const visuals = useRef(new Map<string, NodeVisual>())
  const palette = useRef<ReturnType<typeof colorResolver> | null>(null)
  const loop = useRef({ running: false, engineRunning: true, pointerInside: false, flying: false, busyUntil: 0, shown, watched, timer: 0 as ReturnType<typeof setInterval> | 0, fitPending: true })
  const flyHelp = useAgentGraphDisplay((s) => s.flyHelp)
  const setFlyHelp = useAgentGraphDisplay((s) => s.setFlyHelp)
  const [focused, setFocused] = useState(false)
  const api = useRef<{ evaluate(): void; wake(ms: number): void; restyle(): void; fit(ms: number): void } | null>(null)

  useEffect(() => {
    const host = hostRef.current
    const sceneEl = sceneRef.current
    if (!host || !sceneEl) return
    const colors = (palette.current = colorResolver(host))
    let graph: Graph
    try {
      graph = new ForceGraph3D(sceneEl, {
        controlType: 'orbit',
        rendererConfig: { antialias: true, alpha: true, powerPreference: 'low-power' }
      }) as unknown as Graph
    } catch {
      colors.dispose()
      palette.current = null
      callbacks.current.onUnsupported(WEBGL_UNAVAILABLE_NOTICE)
      return
    }
    graphRef.current = graph
    const st = loop.current
    st.running = true // the library starts its loop on creation

    const particlesInFlight = (): boolean =>
      (dataRef.current?.links ?? []).some((l) => ((l as LinkWithPhotons).__singleHopPhotonsObj?.children.length ?? 0) > 0)

    // A line in transit sends a particle every STREAM_EVERY_MS, as the 2D marks keep moving along it.
    const lastStream = new Map<string, number>()
    const stream = (now: number): void => {
      if (reducedRef.current || !st.shown || !st.watched) return
      for (const link of dataRef.current?.links ?? []) {
        const edge = edgesById.current.get(link.id)
        if (!edge || !edgeInTransit(edge, now)) continue
        if (now - (lastStream.get(link.id) ?? 0) < STREAM_EVERY_MS) continue
        if (((link as LinkWithPhotons).__singleHopPhotonsObj?.children.length ?? 0) >= MAX_FLOW_DOTS) continue
        lastStream.set(link.id, now)
        graph.emitParticle(link)
      }
    }

    const evaluate = (): void => {
      const now = Date.now()
      const liveMotion = !reducedRef.current && graph3dHasLiveMotion([...nodesById.current.values()], [...edgesById.current.values()], now)
      if (liveMotion) stream(now)
      const run = graph3dLoopShouldRun({
        shown: st.shown,
        watched: st.watched,
        engineRunning: st.engineRunning,
        particlesInFlight: particlesInFlight(),
        liveMotion,
        flying: st.flying,
        pointerInside: st.pointerInside,
        busyUntil: st.busyUntil,
        now
      })
      if (run && !st.running) {
        st.running = true
        // The cooldown is wall-clock from the last data update, and the layout moves only on frames. A
        // layout paused mid-way for longer than the cooldown would stop on its first frame with nothing
        // placed, so it starts its countdown again here, and only here, as the frames come back.
        if (st.engineRunning) graph.d3ReheatSimulation()
        graph.resumeAnimation()
      } else if (!run && st.running) {
        st.running = false
        graph.pauseAnimation()
      }
      if (st.running && !st.timer) st.timer = setInterval(evaluate, GATE_CHECK_MS)
      else if (!st.running && st.timer) {
        clearInterval(st.timer)
        st.timer = 0
      }
    }
    const wake = (ms: number): void => {
      st.busyUntil = Math.max(st.busyUntil, Date.now() + ms)
      evaluate()
    }
    const fit = (ms: number): void => {
      graph.zoomToFit(ms, FIT_PADDING)
      wake(ms + 100)
    }

    const ink = (): Rgba => colors.get('var(--text)', FALLBACK_TEXT)
    const panel = (): Rgba => colors.get('var(--panel)', FALLBACK_PANEL)

    const view = { width: 0, height: 0 }
    const camera = graph.camera() as PerspectiveCamera

    // Flying moves the camera and the point it turns round by the same step, on the frames the held
    // key keeps running; the step shows on the next one.
    const held = new Set<Graph3dFlyMove>()
    let lastFly = 0
    const fly = (): void => {
      if (held.size === 0) {
        lastFly = 0
        return
      }
      const now = performance.now()
      const seconds = lastFly ? (now - lastFly) / 1000 : 1 / 60
      lastFly = now
      const target = (graph.controls() as { target: Vector3 }).target
      const step = graph3dFlyStep(camera.position, target, held, seconds)
      camera.position.set(camera.position.x + step.x, camera.position.y + step.y, camera.position.z + step.z)
      target.set(target.x + step.x, target.y + step.y, target.z + step.z)
    }
    const sizeLabel = (visual: NodeVisual): void => {
      const k = graph3dPixelScale(visual.labelPx, view.height, camera.fov)
      visual.label?.scale.set(k * visual.labelAspect, k, 1)
    }
    // Which names show, from where they land on screen this frame. A name that gives way also stops
    // taking the pointer: the raycaster ignores `visible`, and a hidden name would still catch clicks.
    const at = new Vector3()
    const placeLabels = (): void => {
      const boxes: Graph3dLabelBox[] = []
      for (const [id, visual] of visuals.current) {
        if (!visual.label) continue
        visual.label.getWorldPosition(at).project(camera)
        if (at.z > 1) continue
        const x = ((at.x + 1) / 2) * view.width
        const y = ((1 - at.y) / 2) * view.height
        const width = visual.labelPx * visual.labelAspect
        boxes.push({ id, left: x - width / 2, top: y - visual.labelPx, width, height: visual.labelPx, depth: at.z, rank: visual.labelRank })
      }
      const shown = graph3dShownLabels(boxes)
      for (const [id, visual] of visuals.current) {
        if (!visual.label) continue
        const on = shown.has(id)
        visual.label.visible = on
        visual.label.raycast = on ? pickLabel : noPick
      }
    }

    // Space light, painted once in white and tinted where it is worn.
    const coronaMap = lightTexture(512, paintCorona)
    const glowMap = lightTexture(128, paintGlow)
    const nebulaMaps = [3, 11].map((seed) => lightTexture(512, (ctx, size) => paintNebula(ctx, size, seed)))
    const corona = lightSprite(coronaMap)
    // Light lives outside the nodes and follows them each frame: the library fits the camera to every
    // geometry under a node, and a corona fifteen radii wide would push the whole graph into the distance.
    const lightLayer = new Group()
    lightLayer.add(corona)
    corona.visible = false
    let sunId: string | null = null
    /** Light adds up on a dark sky and vanishes on a pale one, so there it is laid over instead. */
    const darkSky = (): boolean => {
      const p = panel()
      return 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b < 115
    }

    const styleNode = (visual: NodeVisual, node: GraphNode): void => {
      const look = graph3dNodeLook(node)
      const sun = node.id === sunId
      visual.sun = sun
      const base = compositeOver(colors.get(look.color, FALLBACK_LINE), panel())
      const surfaceKey = `${rgbHex(base)}|${visual.planet.surface}|${visual.planet.seed}`
      if (surfaceKey !== visual.surfaceKey) {
        visual.core.material.map?.dispose()
        const map = surfaceTexture(visual.planet, base)
        visual.core.material.map = map
        // The map carries the colour; the material's own colour multiplies it.
        visual.core.material.color.set(map ? '#ffffff' : rgbHex(base))
        visual.core.material.needsUpdate = true
        visual.surfaceKey = surfaceKey
      }
      visual.atmosphere?.material.color.set(rgbHex(tone(base, 0.4)))
      for (const ring of visual.rings) ring.material.color.set(rgbHex(tone(base, 0.3)))
      visual.core.material.opacity = look.faded ? 0.4 : 1
      visual.core.material.transparent = !!look.faded
      if (look.glowColor) {
        const glow = rgbHex(colors.get(look.glowColor, FALLBACK_LINE))
        visual.core.material.emissive.set(glow)
        visual.core.material.emissiveIntensity = 0.35
        visual.halo.material.color.set(glow)
        visual.aura.material.color.set(glow)
      } else {
        visual.core.material.emissiveIntensity = 0
      }
      // The sun's corona is its glow.
      visual.halo.visible = !!look.glow && !sun
      visual.aura.visible = !!look.glow && !sun
      const size = sun ? SUN_SCALE : 1
      visual.core.scale.set(size, size, size)
      visual.orbit.scale.set(size, size, size)
      const dark = darkSky()
      visual.glow.material.color.set(rgbHex(tone(base, 0.15)))
      visual.glow.material.blending = dark ? AdditiveBlending : NormalBlending
      visual.glow.material.opacity = look.faded ? 0.15 : dark ? 0.8 : 0.3
      if (sun) {
        visual.core.material.emissive.set(rgbHex(tone(base, 0.05)))
        corona.material.color.set(rgbHex(tone(base, 0.2)))
        corona.material.blending = dark ? AdditiveBlending : NormalBlending
        corona.material.opacity = dark ? 0.95 : 0.6
        corona.scale.set(visual.radius * SUN_SCALE * CORONA_SPAN, visual.radius * SUN_SCALE * CORONA_SPAN, 1)
        corona.visible = true
      }
      const glowSize = visual.radius * size * GLOW_SPAN
      visual.glow.scale.set(glowSize, glowSize, 1)
      visual.motion = graph3dNodeMotion(node)
      syncSatellites(visual)
      // Sets the pose now, so a box that stopped running rests unswollen even if no frame follows.
      animate(visual)
      const text = ink()
      const back = panel()
      const labelKey = `${look.label}|${look.labelRank}|${sun}|${rgbaString(text)}|${rgbaString(back)}`
      if (labelKey !== visual.labelKey) {
        if (visual.label) {
          visual.group.remove(visual.label)
          disposeSprite(visual.label)
        }
        const caption = sun ? { text: 'CURRENT STEP', color: tone(base, dark ? 0.35 : -0.25) } : undefined
        const made = labelSprite(look.label, text, back, sun || look.labelRank === 0, caption)
        visual.label = made?.sprite ?? null
        visual.labelAspect = made?.aspect ?? 1
        visual.labelPx = LABEL_PX * (made?.tall ?? 1)
        if (visual.label) {
          visual.label.position.set(0, look.radius * size + LABEL_LIFT, 0)
          sizeLabel(visual)
          visual.group.add(visual.label)
        }
        // The current step's name is the one that never gives way.
        visual.labelRank = sun ? -1 : look.labelRank
        visual.labelKey = labelKey
      }
    }

    const satelliteGeometry = new SphereGeometry(1, 14, 10)
    const syncSatellites = (visual: NodeVisual): void => {
      const want = visual.motion.satellites
      const keep = new Set(want)
      for (const sat of visual.satellites.filter((s) => !keep.has(s.id))) {
        visual.orbit.remove(sat.mesh)
        sat.mesh.material.dispose()
      }
      const had = new Map(visual.satellites.filter((s) => keep.has(s.id)).map((s) => [s.id, s]))
      const color = rgbHex(colors.get('var(--state-working)', FALLBACK_LINE))
      visual.satellites = want.map((id) => {
        const old = had.get(id)
        if (old) return old
        const mesh = new Mesh(satelliteGeometry, new MeshBasicMaterial({ color }))
        mesh.raycast = noPick
        const r = visual.radius * SATELLITE_RADIUS
        mesh.scale.set(r, r, r)
        visual.orbit.add(mesh)
        return { id, mesh }
      })
      // Evenly round the ring, tilted in turn, so two satellites never sit on top of each other.
      const n = visual.satellites.length
      visual.satellites.forEach((sat, i) => {
        const a = (i / Math.max(1, n)) * Math.PI * 2
        const d = visual.radius * SATELLITE_ORBIT
        sat.mesh.position.set(Math.cos(a) * d, (i % 2 ? 0.35 : -0.35) * visual.radius, Math.sin(a) * d)
        sat.mesh.material.color.set(color)
      })
    }

    // Per-frame motion: only what `graph3dNodeMotion` says is happening, and nothing under Reduce Motion.
    // It runs only on frames the gate already allows, so it adds no frames of its own.
    const animate = (visual: NodeVisual): void => {
      const { x, y, z } = visual.group.position
      visual.glow.position.set(x, y, z)
      if (visual.sun) corona.position.set(x, y, z)
      const m = reducedRef.current ? REST : visual.motion
      const t = performance.now() / 1000
      // A running world turns on its own tilted axis, as a planet does.
      if (m.spin) visual.core.rotation.set(visual.pose.tilt, visual.pose.turn + t * SPIN_SPEED, 0)
      const k = m.breathe ? 1 + 0.14 * Math.sin(t * BREATHE_SPEED + visual.phase) : 1
      visual.halo.scale.set(k, k, k)
      visual.aura.scale.set(k * k, k * k, k * k)
      visual.aura.material.opacity = m.breathe ? 0.07 + 0.08 * (0.5 + 0.5 * Math.sin(t * BREATHE_SPEED + visual.phase)) : 0.09
      // The sun is lit from within; a glowing world's light breathes with it.
      visual.core.material.emissiveIntensity = visual.sun
        ? 0.75
        : visual.halo.visible
          ? m.breathe
            ? 0.3 + 0.25 * (0.5 + 0.5 * Math.sin(t * BREATHE_SPEED + visual.phase))
            : 0.35
          : 0
      visual.orbit.rotation.set(0.45, reducedRef.current ? 0 : t * ORBIT_SPEED + visual.phase, 0)
    }

    const nodeObject = (n3: Graph3dNode): Object3D => {
      const node = nodesById.current.get(n3.id)
      const look = node ? graph3dNodeLook(node) : { planet: { surface: 'rock' as const, ring: false, atmosphere: false, seed: 0 }, radius: 4 }
      const { planet } = look
      const group = new Group()
      const core = new Mesh(geometryFor(planet, look.radius), new MeshLambertMaterial({ flatShading: planet.surface === 'asteroid' }))
      const pose = graph3dPlanetPose(planet.seed)
      core.rotation.set(pose.tilt, pose.turn, 0)
      // Haze and rings ride on the world, so they tilt with it, and like the glow shells never take the
      // pointer. They are the core's children, so the group keeps its order: core, halo, aura, orbit, name.
      const atmosphere = planet.atmosphere
        ? new Mesh(new SphereGeometry(look.radius * 1.09, 32, 20), new MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false, side: BackSide }))
        : null
      const rings = planet.ring
        ? [
            [1.4, 1.75, 0.55],
            [1.85, 2.15, 0.32]
          ].map(([inner, outer, opacity]) => {
            const ring = new Mesh(new RingGeometry(look.radius * inner, look.radius * outer, 64), new MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, side: DoubleSide }))
            // Flat on the equator, then leaned toward the first view so it reads as a ring, not a line.
            ring.rotation.set(Math.PI / 2 - 0.5, 0, 0)
            return ring
          })
        : []
      const glow = lightSprite(glowMap)
      lightLayer.add(glow)
      for (const extra of [atmosphere, ...rings]) {
        if (!extra) continue
        extra.raycast = noPick
        core.add(extra)
      }
      const halo = new Mesh(new SphereGeometry(look.radius * 1.55, 24, 16), new MeshBasicMaterial({ transparent: true, opacity: 0.26, depthWrite: false, side: BackSide }))
      const aura = new Mesh(new SphereGeometry(look.radius * 2.2, 24, 16), new MeshBasicMaterial({ transparent: true, opacity: 0.09, depthWrite: false, side: BackSide }))
      // The raycaster ignores `visible`, and the library ranks any node hit above any line hit, so a
      // glow shell left pickable would take hovers from the lines near it (whose words show only on
      // hover) and clicks meant for the node behind it. Only what is drawn solid takes the pointer.
      halo.raycast = noPick
      aura.raycast = noPick
      const orbit = new Group()
      group.add(core, halo, aura, orbit)
      const visual: NodeVisual = {
        group,
        core,
        planet,
        pose,
        surfaceKey: '',
        atmosphere,
        rings,
        glow,
        sun: false,
        halo,
        aura,
        orbit,
        satellites: [],
        radius: look.radius,
        motion: REST,
        phase: (visuals.current.size * 1.7) % (Math.PI * 2),
        label: null,
        labelKey: '',
        labelRank: 0,
        labelAspect: 1,
        labelPx: LABEL_PX
      }
      // A satellite can swing out of the view while its box is still in it.
      core.onBeforeRender = () => animate(visual)
      // A node rebuilt as another kind under the same id leaves its old light behind otherwise.
      const old = visuals.current.get(n3.id)
      if (old) dropGlow(old)
      visuals.current.set(n3.id, visual)
      if (node) styleNode(visual, node)
      return group
    }

    const hoverOn = (h: Hover): void => {
      hoverRef.current = h
      setPointer(pointerRef.current)
      setHover(h)
    }

    const linkColor = (l: Graph3dLink): string => {
      const edge = edgesById.current.get(l.id)
      if (!edge) return rgbaString(FALLBACK_LINE)
      const look = graph3dLinkLook(edge)
      const c = colors.get(look.color, FALLBACK_LINE)
      return rgbaString({ ...c, a: c.a * (look.dashed ? DASHED_LINK_ALPHA : 1) })
    }
    const arrowColor = (l: Graph3dLink): string => {
      const edge = edgesById.current.get(l.id)
      return rgbHex(edge ? colors.get(graph3dLinkLook(edge).color, FALLBACK_LINE) : FALLBACK_LINE)
    }
    const particleColor = (l: Graph3dLink): string => arrowColor(l)

    const restyle = (): void => {
      sunId = graph3dCurrentStep([...nodesById.current.values()])
      if (!sunId || !visuals.current.has(sunId)) corona.visible = false
      const dark = darkSky()
      for (const cloud of nebula) {
        cloud.visible = dark
      }
      for (const [id, visual] of visuals.current) {
        const node = nodesById.current.get(id)
        if (node) styleNode(visual, node)
      }
      stars.material.color.set(rgbHex(ink()))
      // Fresh functions make the library re-read the lines' materials; their objects stay.
      graph.linkColor((l) => linkColor(l)).linkDirectionalArrowColor((l) => arrowColor(l))
    }

    graph
      .backgroundColor('rgba(0,0,0,0)')
      .showNavInfo(false)
      .enableNodeDrag(false)
      .nodeLabel(() => '')
      .linkLabel(() => '')
      .nodeThreeObject(nodeObject)
      .linkOpacity(1)
      .linkColor(linkColor)
      .linkWidth((l) => {
        const edge = edgesById.current.get(l.id)
        return edge ? graph3dLinkLook(edge).width : 0.7
      })
      .linkDirectionalArrowLength((l) => {
        const edge = edgesById.current.get(l.id)
        return edge ? graph3dLinkLook(edge).arrowLength : 0
      })
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalArrowColor(arrowColor)
      .linkDirectionalParticleWidth(2.4)
      .linkDirectionalParticleColor(particleColor)
      .linkDirectionalParticleSpeed((l) => (edgesById.current.get(l.id)?.flow === 'reverse' ? -PARTICLE_SPEED : PARTICLE_SPEED))
      .onNodeClick((n) => {
        const node = nodesById.current.get(n.id)
        if (node) callbacks.current.onNodeClick(node)
      })
      .onNodeHover((n) => hoverOn(n ? { kind: 'node', id: n.id } : null))
      .onLinkHover((l) => hoverOn(l ? { kind: 'link', id: l.id } : null))
      .onEngineStop(() => {
        st.engineRunning = false
        if (st.fitPending) {
          st.fitPending = false
          fit(reducedRef.current ? 0 : FLY_MS)
        }
        evaluate()
      })
    // The library's light is mostly ambient, which leaves a sphere a flat disc. A planet needs a lit side
    // and a night side: less ambient, and one sun up and to the left of the first view.
    const sun = new DirectionalLight(0xffffff, 3.6)
    sun.position.set(-0.8, 1, 1.3)
    graph.lights([new AmbientLight(0xffffff, 0.55), sun])
    const stars = starField()
    stars.material.color.set(rgbHex(ink()))
    // The sky is drawn on every frame and never culled, so it carries the once-a-frame label pass.
    stars.frustumCulled = false
    stars.onBeforeRender = () => {
      fly()
      placeLabels()
    }
    graph.scene().add(lightLayer)
    // Dust far behind the graph, warm and cool, as still as the stars. Only on a dark sky.
    const nebula = [
      { map: nebulaMaps[0], at: [-240, 90, -420], size: 760, color: '#ff5a1f', opacity: 0.55 },
      { map: nebulaMaps[1], at: [300, -150, -380], size: 600, color: '#6c3bd1', opacity: 0.45 },
      { map: nebulaMaps[0], at: [60, 260, -460], size: 520, color: '#c2410c', opacity: 0.3 }
    ].map(({ map, at, size, color, opacity }) => {
      const cloud = lightSprite(map)
      cloud.material.blending = AdditiveBlending
      cloud.material.color.set(color)
      cloud.material.opacity = opacity
      cloud.position.set(at[0], at[1], at[2])
      cloud.scale.set(size, size, 1)
      cloud.renderOrder = -2
      cloud.visible = darkSky()
      graph.scene().add(cloud)
      return cloud
    })
    graph.scene().add(stars)

    const engine = graph3dEngineSettings(reducedRef.current)
    graph.warmupTicks(engine.warmupTicks).cooldownTicks(engine.cooldownTicks).cooldownTime(engine.cooldownTime)
    const charge = graph.d3Force('charge') as { strength?: (n: number) => unknown } | undefined
    charge?.strength?.(GRAPH3D_CHARGE)
    for (const [name, force] of Object.entries(graph3dLayoutForces())) graph.d3Force(name, force)

    const canvas = graph.renderer().domElement
    const onLost = (): void => callbacks.current.onUnsupported(WEBGL_LOST_NOTICE)
    canvas.addEventListener('webglcontextlost', onLost)

    const resize = (): void => {
      const { width, height } = host.getBoundingClientRect()
      if (width > 0 && height > 0) {
        graph.width(width).height(height)
        view.width = width
        view.height = height
        for (const visual of visuals.current.values()) sizeLabel(visual)
      }
      wake(100)
    }
    resize()
    const sizeWatch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    sizeWatch?.observe(host)

    const onEnter = (): void => {
      st.pointerInside = true
      evaluate()
    }
    const onLeave = (): void => {
      st.pointerInside = false
      setHover(null)
      wake(LEAVE_GRACE_MS)
    }
    const onMove = (e: PointerEvent): void => {
      const box = host.getBoundingClientRect()
      pointerRef.current = { x: e.clientX - box.left, y: e.clientY - box.top }
      if (hoverRef.current) setPointer(pointerRef.current)
    }
    // The fly keys are the view's own while it has focus, and only those: they stop here, so the board's
    // bare-key commands (Space opens a card) never see them, and every other key, a chord included,
    // goes on to the app as before. A key on one of the view's buttons is that button's.
    const flyKey = (e: KeyboardEvent): Graph3dFlyMove | null => {
      if ((e.target as Element | null)?.closest?.('button, input, a')) return null
      return graph3dFlyMove(e)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      const move = flyKey(e)
      if (!move) return
      e.preventDefault()
      e.stopPropagation()
      held.add(move)
      st.flying = true
      evaluate()
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      const move = flyKey(e)
      if (!move) return
      e.stopPropagation()
      held.delete(move)
      st.flying = held.size > 0
      wake(100)
    }
    // A key let go while focus was elsewhere never sends its keyup here.
    const onBlur = (): void => {
      held.clear()
      st.flying = false
      setFocused(false)
      evaluate()
    }
    const onFocus = (): void => setFocused(true)
    const onDown = (e: PointerEvent): void => {
      if (!(e.target as Element | null)?.closest?.('button, .agent-graph-3d__keys')) host.focus({ preventScroll: true })
    }
    host.addEventListener('keydown', onKeyDown)
    host.addEventListener('keyup', onKeyUp)
    host.addEventListener('blur', onBlur)
    host.addEventListener('focus', onFocus)
    host.addEventListener('pointerdown', onDown)
    host.addEventListener('pointerenter', onEnter)
    host.addEventListener('pointerleave', onLeave)
    host.addEventListener('pointermove', onMove)

    // A theme or accent change re-resolves every colour.
    const themeWatch = new MutationObserver(() => {
      colors.reset()
      restyle()
      wake(200)
    })
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-nt-glass', 'style', 'class'] })

    api.current = { evaluate, wake, restyle, fit }
    evaluate()

    return () => {
      api.current = null
      themeWatch.disconnect()
      sizeWatch?.disconnect()
      host.removeEventListener('keydown', onKeyDown)
      host.removeEventListener('keyup', onKeyUp)
      host.removeEventListener('blur', onBlur)
      host.removeEventListener('focus', onFocus)
      host.removeEventListener('pointerdown', onDown)
      host.removeEventListener('pointerenter', onEnter)
      host.removeEventListener('pointerleave', onLeave)
      host.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('webglcontextlost', onLost)
      if (st.timer) clearInterval(st.timer)
      st.timer = 0
      st.running = false
      const scene = graph.scene()
      const renderer = graph.renderer()
      graph.pauseAnimation()
      // Empties the scene (geometries, materials, textures) and disposes the controls and renderer.
      graph._destructor()
      // `dispose` alone keeps the context: Chromium holds a few per page and evicts the oldest past
      // that, which could be a terminal's.
      renderer.forceContextLoss()
      renderer.domElement.remove()
      // The library publishes its scene as a global for debugging; do not keep it alive.
      const w = window as unknown as { scene?: unknown }
      if (w.scene === scene) delete w.scene
      for (const map of [coronaMap, glowMap, ...nebulaMaps]) map?.dispose()
      for (const sprite of [corona, ...nebula]) sprite.material.dispose()
      for (const visual of visuals.current.values()) {
        visual.glow.material.dispose()
        visual.core.material.map?.dispose()
        if (visual.label) disposeSprite(visual.label)
        for (const sat of visual.satellites) sat.mesh.material.dispose()
      }
      satelliteGeometry.dispose()
      stars.geometry.dispose()
      stars.material.dispose()
      visuals.current.clear()
      colors.dispose()
      palette.current = null
      graphRef.current = null
      sceneEl.innerHTML = ''
    }
  }, [])

  // The structure: a new graph only when boxes or lines come or go.
  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    const keep = new Set(data.nodes.map((n) => n.id))
    for (const [id, visual] of [...visuals.current]) {
      if (keep.has(id)) continue
      dropGlow(visual)
      visuals.current.delete(id)
    }
    graph.graphData(data)
    loop.current.engineRunning = true
    loop.current.fitPending = true
    api.current?.evaluate()
  }, [data])

  // The content: status, counts and colours change in place.
  useEffect(() => {
    api.current?.restyle()
    api.current?.wake(200)
  }, [nodes, edges, showMachine])

  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    const engine = graph3dEngineSettings(reduced)
    graph.warmupTicks(engine.warmupTicks).cooldownTicks(engine.cooldownTicks).cooldownTime(engine.cooldownTime)
  }, [reduced])

  // One particle per new event on a line, as the 2D view's dots: never what happened before this view
  // opened, at most MAX_FLOW_DOTS on one line at once, and none under reduced motion or while nobody
  // can see it travel.
  // Not pruned when a line goes: a line that comes back (a session's Harness line, after it was a ghost)
  // returns with its old `lastEventTs`, which only this map knows was already played. One number per line
  // seen while the view is open, freed with it.
  const seen = useRef<Map<string, number> | null>(null)
  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    const first = seen.current === null
    const last = (seen.current ??= new Map())
    const links = new Map((dataRef.current?.links ?? []).map((l) => [l.id, l]))
    let emitted = false
    for (const edge of edges) {
      const ts = pulseOf(edge.lastEventTs)
      if (ts <= 0 || ts === last.get(edge.id)) continue
      last.set(edge.id, ts)
      if (first || reduced || !watched || !shown) continue
      const link = links.get(edge.id) as LinkWithPhotons | undefined
      if (!link || (link.__singleHopPhotonsObj?.children.length ?? 0) >= MAX_FLOW_DOTS) continue
      graph.emitParticle(link)
      emitted = true
    }
    if (emitted) api.current?.wake(100)
  }, [edges, pulseOf, reduced, watched, shown])

  useEffect(() => {
    loop.current.shown = shown
    loop.current.watched = watched
    api.current?.evaluate()
  }, [shown, watched])

  const tooltip = useMemo((): string[] => {
    if (!hover) return []
    if (hover.kind === 'node') {
      const node = nodesById.current.get(hover.id)
      return node ? graphNodeTextLines(node, showMachine) : []
    }
    const edge = edgesById.current.get(hover.id)
    if (!edge) return []
    return [graphEdgeLabel(edge), graphEdgeTitle(edge) ?? ''].filter(Boolean)
  }, [hover, showMachine, nodes, edges]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="agent-graph-3d"
      ref={hostRef}
      data-testid="agent-graph-3d"
      tabIndex={0}
      role="application"
      aria-label="Agent graph in 3D. Fly with W A S D, Space and Shift; drag to turn."
    >
      <div className="agent-graph-3d__scene" ref={sceneRef} />
      <div className="agent-graph-3d__controls">
        <button
          type="button"
          className="agent-graph__button"
          title="Fit the graph to the view"
          onClick={() => api.current?.fit(reduced ? 0 : FLY_MS)}
        >
          Fit
        </button>
        {!flyHelp && (
          <button type="button" className="agent-graph__button" title="Show the keys that fly the view" onClick={() => setFlyHelp(true)}>
            Keys
          </button>
        )}
      </div>
      {flyHelp && (
        <section className="agent-graph-3d__keys" aria-label="Navigation">
          <header className="agent-graph-3d__keys-head">
            <span>Navigation</span>
            <button type="button" className="agent-graph-3d__keys-hide" title="Hide the keys" aria-label="Hide the keys" onClick={() => setFlyHelp(false)}>
              ×
            </button>
          </header>
          <dl>
            {FLY_HELP.map(([keys, what]) => (
              <div key={what} className="agent-graph-3d__keys-row">
                <dt>{keys.map((k) => <kbd key={k} className="kbd">{k}</kbd>)}</dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
          {/* Always one line, only its words change: a card that grew when focus left the graph moved its
              own close button out from under the pointer between press and release. */}
          <p className="agent-graph-3d__keys-hint">{focused ? 'Keys go to the graph.' : 'Click the graph, then fly.'}</p>
        </section>
      )}
      {tooltip.length > 0 && (
        <div className="agent-graph-3d__tooltip" role="tooltip" style={{ transform: `translate(${pointer.x + 14}px, ${pointer.y + 14}px)` }}>
          {tooltip.map((line, i) => (
            <div key={i} className={i === 0 ? 'agent-graph-3d__tooltip-title' : undefined}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}
