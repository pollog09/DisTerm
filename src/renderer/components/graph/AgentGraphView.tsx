import { Component, lazy, memo, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes
} from '@xyflow/react'
import { useStore as useZustandStore } from 'zustand'
import type { DeliveryClass } from '@shared/agent-graph'
import { IconCanvasView, IconGraph } from '../icons'
import { isWaitRope } from '../../lib/edgeModel'
import { edgeToBridge } from '../../lib/noteLink'
import { markCanvasCovered } from '../../lib/canvasCovered'
import { thisMachine } from '../../lib/machineName'
import {
  agentGraphStructureKey,
  buildAgentGraphModel,
  edgeShowsDirection,
  type DeliveryCounts,
  type GraphEdge,
  type GraphLinkInput,
  type GraphMachine,
  type GraphNode,
  type GraphRopeInput,
  type GraphSessionInput
} from '../../lib/agentGraphModel'
import { DELIVERY_COLOR, graphEdgeColor, graphEdgeDashed, graphEdgeLabel, graphEdgeTitle, graphLegend } from '../../lib/agentGraphEdgeText'
import { graphNodeBadges, sessionGlow } from '../../lib/agentGraphNodeText'
import {
  agentGraphNodeSize,
  chevronDuration,
  chevronStops,
  layoutAgentGraph,
  MAX_FLOW_DOTS,
  routeLength,
  routeMidpoint,
  routeToPath,
  type GraphPoint
} from '../../lib/agentGraphLayout'
import { SHIP_TEMPLATE_ACTION, SHIP_TEMPLATE_DESCRIPTION, shipTemplateCreatedText, shipTemplateOffer } from '../../lib/shipTemplate'
import { kanbanSessionsFrom } from '../../canvas/toKanbanSession'
import { ProjectSessionScope } from '../../session/owning-project'
import { SessionContext, useSessionStores } from '../../session/session'
import { useProjects } from '../../state/projects'
import { useStationHandovers, isHandedOver } from '../../state/stationHandovers'
import { useStationOutcomes } from '../../state/stationOutcomes'
import { showCanvas, useViewMode } from '../../state/viewMode'
import { useAgentGraphDisplay, type AgentGraphDimension } from '../../state/agentGraphDisplay'
import { GRAPH_3D_LOAD_FAILED_NOTICE, WEBGL_UNAVAILABLE_NOTICE, webglAvailable } from '../../lib/webgl'
import type { CanvasNode } from '../../state/workspace'
import { integrationsOf } from '@shared/agent-integrations'
import { sshHostKey as sshHostKeyOf } from '@shared/ssh'
import { useSettings } from '../../state/settings'
import { HarnessPanel } from './HarnessPanel'
import { ShipProcessPanel } from './ShipProcessPanel'
import { GraphTerminalModal } from './GraphTerminalModal'
import { useAgentGraphEvents, useEdgesInTransit, useShipConfig, useShipTemplate } from './useAgentGraphData'
import './agent-graph.css'

/**
 * A third view of a project, beside the canvas and the board: its sessions as a graph, with what
 * passes between them and how work moved through the machine's ship process. It observes. Nothing
 * here writes to the canvas, and the canvas stays mounted underneath for the same reason it does
 * under the board (see `canvasCovered.ts`).
 *
 * It gets its own `ReactFlowProvider` because the canvas's store has an owner (`flowStoreOwner.ts`):
 * that store is read to decide which project a mounting node belongs to, and handing it these boxes
 * would hand that decision nodes from no project at all.
 *
 * Arrival is a FINITE pulse. The one loop here is the marks moving along a line, and only while
 * something is passing along it (`edgeInTransit`): the first running animation in a window is what costs
 * (CLAUDE.md, "Idle energy"), and an open graph with nothing happening must idle like a closed one.
 */

/** The room a label needs. A message line gets its largest size up front: its words change as counts
 *  do, and the layout deliberately does not. */
function graphEdgeLabelWidth(edge: GraphEdge): number {
  if (edge.kind === 'message') return 210
  const label = graphEdgeLabel(edge)
  return label ? label.length * 6 + 16 : 0
}

type GraphFlowNode = Node<{ node: GraphNode; pulseKey: number; showMachine: boolean }, 'graphNode'>
type GraphFlowEdge = Edge<{ edge: GraphEdge; route: GraphPoint[]; pulseKey: number; inTransit: boolean }, 'graphEdge'>

