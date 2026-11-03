import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
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
import { AGENT_CONFIG, type BuiltinAgentId } from '@shared/agents/config'
import { IconCanvasView } from '../icons'
import { isWaitRope } from '../../lib/edgeModel'
import { edgeToBridge } from '../../lib/noteLink'
import { markCanvasCovered } from '../../lib/canvasCovered'
import { thisMachine } from '../../lib/machineName'
import {
  agentGraphStructureKey,
  buildAgentGraphModel,
  type DeliveryCounts,
  type GraphEdge,
  type GraphLinkInput,
  type GraphMachine,
  type GraphNode,
  type GraphRopeInput,
  type GraphSessionInput
} from '../../lib/agentGraphModel'
import { agentGraphNodeSize, layoutAgentGraph, routeMidpoint, routeToPath, type GraphPoint } from '../../lib/agentGraphLayout'
import { kanbanSessionsFrom } from '../../canvas/toKanbanSession'
import { ProjectSessionScope } from '../../session/owning-project'
import { SessionContext, useSessionStores } from '../../session/session'
import { useProjects } from '../../state/projects'
import { useStationHandovers, isHandedOver } from '../../state/stationHandovers'
import { useStationOutcomes } from '../../state/stationOutcomes'
import { showCanvas, useViewMode } from '../../state/viewMode'
import type { CanvasNode } from '../../state/workspace'
import { ShipProcessPanel } from './ShipProcessPanel'
import { GraphTerminalModal } from './GraphTerminalModal'
import { useAgentGraphEvents, useShipConfig } from './useAgentGraphData'
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
 * Activity is a FINITE pulse on arrival, never an infinite animation: the first running animation in
 * a window is what costs (CLAUDE.md, "Idle energy"), and an open graph must idle like a closed one.
 */

const STATE_LABEL: Readonly<Record<string, string>> = {
  working: 'working',
  waiting: 'needs you',
  blocked: 'needs you',
  done: 'idle'
}

const DELIVERY_COLOR: Readonly<Record<DeliveryClass, string>> = {
  delivered: 'var(--state-success)',
  queued: 'var(--state-queued)',
  failed: 'var(--state-warning)',
  refused: 'var(--state-error)'
}

/** The line's colour, as a role token (a var on a DOM style, per CLAUDE.md "Semantic colours"). */
export function graphEdgeColor(edge: GraphEdge): string {
  if (edge.kind === 'message') return DELIVERY_COLOR[edge.latest ?? 'delivered']
  if (edge.loop || edge.kind === 'ship-reject') return 'var(--state-attention)'
  if (edge.undeclared) return 'var(--state-warning)'
  if (edge.kind === 'context') return 'var(--state-automation)'
  return 'rgba(var(--tint-rgb), 0.45)'
}

/** The words on a line. A refusal is spelled out, because a colour alone is not a refusal. */
export function graphEdgeLabel(edge: GraphEdge): string {
  if (edge.kind === 'message' && edge.counts) {
    const parts = (Object.keys(edge.counts) as DeliveryClass[])
      .filter((k) => edge.counts![k] > 0)
      .map((k) => `${edge.counts![k]} ${k}`)
    return parts.join(' · ')
  }
  const times = edge.traversals ? ` ×${edge.traversals}` : ''
  // With no file there is no order to have gone against: this could be a rejection or a second run.
  if (edge.loop && edge.kind === 'observed' && !edge.undeclared) return `went back${times}`
  if (edge.loop) return `re-entered${times}`
  if (edge.undeclared) return `not declared${times}`
  if (edge.kind === 'ship-reject') return `reject${times}`
  if (edge.kind === 'context') return 'context'
  if (edge.kind === 'dependency') return 'then' // the rope runs from the awaited node to the waiter
  if (edge.kind === 'opened') return 'opened'
  return times.trim()
}

/** The room a label needs. A message line gets its largest size up front: its words change as counts
 *  do, and the layout deliberately does not. */
function graphEdgeLabelWidth(edge: GraphEdge): number {
  if (edge.kind === 'message') return 210
  const label = graphEdgeLabel(edge)
  return label ? label.length * 6 + 16 : 0
}

