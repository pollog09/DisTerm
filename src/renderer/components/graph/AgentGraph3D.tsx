import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph'
import {
  BackSide,
  BoxGeometry,
  CanvasTexture,
  DodecahedronGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OctahedronGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TetrahedronGeometry,
  type BufferGeometry,
  type Object3D
} from 'three'
import type { GraphEdge, GraphNode } from '../../lib/agentGraphModel'
import { graphEdgeLabel, graphEdgeTitle } from '../../lib/agentGraphEdgeText'
import { MAX_FLOW_DOTS } from '../../lib/agentGraphLayout'
import { graphNodeTextLines } from '../../lib/agentGraphNodeText'
import {
  DASHED_LINK_ALPHA,
  graph3dEngineSettings,
  graph3dLinkLook,
  graph3dLoopShouldRun,
  graph3dNodeLook,
  parseCssColor,
  rgbaString,
  rgbHex,
  toGraph3dData,
  type Graph3dData,
  type Graph3dLink,
  type Graph3dNode,
  type Graph3dShape,
  type Rgba
} from '../../lib/agentGraph3d'
import { useReducedMotion, useWindowWatched } from '../../lib/reducedMotion'
import { WEBGL_LOST_NOTICE, WEBGL_UNAVAILABLE_NOTICE } from '../../lib/webgl'

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

const FIT_PADDING = 40
const FLY_MS = 600
/** How long the camera may still be settling after the pointer leaves. */
const LEAVE_GRACE_MS = 800
const GATE_CHECK_MS = 250
/** Of a line's length per frame: about a second and a half on a 60 Hz display. */
const PARTICLE_SPEED = 0.011
const LABEL_MAX = 40
const LABEL_HEIGHT = 5.5

const FALLBACK_TEXT: Rgba = { r: 200, g: 200, b: 200, a: 0.85 }
const FALLBACK_PANEL: Rgba = { r: 40, g: 40, b: 40, a: 1 }
const FALLBACK_LINE: Rgba = { r: 150, g: 150, b: 150, a: 0.6 }

function geometryFor(shape: Graph3dShape, radius: number): BufferGeometry {
  switch (shape) {
    case 'icosahedron':
      return new IcosahedronGeometry(radius, 0)
    case 'dodecahedron':
      return new DodecahedronGeometry(radius, 0)
    case 'octahedron':
      return new OctahedronGeometry(radius, 0)
    case 'tetrahedron':
      return new TetrahedronGeometry(radius, 0)
    case 'box':
      return new BoxGeometry(radius * 1.5, radius * 1.5, radius * 1.5)
    default:
      return new SphereGeometry(radius, 28, 18)
  }
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

function labelSprite(text: string, ink: Rgba, panel: Rgba): Sprite | null {
  const canvas = document.createElement('canvas')
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d')
  } catch {
    ctx = null
  }
  if (!ctx) return null
  const shown = text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text
  const font = '600 30px system-ui, -apple-system, "Segoe UI", sans-serif'
  ctx.font = font
  const height = 46
  const width = Math.ceil(ctx.measureText(shown).width) + 28
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
  ctx.fillText(shown, 14, height / 2 + 1)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false }))
  sprite.scale.set((width / height) * LABEL_HEIGHT, LABEL_HEIGHT, 1)
  sprite.renderOrder = 20
  return sprite
}

interface NodeVisual {
  group: Group
  core: Mesh<BufferGeometry, MeshLambertMaterial>
  halo: Mesh<BufferGeometry, MeshBasicMaterial>
  aura: Mesh<BufferGeometry, MeshBasicMaterial>
  label: Sprite | null
  labelKey: string
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
  const loop = useRef({ running: false, engineRunning: true, pointerInside: false, busyUntil: 0, shown, watched, timer: 0 as ReturnType<typeof setInterval> | 0, fitPending: true })
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

    const evaluate = (): void => {
      const run = graph3dLoopShouldRun({
        shown: st.shown,
        watched: st.watched,
        engineRunning: st.engineRunning,
        particlesInFlight: particlesInFlight(),
        pointerInside: st.pointerInside,
        busyUntil: st.busyUntil,
        now: Date.now()
      })
      if (run && !st.running) {
        st.running = true
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

    const styleNode = (visual: NodeVisual, node: GraphNode): void => {
      const look = graph3dNodeLook(node)
      const base = colors.get(look.color, FALLBACK_LINE)
      visual.core.material.color.set(rgbHex(base))
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
      visual.halo.visible = !!look.glow
      visual.aura.visible = !!look.glow
      const text = ink()
      const back = panel()
      const labelKey = `${look.label}|${rgbaString(text)}|${rgbaString(back)}`
      if (labelKey !== visual.labelKey) {
        if (visual.label) {
          visual.group.remove(visual.label)
          disposeSprite(visual.label)
        }
        visual.label = labelSprite(look.label, text, back)
        if (visual.label) {
          visual.label.position.set(0, look.radius + LABEL_HEIGHT * 0.9, 0)
          visual.group.add(visual.label)
        }
        visual.labelKey = labelKey
      }
    }

    const nodeObject = (n3: Graph3dNode): Object3D => {
      const node = nodesById.current.get(n3.id)
      const look = node ? graph3dNodeLook(node) : { shape: 'sphere' as const, radius: 4 }
      const group = new Group()
      const core = new Mesh(geometryFor(look.shape, look.radius), new MeshLambertMaterial({ flatShading: look.shape !== 'sphere' }))
      const halo = new Mesh(new SphereGeometry(look.radius * 1.55, 24, 16), new MeshBasicMaterial({ transparent: true, opacity: 0.26, depthWrite: false, side: BackSide }))
      const aura = new Mesh(new SphereGeometry(look.radius * 2.2, 24, 16), new MeshBasicMaterial({ transparent: true, opacity: 0.09, depthWrite: false, side: BackSide }))
      group.add(core, halo, aura)
      const visual: NodeVisual = { group, core, halo, aura, label: null, labelKey: '' }
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
      for (const [id, visual] of visuals.current) {
        const node = nodesById.current.get(id)
        if (node) styleNode(visual, node)
      }
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
        return edge ? graph3dLinkLook(edge).width : 0.45
      })
      .linkDirectionalArrowLength((l) => {
        const edge = edgesById.current.get(l.id)
        return edge && graph3dLinkLook(edge).arrow ? 3.2 : 0
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
    const engine = graph3dEngineSettings(reducedRef.current)
    graph.warmupTicks(engine.warmupTicks).cooldownTicks(engine.cooldownTicks).cooldownTime(engine.cooldownTime)
    const charge = graph.d3Force('charge') as { strength?: (n: number) => unknown } | undefined
    charge?.strength?.(-140)

    const canvas = graph.renderer().domElement
    const onLost = (): void => callbacks.current.onUnsupported(WEBGL_LOST_NOTICE)
    canvas.addEventListener('webglcontextlost', onLost)

    const resize = (): void => {
      const { width, height } = host.getBoundingClientRect()
      if (width > 0 && height > 0) graph.width(width).height(height)
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
      for (const visual of visuals.current.values()) if (visual.label) disposeSprite(visual.label)
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
    for (const id of [...visuals.current.keys()]) if (!keep.has(id)) visuals.current.delete(id)
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
    <div className="agent-graph-3d" ref={hostRef} data-testid="agent-graph-3d">
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
      </div>
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