const GraphNodeBox = memo(function GraphNodeBox({ data }: NodeProps<GraphFlowNode>) {
  const { node, pulseKey, showMachine } = data
  const activity = node.state === 'working' ? 'running' : node.activity
  return (
    <div
      className={`agent-graph-node agent-graph-node--${node.kind}`}
      data-activity={activity}
      data-state={node.state}
      data-color={node.color}
      data-reentered={node.reentered || undefined}
      data-glow={sessionGlow(node)}
      title={node.description}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="agent-graph-node__handle" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="agent-graph-node__handle" />
      {pulseKey > 0 && <span key={pulseKey} className="agent-graph-node__pulse" />}
      <div className="agent-graph-node__title">
        <span className="agent-graph-node__dot" />
        <span className="agent-graph-node__name">{node.title}</span>
        {node.runs ? <span className="agent-graph-node__runs">×{node.runs}</span> : null}
      </div>
      {node.subtitle && <div className="agent-graph-node__subtitle">{node.subtitle}</div>}
      <div className="agent-graph-node__badges">
        {graphNodeBadges(node, showMachine).map((b, i) => (
          <span key={`${i}:${b.text}`} className="agent-graph-badge" data-role={b.role} data-machine={b.machine} data-outcome={b.outcome} title={b.title}>
            {b.text}
          </span>
        ))}
      </div>
    </div>
  )
})

/** A message line's counts, each outcome in its own colour, so a refusal among deliveries still shows. */
export function MessageCounts({ counts }: { counts: DeliveryCounts }) {
  return (
    <>
      {(Object.keys(counts) as DeliveryClass[])
        .filter((k) => counts[k] > 0)
        .map((k, i) => (
          <span key={k} style={{ color: DELIVERY_COLOR[k] }}>
            {i > 0 ? ' · ' : ''}
            {counts[k]} {k}
          </span>
        ))}
    </>
  )
}

export { MAX_FLOW_DOTS }

/**
 * One dot travels along a line per REAL event, once, and stops. Motion means data moved, so there is
 * nothing here that runs on its own: an idle graph has no running animation at all.
 *
 * `ts` is the line's newest event, already refused when older than the view (`pulseOf`), so opening the
 * view flashes nothing. A new `ts` adds a dot; the animation's end removes it. Under reduced motion
 * the dots are not drawn and so never end, which is why the list is capped by what it holds rather than
 * by what has finished.
 *
 * The animation is finite, so it must not read `--nt-anim-state` (CLAUDE.md, "Idle energy"): the
 * covered-canvas gate would freeze a dot mid-line.
 */
export function FlowDots({ ts, path, color, reverse }: { ts: number; path: string; color: string; reverse?: boolean }) {
  const [dots, setDots] = useState<number[]>([])
  const seen = useRef(0)
  useEffect(() => {
    if (ts <= 0 || ts === seen.current) return
    seen.current = ts
    setDots((d) => [...d.filter((k) => k !== ts), ts].slice(-MAX_FLOW_DOTS))
  }, [ts])
  if (dots.length === 0) return null
  return (
    <>
      {dots.map((k) => (
        <circle
          key={k}
          r={3.5}
          className="agent-graph-edge__dot"
          data-reverse={reverse || undefined}
          style={{ fill: color, color, offsetPath: `path("${path}")` }}
          onAnimationEnd={() => setDots((d) => d.filter((x) => x !== k))}
        />
      ))}
    </>
  )
}

/** Drawn pointing along +x; `offset-rotate: auto` turns it to follow the line. */
const CHEVRON_PATH = 'M -3 -3.5 L 2 0 L -3 3.5'

/**
 * The marks that say which way a line runs. They are placed with CSS `offset-path`, not SMIL
 * (`animateMotion`), because `animation-play-state` cannot pause SMIL. Each one rests at its stop, and
 * the negative delay starts a moving one from that same place, so a paused line still reads the same.
 */