type GraphFlowNode = Node<{ node: GraphNode; pulseKey: number }, 'graphNode'>
type GraphFlowEdge = Edge<{ edge: GraphEdge; route: GraphPoint[]; pulseKey: number }, 'graphEdge'>

function agentLabel(agentId: string): string {
  return AGENT_CONFIG[agentId as BuiltinAgentId]?.label ?? agentId
}

const GraphNodeBox = memo(function GraphNodeBox({ data }: NodeProps<GraphFlowNode>) {
  const { node, pulseKey } = data
  const activity = node.state === 'working' ? 'running' : node.activity
  return (
    <div
      className={`agent-graph-node agent-graph-node--${node.kind}`}
      data-activity={activity}
      data-state={node.state}
      data-color={node.color}
      data-reentered={node.reentered || undefined}
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
        {node.agentId && <span className="agent-graph-badge">{agentLabel(node.agentId)}</span>}
        {node.machine && <span className="agent-graph-badge" data-machine={node.machine.kind}>{node.machine.label}</span>}
        {node.state && <span className="agent-graph-badge" data-role="state">{STATE_LABEL[node.state] ?? node.state}</span>}
        {node.handedOver && <span className="agent-graph-badge">handed work</span>}
        {node.outcome && <span className="agent-graph-badge" data-outcome={node.outcome}>{node.outcome}</span>}
        {node.activity === 'stale' && <span className="agent-graph-badge">no recent signal</span>}
        {node.reentered && <span className="agent-graph-badge" data-role="loop">re-entered</span>}
        {node.missingAgent && <span className="agent-graph-badge" data-role="warning" title="Built-in and plugin agents have no file, so this does not mean it cannot run.">no agent file found</span>}
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

const GraphEdgeLine = memo(function GraphEdgeLine({ id, data, markerEnd }: EdgeProps<GraphFlowEdge>) {
  if (!data || data.route.length < 2) return null
  const { edge, route, pulseKey } = data
  const path = routeToPath(route)
  const mid = routeMidpoint(route)
  const color = graphEdgeColor(edge)
  const label = graphEdgeLabel(edge)
  const dashed = edge.kind === 'dependency' || edge.kind === 'context' || edge.kind === 'ship-reject' || edge.undeclared || edge.loop
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: color, strokeWidth: edge.loop ? 2.25 : 1.5, strokeDasharray: dashed ? '5 4' : undefined }}
      />
      {pulseKey > 0 && <path key={pulseKey} d={path} className="agent-graph-edge__pulse" style={{ stroke: color }} />}
      {label && (
        <EdgeLabelRenderer>
          <div
            className="agent-graph-edge__label nodrag nopan"
            data-kind={edge.kind}
            title={edge.reason ? `Refused: ${edge.reason}` : edge.loop && edge.kind === 'observed' && !edge.undeclared ? OBSERVED_LOOP_HINT : undefined}
            style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`, color }}
          >
            {edge.kind === 'message' && edge.counts ? <MessageCounts counts={edge.counts} /> : label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

const OBSERVED_LOOP_HINT = 'With no routing file, a rejection and a second run in the same turn look the same.'

const FIT_OPTIONS = { maxZoom: 1, padding: 0.12 }

const NODE_TYPES: NodeTypes = { graphNode: GraphNodeBox as NodeTypes[string] }
const EDGE_TYPES: EdgeTypes = { graphEdge: GraphEdgeLine as EdgeTypes[string] }

function stickyTitle(text: unknown): string {
  return String(text ?? '').trim().split('\n')[0].replace(/^#{1,6}\s+/, '').trim().slice(0, 60) || 'Note'
}

const LEGEND: ReadonlyArray<{ label: string; color: string; dashed?: boolean }> = [
  { label: 'delivered', color: DELIVERY_COLOR.delivered },
  { label: 'queued', color: DELIVERY_COLOR.queued },
  { label: 'not confirmed', color: DELIVERY_COLOR.failed },
  { label: 'refused', color: DELIVERY_COLOR.refused },
  { label: 'context link', color: 'var(--state-automation)', dashed: true },
  { label: 'reject or went back', color: 'var(--state-attention)', dashed: true },
  { label: 'opened, then, spawned, next', color: 'rgba(var(--tint-rgb), 0.45)' }
]

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
  const [panelOpen, setPanelOpen] = useState(false)
  const [modalId, setModalId] = useState<string | null>(null)
  const ship = shipResult?.ok ? shipResult.config : null

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
    nodes.filter((n) => n.type === 'terminal').map((n) => `${n.id}=${s.byId[n.id]?.state ?? ''}:${s.byId[n.id]?.agentId ?? ''}`).join('|')
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
      data: { node, pulseKey: pulseOf(node.lastEventTs) }
    })),
    [model.nodes, layout, pulseOf]
  )
  const flowEdges = useMemo(
    (): GraphFlowEdge[] => model.edges.map((edge) => ({
      id: edge.id,
      type: 'graphEdge',
      source: edge.source,
      target: edge.target,
      deletable: false,
      selectable: false,
      markerEnd: { type: MarkerType.ArrowClosed, color: graphEdgeColor(edge), width: 14, height: 14 },
      data: { edge, route: layout.routes.get(edge.id) ?? [], pulseKey: pulseOf(edge.lastEventTs) }
    })),
    [model.edges, layout, pulseOf]
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

  const onNodeClick = useCallback(
    (_e: unknown, flowNode: Node) => {
      const node = (flowNode as GraphFlowNode).data.node
      if (node.sessionId) setModalId(node.sessionId)
      else if (node.kind === 'note') onShowOnCanvas(node.id.replace(/^session:/, ''))
    },
    [onShowOnCanvas]
  )

  const openFile = useCallback((path: string, ssh: boolean) => {
    window.dispatchEvent(new CustomEvent('nodeterm:open-file', { detail: { path, ssh } }))
  }, [])

  const warnings = shipResult?.ok ? shipResult.config.warnings.length : 0
  const shipNotice = shipResult && !shipResult.ok ? `Ship config: ${shipResult.reason}` : null
  const notices = shipNotice ? [shipNotice, ...model.notices] : model.notices

  return (
    <div className="agent-graph" role="region" aria-label="Agent graph">
      <div className="agent-graph__header">
        <span className="agent-graph__title">Agent graph</span>
        {ship && (
          <span className="agent-graph__source">
            {ship.graphSource ? `Routing: ${ship.graphSource} ship-graph.json` : 'Routing: observed only'}
          </span>
        )}
        <span className="agent-graph__spacer" />
        <button className="agent-graph__button" aria-pressed={panelOpen} onClick={() => setPanelOpen((v) => !v)}>
          Ship process{warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}
        </button>
        <button className="agent-graph__button" onClick={() => showCanvas(projectId)}>
          <IconCanvasView /> Canvas
        </button>
      </div>
      {notices.length > 0 && (
        <ul className="agent-graph__notices">
          {notices.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      <div className="agent-graph__body">
        <div className="agent-graph__flow">
          {model.nodes.length === 0 ? (
            <div className="agent-graph__empty">
              <p>No agents on this canvas yet.</p>
              <p>Start one and it appears here, with its messages, its subagents and how it moves through your ship process.</p>
            </div>
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
          <ul className="agent-graph__legend" aria-label="Legend">
            {LEGEND.map((l) => (
              <li key={l.label}>
                <span className="agent-graph__swatch" data-dashed={l.dashed || undefined} style={{ borderColor: l.color }} />
                {l.label}
              </li>
            ))}
          </ul>
        </div>
        {panelOpen && (
          <aside className="agent-graph__panel">
            <ShipProcessPanel projectId={projectId} result={shipResult} api={api?.agentGraph} session={session} onReload={reloadShip} onOpenFile={openFile} />
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
export const AgentGraphView = memo(function AgentGraphView(props: AgentGraphViewProps) {
  return (
    <ProjectSessionScope projectId={props.projectId}>
      <ReactFlowProvider>
        <AgentGraphInner {...props} />
      </ReactFlowProvider>
    </ProjectSessionScope>
  )
})