function EdgeChevrons({ path, route, color, moving }: { path: string; route: readonly GraphPoint[]; color: string; moving: boolean }) {
  const duration = chevronDuration(routeLength(route))
  return (
    <>
      {chevronStops().map((stop) => (
        <path
          key={stop}
          d={CHEVRON_PATH}
          className="agent-graph-edge__chevron"
          data-moving={moving || undefined}
          style={{
            stroke: color,
            offsetPath: `path("${path}")`,
            offsetDistance: `${stop * 100}%`,
            ...(moving ? { animationDuration: `${duration}s`, animationDelay: `${-stop * duration}s` } : {})
          }}
        />
      ))}
    </>
  )
}

export const GraphEdgeLine = memo(function GraphEdgeLine({ id, data, markerEnd }: EdgeProps<GraphFlowEdge>) {
  if (!data || data.route.length < 2) return null
  const { edge, route, pulseKey, inTransit } = data
  const path = routeToPath(route)
  const mid = routeMidpoint(route)
  const color = graphEdgeColor(edge)
  const label = graphEdgeLabel(edge)
  const dashed = graphEdgeDashed(edge)
  return (
    <>
      <g className="agent-graph-edge">
        <BaseEdge
          id={id}
          path={path}
          markerEnd={markerEnd}
          style={{ stroke: color, strokeWidth: edge.loop ? 2.25 : 1.5, strokeDasharray: dashed ? '5 4' : undefined }}
        />
        {edgeShowsDirection(edge) && routeLength(route) > 0 && <EdgeChevrons path={path} route={route} color={color} moving={inTransit} />}
        {pulseKey > 0 && <path key={pulseKey} d={path} className="agent-graph-edge__pulse" style={{ stroke: color }} />}
        <FlowDots ts={pulseKey} path={path} color={color} reverse={edge.flow === 'reverse'} />
      </g>
      {label && (
        <EdgeLabelRenderer>
          <div
            className="agent-graph-edge__label nodrag nopan"
            data-kind={edge.kind}
            title={graphEdgeTitle(edge)}
            style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`, color }}
          >
            {edge.kind === 'message' && edge.counts ? <MessageCounts counts={edge.counts} /> : label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

/** Shown whenever a file routes the graph: what its loops are, and the two cases hooks cannot tell. */
export const SHIP_LOOP_HINT =
  'Loops are inferred from hook order. A clean second run in one turn reads as a rejection if a reject edge is declared, and a rejection from the last stage to the first is not drawn if only next edges are. Where a stage has a next and a reject edge to the same agent, hooks cannot tell which ran, so both are marked maybe.'
const FIT_OPTIONS = { maxZoom: 1, padding: 0.12 }

/** three.js is most of the 3D view's weight, so it is fetched when that view first opens, never at
 *  startup or for the 2D view. */
const AgentGraph3D = lazy(() => import('./AgentGraph3D'))

/** A 3D chunk that fails to load, or a 3D view that throws, hands back to the 2D view with a notice,
 *  never a blank pane. */
class Graph3DBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(): void {
    this.props.onError()
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

const NODE_TYPES: NodeTypes = { graphNode: GraphNodeBox as NodeTypes[string] }
const EDGE_TYPES: EdgeTypes = { graphEdge: GraphEdgeLine as EdgeTypes[string] }

function stickyTitle(text: unknown): string {
  return String(text ?? '').trim().split('\n')[0].replace(/^#{1,6}\s+/, '').trim().slice(0, 60) || 'Note'
}

/** The header's right padding follows the floating controls cluster, whose width changes with the
 *  presence faces. The cluster itself stays put: maximized nodes measure their free area from it. */
function useControlsClearance(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const header = ref.current
    const cluster = document.querySelector('.controls-cluster')
    if (!header || !cluster) return
    const apply = (): void => {
      header.style.setProperty('--agent-graph-clear', `${Math.ceil(window.innerWidth - cluster.getBoundingClientRect().left)}px`)
    }
    apply()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(apply)
    observer.observe(cluster)
    return () => observer.disconnect()
  }, [ref])
}

export interface AgentGraphViewProps {
  projectId: string
  nodes: readonly CanvasNode[]
  linkEdges: readonly Edge[]
  controlEdges: readonly Edge[]
  /** Leave for the canvas, framed on this node. */
  onShowOnCanvas: (nodeId: string) => void
  /** Tell the canvas a modal is looking at this session (`setKanbanModalNode`). */
  onModalNodeChange: (nodeId: string | null) => void
}

function AgentGraphInner({ projectId, nodes, linkEdges, controlEdges, onShowOnCanvas, onModalNodeChange }: AgentGraphViewProps) {
  // Mount is the signal, the same as the board (`canvasCovered.ts`). Done here, in the view, so a
  // new caller cannot forget it.
  useEffect(() => markCanvasCovered(document.documentElement), [])

  const session = useContext(SessionContext)
  const api = session?.api
  const statusStore = useSessionStores().agentStatus.store
  const projectSsh = useProjects((s) => s.projects.find((p) => p.id === projectId)?.ssh)
  const outcomes = useStationOutcomes((s) => s.byId)
  const handovers = useStationHandovers((s) => s.byId)
  const { snapshot, mountedAt } = useAgentGraphEvents(api, projectId)
  const { result: shipResult, reload: reloadShip } = useShipConfig(api, projectId)
  const template = useShipTemplate(api, projectId, reloadShip)
  const [panel, setPanel] = useState<null | 'harness' | 'ship'>(null)
  const integrations = useSettings((st) => st.settings.agentIntegrations)
  const [modalId, setModalId] = useState<string | null>(null)
  const ship = shipResult?.ok ? shipResult.config : null

  // A remembered 3D on a machine that cannot draw it opens in 2D, saying why; the choice is kept, so a
  // machine that can draw it again needs nothing done. WebGL is probed before the 3D code is fetched.
  const dimension = useAgentGraphDisplay((s) => s.dimension)
  const setDimension = useAgentGraphDisplay((s) => s.setDimension)
  const [fallback, setFallback] = useState<string | null>(() => (dimension === '3d' && !webglAvailable() ? WEBGL_UNAVAILABLE_NOTICE : null))
  const chooseDimension = useCallback(
    (d: AgentGraphDimension) => {
      setDimension(d)
      setFallback(d === '3d' && !webglAvailable() ? WEBGL_UNAVAILABLE_NOTICE : null)
    },
    [setDimension]
  )
  const drawn: AgentGraphDimension = dimension === '3d' && !fallback ? '3d' : '2d'
  const on3dLoadFailed = useCallback(() => setFallback(GRAPH_3D_LOAD_FAILED_NOTICE), [])

  const machineOf = useCallback(
    (node: CanvasNode): GraphMachine => {
      if (session?.source === 'relay') return { kind: 'relay', label: session.label || 'Host' }
      if (projectSsh?.server.host) return { kind: 'ssh', label: projectSsh.server.host }
      const ssh = node.data.ssh as { host?: string } | undefined
      if (ssh?.host) return { kind: 'ssh', label: ssh.host }
      return { kind: 'local', label: thisMachine() }
    },
    [session?.source, session?.label, projectSsh?.server.host]
  )

  // The status map changes on every hook of every node. Only the states of THIS project's sessions
  // reach the model, as one string, the `teamProgressSig` discipline.
  const statusSig = useZustandStore(statusStore, (s) =>
    nodes.filter((n) => n.type === 'terminal').map((n) => `${n.id}=${s.byId[n.id]?.state ?? ''}:${s.byId[n.id]?.agentId ?? ''}:${s.byId[n.id]?.lastEventAt ?? ''}`).join('|')
  )

  const sessions = useMemo((): GraphSessionInput[] => {
    const byId = statusStore.getState().byId
    const out: GraphSessionInput[] = []
    for (const n of nodes) {
      if (n.type === 'terminal') {
        const status = byId[n.id]
        const agentId = (n.data.agentId as string | undefined) ?? status?.agentId
        const outcome = outcomes[n.id]?.outcome
        out.push({
          id: n.id,
          kind: 'terminal',
          title: String(n.data.title ?? ''),
          ...(agentId ? { agentId } : {}),
          machine: machineOf(n),
          ...(status?.state ? { state: status.state } : {}),
          ...(status?.lastEventAt ? { lastStateAt: status.lastEventAt } : {}),
          ...(outcome ? { outcome } : {}),
          ...(isHandedOver(handovers, n.id) ? { handedOver: true } : {})
        })
      } else if (n.type === 'sticky') {
        out.push({ id: n.id, kind: 'note', title: stickyTitle(n.data.text), machine: machineOf(n) })
      }
    }
    return out
    // `statusSig` stands for `byId`: this reads the store's current map whenever a state it shows moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, statusSig, outcomes, handovers, machineOf, statusStore])

  const links = useMemo(
    (): GraphLinkInput[] => linkEdges.map((e) => {
      const b = edgeToBridge(e)
      return { source: b.source, target: b.target, ...(b.reader ? { reader: b.reader } : {}) }
    }),
    [linkEdges]
  )
  const ropes = useMemo(
    (): GraphRopeInput[] => controlEdges.map((e) => ({ source: e.source, target: e.target, wait: isWaitRope(e) })),
    [controlEdges]
  )

  // `now` is only sampled when the model is rebuilt, and a killed subagent sends nothing that would
  // rebuild it. So while a run is open, one timer waits for the moment it goes stale; with none open
  // there is no timer at all, and an idle graph costs what a closed one does.
  const [staleTick, setStaleTick] = useState(0)
  const model = useMemo(
    () => buildAgentGraphModel({ sessions, links, ropes, snapshot, ship, now: Date.now() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, links, ropes, snapshot, ship, staleTick]
  )
  useEffect(() => {
    if (model.nextStaleAt === undefined) return
    const timer = setTimeout(() => setStaleTick((t) => t + 1), Math.max(0, model.nextStaleAt - Date.now()) + 1)
    return () => clearTimeout(timer)
  }, [model.nextStaleAt])

  // Laid out only when the boxes or lines themselves change, so a status change never moves anything.
  const structureKey = agentGraphStructureKey(model)
  const layout = useMemo(
    () => layoutAgentGraph(model.nodes, model.edges.map((e) => ({ ...e, labelWidth: graphEdgeLabelWidth(e) }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structureKey]
  )

  // A new box or line can land outside the frame, so the camera follows the structure, and nothing else.
  const { fitView } = useReactFlow()
  const framed = useRef(structureKey)
  useEffect(() => {
    if (framed.current === structureKey) return
    framed.current = structureKey
    const frame = requestAnimationFrame(() => void fitView(FIT_OPTIONS))
    return () => cancelAnimationFrame(frame)
  }, [structureKey, fitView])

  // One machine is a fact about the whole view, so it is said once in the header, not on every box.
  const machines = useMemo(() => new Map(model.nodes.flatMap((n) => (n.machine ? [[n.machine.label, n.machine] as const] : []))), [model.nodes])
  const showMachine = machines.size > 1
  const onlyMachine = machines.size === 1 ? [...machines.values()][0] : undefined

  const moving = useEdgesInTransit(model.edges)

  const pulseOf = useCallback((ts: number | undefined): number => (ts !== undefined && ts > mountedAt ? ts : 0), [mountedAt])

  const flowNodes = useMemo(
    (): GraphFlowNode[] => model.nodes.map((node) => ({
      id: node.id,
      type: 'graphNode',
      position: layout.positions.get(node.id) ?? { x: 0, y: 0 },
      style: agentGraphNodeSize(node.kind),
      draggable: false,
      connectable: false,
      deletable: false,
      data: { node, pulseKey: pulseOf(node.lastEventTs), showMachine }
    })),
    [model.nodes, layout, pulseOf, showMachine]
  )
  const flowEdges = useMemo(
    (): GraphFlowEdge[] => model.edges.map((edge) => ({
      id: edge.id,
      type: 'graphEdge',
      source: edge.source,
      target: edge.target,
      deletable: false,
      selectable: false,
      // The harness line is a quiet fact about where a session runs, not a flow with a direction.
      ...(edge.kind === 'harness' ? {} : { markerEnd: { type: MarkerType.ArrowClosed, color: graphEdgeColor(edge), width: 14, height: 14 } }),
      data: { edge, route: layout.routes.get(edge.id) ?? [], pulseKey: pulseOf(edge.lastEventTs), inTransit: moving.has(edge.id) }
    })),
    [model.edges, layout, pulseOf, moving]
  )

  const terminals = useMemo(
    () => kanbanSessionsFrom(nodes as CanvasNode[], { ssh: !!projectSsh }).filter((c) => c.kind === 'terminal'),
    [nodes, projectSsh]
  )
  const modalSession = modalId ? terminals.find((t) => t.id === modalId) : undefined

  useEffect(() => {
    onModalNodeChange(modalSession ? modalSession.id : null)
    return () => onModalNodeChange(null)
  }, [modalSession?.id, onModalNodeChange]) // eslint-disable-line react-hooks/exhaustive-deps

  // Every "go to this node" path (the notch's Go, a notification, ⌘K, the sessions sidebar) asks for
  // a card while the canvas is covered. In this view the answer is the same terminal in the same modal.
  const requested = useViewMode((s) => s.requestedCardNodeId)
  useEffect(() => {
    if (!requested) return
    useViewMode.getState().clearCardRequest()
    if (terminals.some((t) => t.id === requested)) setModalId(requested)
    else onShowOnCanvas(requested)
  }, [requested, terminals, onShowOnCanvas])

  const openNode = useCallback(
    (node: GraphNode) => {
      if (node.kind === 'harness' || node.kind === 'skill' || node.kind === 'mcp') setPanel('harness')
      else if (node.sessionId) setModalId(node.sessionId)
      else if (node.kind === 'note') onShowOnCanvas(node.id.replace(/^session:/, ''))
    },
    [onShowOnCanvas]
  )
  const onNodeClick = useCallback((_e: unknown, flowNode: Node) => openNode((flowNode as GraphFlowNode).data.node), [openNode])

  const openFile = useCallback((path: string, ssh: boolean) => {
    window.dispatchEvent(new CustomEvent('nodeterm:open-file', { detail: { path, ssh } }))
  }, [])

  const warnings = shipResult?.ok ? shipResult.config.warnings.length : 0
  const shipNotice = shipResult && !shipResult.ok ? `Ship config: ${shipResult.reason}` : null
  const isEmpty = model.nodes.length === 0
  const offer = isEmpty ? shipTemplateOffer(shipResult) : ({ kind: 'none' } as const)
  const templateFailure = template.result && !template.result.ok ? template.result.message : null
  // What the model notes is about what is drawn, so with nothing drawn only a config failure is left.
  const notices = [...(fallback ? [fallback] : []), ...(shipNotice ? [shipNotice] : []), ...(isEmpty ? [] : model.notices)]
  const legend = useMemo(() => graphLegend(model.edges), [model.edges])
  const headerRef = useRef<HTMLDivElement>(null)
  useControlsClearance(headerRef)

  return (
    <div className="agent-graph" role="region" aria-label="Agent graph">
      <div className="agent-graph__header" ref={headerRef}>
        <div className="agent-graph__heading">
          <span className="agent-graph__title">Agent graph</span>
          {(ship || (onlyMachine && onlyMachine.kind !== 'local')) && (
            <span className="agent-graph__meta">
              {onlyMachine && onlyMachine.kind !== 'local' && <span className="agent-graph__machine">{onlyMachine.label}</span>}
              {ship && (
                <span
                  className="agent-graph__source"
                  title={ship.graphSource ? undefined : 'No ship-graph.json declares an order, so lines come only from what the agents did.'}
                >
                  {ship.graphSource ? `Routing: ${ship.graphSource} ship-graph.json` : 'Routing: observed only'}
                </span>
              )}
            </span>
          )}
        </div>
        <span className="agent-graph__spacer" />
        <div className="agent-graph__switch" role="group" aria-label="Graph view">
          <button className="agent-graph__button" aria-pressed={drawn === '2d'} onClick={() => chooseDimension('2d')}>
            2D
          </button>
          <button className="agent-graph__button" aria-pressed={drawn === '3d'} onClick={() => chooseDimension('3d')}>
            3D
          </button>
        </div>
        <button className="agent-graph__button" aria-pressed={panel === 'harness'} onClick={() => setPanel((p) => (p === 'harness' ? null : 'harness'))}>
          Harness
        </button>
        <button className="agent-graph__button" aria-pressed={panel === 'ship'} onClick={() => setPanel((p) => (p === 'ship' ? null : 'ship'))}>
          Ship process{warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}
        </button>
        <button className="agent-graph__button" onClick={() => showCanvas(projectId)}>
          <IconCanvasView /> Canvas
        </button>
      </div>
      {ship && ship.pipelines.length > 0 && <p className="agent-graph__hint">{SHIP_LOOP_HINT}</p>}
      {notices.length > 0 && (
        <ul className="agent-graph__notices">
          {notices.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      {/* Here, not in the empty state: success ends the empty state, and a failure can too if it got far enough. */}
      {template.result && (template.result.ok || !isEmpty) && (
        <div className="agent-graph__template-note" role={template.result.ok ? 'status' : 'alert'}>
          <span>{template.result.ok ? shipTemplateCreatedText(template.result) : templateFailure}</span>
          <button className="agent-graph__button" onClick={template.dismiss}>Dismiss</button>
        </div>
      )}
      <div className="agent-graph__body">
        <div className="agent-graph__flow">
          {isEmpty ? (
            <div className="agent-graph__empty">
              <span className="agent-graph__empty-icon"><IconGraph /></span>
              <p className="agent-graph__empty-title">No agents on this canvas yet</p>
              <p>Start one and it appears here, with its messages, its subagents and how it moves through your ship process.</p>
              <div className="agent-graph__empty-actions">
                <button className="agent-graph__button" onClick={() => showCanvas(projectId)}>
                  <IconCanvasView /> Go to canvas
                </button>
                {offer.kind !== 'none' && (
                  <button
                    className="agent-graph__button"
                    disabled={offer.kind === 'disabled' || template.busy}
                    onClick={template.create}
                  >
                    {template.busy ? 'Setting up…' : SHIP_TEMPLATE_ACTION}
                  </button>
                )}
              </div>
              {offer.kind !== 'none' && <p className="agent-graph__empty-note">{SHIP_TEMPLATE_DESCRIPTION}</p>}
              {offer.kind === 'disabled' && <p className="agent-graph__empty-note" data-role="reason">{offer.reason}</p>}
              {templateFailure && <p className="agent-graph__empty-note" data-role="failure" role="alert">{templateFailure}</p>}
            </div>
          ) : drawn === '3d' ? (
            <Graph3DBoundary onError={on3dLoadFailed}>
              <Suspense fallback={<div className="agent-graph-3d agent-graph-3d--loading">Loading the 3D view…</div>}>
                <AgentGraph3D
                  nodes={model.nodes}
                  edges={model.edges}
                  pulseOf={pulseOf}
                  showMachine={showMachine}
                  shown={!modalSession}
                  onNodeClick={openNode}
                  onUnsupported={setFallback}
                />
              </Suspense>
            </Graph3DBoundary>
          ) : (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodeClick={onNodeClick}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              fitView
              fitViewOptions={FIT_OPTIONS}
              minZoom={0.2}
              maxZoom={1.5}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} size={1} />
              <Controls showInteractive={false} position="top-left" fitViewOptions={FIT_OPTIONS} />
            </ReactFlow>
          )}
          {legend.length > 0 && (
            <ul className="agent-graph__legend" aria-label="Legend">
              {legend.map((l) => (
                <li key={l.label}>
                  <span className="agent-graph__swatch" data-dashed={l.dashed || undefined} style={{ borderColor: l.color }} />
                  {l.label}
                </li>
              ))}
            </ul>
          )}
        </div>
        {panel === 'ship' && (
          <aside className="agent-graph__panel">
            <ShipProcessPanel projectId={projectId} result={shipResult} api={api?.agentGraph} session={session} onReload={reloadShip} onOpenFile={openFile} />
          </aside>
        )}
        {panel === 'harness' && (
          <aside className="agent-graph__panel" aria-label="Harness">
            <HarnessPanel
              model={model}
              result={shipResult}
              session={session}
              integrations={integrationsOf({ agentIntegrations: integrations })}
              sshHostKey={projectSsh?.server ? sshHostKeyOf(projectSsh.server) : null}
              onReload={reloadShip}
            />
          </aside>
        )}
      </div>
      {modalSession && (
        <GraphTerminalModal
          session={modalSession}
          projectId={projectId}
          onClose={() => setModalId(null)}
          onShowOnCanvas={() => {
            setModalId(null)
            onShowOnCanvas(modalSession.id)
          }}
        />
      )}
    </div>
  )
}

/**
 * The view renders under Canvas, whose context is the LOCAL session, so a team tab's graph has to be
 * scoped to its project or it would read this machine's core about the host's nodes.
 */
export { graphEdgeColor, graphEdgeLabel, graphEdgeTitle }

export const AgentGraphView = memo(function AgentGraphView(props: AgentGraphViewProps) {
  return (
    <ProjectSessionScope projectId={props.projectId}>
      <ReactFlowProvider>
        <AgentGraphInner {...props} />
      </ReactFlowProvider>
    </ProjectSessionScope>
  )
})
