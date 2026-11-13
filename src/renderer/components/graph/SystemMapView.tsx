import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import type { AgentGraphEvent } from '@shared/agent-graph'
import type { SystemMapCommit, SystemMapFileCheck, SystemMapRead } from '@shared/system-map'
import type { AgentGraphApi } from '@shared/types'
import { IconGraph } from '../icons'
import type { AgentGraphDimension } from '../../state/agentGraphDisplay'
import type { GraphEdge, GraphNode } from '../../lib/agentGraphModel'
import type { Vec3 } from '../../lib/agentGraph3d'
import { routeMidpoint, routeToPath, type GraphPoint } from '../../lib/agentGraphLayout'
import {
  SYSTEM_MAP_SPEEDS,
  buildSystemMapPicture,
  systemMapPlaySteps,
  systemMapStepMs,
  systemMapStructureKey,
  type SystemMapBox,
  type SystemMapLine,
  type SystemMapPlayStep,
  type SystemMapSelection,
  type SystemMapSpeed
} from '../../lib/systemMapModel'
import { layoutSystemMap, PART_H, PART_W } from '../../lib/systemMapLayout'
import { systemMapLineText, systemMapPartText, systemMapTo3d } from '../../lib/systemMap3d'
import { useSystemMap } from './useAgentGraphData'
import './system-map.css'

/**
 * The graph view's second picture: the repo's system map (`docs/system-map.json`), drawn as columns of
 * parts with their links, and flows you can play step by step (CLAUDE.md "System map" in
 * docs/reference/agent-graph.md). DisTerm only READS the file; an agent writes it.
 *
 * Idle energy: nothing plays when it opens, a flow plays once and stops, and with nothing selected there
 * is no timer and no animation at all. A lit part is a static glow; the only timer then is the one that
 * puts it out when the touch goes stale.
 *
 * It wraps its own `ReactFlowProvider`, for the reason the agent graph has one: the canvas's store has
 * an owner, and these boxes are nodes of no project.
 */

export interface SystemMapViewProps {
  projectId: string
  api: AgentGraphApi | undefined
  /** The agent graph snapshot's events. */
  events: readonly AgentGraphEvent[]
  /** This project's terminals: id -> title. */
  sessions: ReadonlyMap<string, string>
  drawn: AgentGraphDimension
  render3d: (scene: {
    nodes: GraphNode[]
    edges: GraphEdge[]
    pinned: ReadonlyMap<string, Vec3>
    describeNode: (n: GraphNode) => string[]
    describeEdge: (e: GraphEdge) => string[]
  }) => ReactNode
  onMapThisRepo: () => void
  /** Header text the parent shows: map title and commit line, or null. */
  onHeading: (heading: { title: string; commit: string } | null) => void
}

export const SYSTEM_MAP_EMPTY_TITLE = 'No system map in this repo yet'
export const SYSTEM_MAP_EMPTY_TEXT =
  'A system map shows how this repo is built: its callers, services, stores, workers and outside services, the links between them, and flows you can play step by step. An agent writes it to docs/system-map.json; DisTerm only reads it.'
export const SYSTEM_MAP_ACTION = 'Map this repo'
export const SYSTEM_MAP_ACTION_NOTE = 'Opens a Claude session on the canvas with a prompt to write the map, so you can watch it work.'
export const SYSTEM_MAP_PROBLEMS_TITLE = 'The system map has problems'

const FIT_OPTIONS = { maxZoom: 1, padding: 0.12 }
const NOTHING_SELECTED = 'Pick a flow to play it.'

function commitText(commit: SystemMapCommit | null): string {
  return commit ? `Last changed in ${commit.sha.slice(0, 7)}, ${new Date(commit.ts).toLocaleDateString()}` : 'Not committed yet'
}

function stepsText(n: number): string {
  return n === 1 ? '1 step' : `${n} steps`
}

const FILE_CHECK_NOTE: Partial<Record<SystemMapFileCheck, string>> = {
  'not-git': 'Parts were not checked against files: not a git repository.',
  'too-many-files': 'Parts were not checked against files: more than 50000 files.',
  failed: 'Parts were not checked against files: the file list could not be read.',
  'over-budget': "Parts were not checked against files: the map's globs were too costly to check."
}

type PartFlowNode = Node<{ box: SystemMapBox; now: number }, 'systemMapPart'>
type LineFlowEdge = Edge<
  { line: SystemMapLine; route: GraphPoint[]; active: SystemMapPlayStep[]; dotKey: string; dotMs: number },
  'systemMapLine'
>

const PartBox = memo(function PartBox({ data }: NodeProps<PartFlowNode>) {
  const { box, now } = data
  return (
    <div
      className="system-map-part"
      data-kind={box.kind}
      data-live={box.touchers.length > 0 || undefined}
      data-empty={box.noFiles || undefined}
      title={systemMapPartText(box, now).join('\n')}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="system-map-part__handle" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="system-map-part__handle" />
      <div className="system-map-part__label">{box.label}</div>
      {box.subtitle && <div className="system-map-part__subtitle">{box.subtitle}</div>}
      {box.noFiles && <span className="system-map-part__badge">no files</span>}
    </div>
  )
})

const LineEdge = memo(function LineEdge({ id, data, markerEnd }: EdgeProps<LineFlowEdge>) {
  if (!data || data.route.length < 2) return null
  const { line, route, active, dotKey, dotMs } = data
  const path = routeToPath(route)
  const mid = routeMidpoint(route)
  return (
    <>
      <g className="system-map-line" data-implied={line.implied || undefined} data-active={active.length > 0 || undefined}>
        <BaseEdge id={id} path={path} markerEnd={markerEnd} />
        {active.map((step) => (
          <circle
            key={`${dotKey}:${step.flowId}`}
            r={4}
            className="system-map-dot"
            data-mark={step.mark}
            data-reverse={step.reverse || undefined}
            style={{ offsetPath: `path("${path}")`, animationDuration: `${dotMs}ms` }}
          />
        ))}
      </g>
      {line.label && (
        <EdgeLabelRenderer>
          <div
            className="system-map-line__label nodrag nopan"
            data-implied={line.implied || undefined}
            style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}
          >
            {line.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

const NODE_TYPES: NodeTypes = { systemMapPart: PartBox as NodeTypes[string] }
const EDGE_TYPES: EdgeTypes = { systemMapLine: LineEdge as EdgeTypes[string] }

type ValidRead = Extract<SystemMapRead, { kind: 'valid' }>

function SystemMapPictureView({ read, events, projectId, sessions, drawn, render3d }: Pick<SystemMapViewProps, 'events' | 'projectId' | 'sessions' | 'drawn' | 'render3d'> & { read: ValidRead }) {
  // `now` is sampled when the picture is rebuilt; a lit part with nothing new to rebuild it goes dark
  // through one timer set for the moment its touch goes stale, and with nothing lit there is none.
  const [fadeTick, setFadeTick] = useState(0)
  const { picture, builtAt } = useMemo(() => {
    const now = Date.now()
    return {
      builtAt: now,
      picture: buildSystemMapPicture({ map: read.map, emptyParts: read.emptyParts, events, projectId, sessions, now })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read, events, projectId, sessions, fadeTick])
  useEffect(() => {
    if (picture.nextFadeAt === undefined) return
    const timer = setTimeout(() => setFadeTick((t) => t + 1), Math.max(0, picture.nextFadeAt - Date.now()) + 1)
    return () => clearTimeout(timer)
  }, [picture.nextFadeAt])

  const structureKey = systemMapStructureKey(picture)
  const layout = useMemo(
    () => layoutSystemMap(picture.boxes, picture.lines, picture.columns.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structureKey]
  )

  // Playback. Nothing is selected on open, so nothing plays; a new structure starts over from nothing.
  const [selection, setSelection] = useState<SystemMapSelection | null>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<SystemMapSpeed>(1)
  const [restart, setRestart] = useState(0)
  const seenStructure = useRef(structureKey)
  useEffect(() => {
    if (seenStructure.current === structureKey) return
    seenStructure.current = structureKey
    setSelection(null)
    setIndex(0)
    setPlaying(false)
  }, [structureKey])

  const steps = useMemo(
    () => (selection ? systemMapPlaySteps(read.map, picture.lines, selection) : []),
    [read.map, picture.lines, selection]
  )
  const selected = steps.length > 0
  const at = Math.min(index, Math.max(0, steps.length - 1))
  const active = useMemo(() => (selected ? steps[at] : []), [selected, steps, at])
  const stepMs = systemMapStepMs(speed)

  // One timer while playing. After the last step it stops, and the last step stays shown.
  useEffect(() => {
    if (!playing || !selected) return
    const timer = setTimeout(() => {
      if (at >= steps.length - 1) setPlaying(false)
      else setIndex(at + 1)
    }, stepMs)
    return () => clearTimeout(timer)
  }, [playing, selected, at, steps.length, stepMs, restart])

  const pick = useCallback((next: SystemMapSelection) => {
    setSelection(next)
    setIndex(0)
    setPlaying(true)
    setRestart((r) => r + 1)
  }, [])
  const go = useCallback(
    (to: number) => {
      setIndex(Math.max(0, Math.min(steps.length - 1, to)))
      setRestart((r) => r + 1)
    },
    [steps.length]
  )
  const togglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false)
      return
    }
    if (at >= steps.length - 1) {
      setIndex(0)
      setRestart((r) => r + 1)
    }
    setPlaying(true)
  }, [playing, at, steps.length])

  const selectionKey = selection ? (selection.kind === 'all' ? 'all' : `flow:${selection.flowId}`) : ''
  const dotKey = `${selectionKey}:${at}:${restart}`
  // When the shown step started, for the 3D view's particles. Re-sampled per step and per restart only.
  const stepStartedAt = useMemo(() => Date.now(), [dotKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // 2D: the camera follows the structure, and nothing else.
  const { fitView } = useReactFlow()
  const framed = useRef(structureKey)
  useEffect(() => {
    if (framed.current === structureKey) return
    framed.current = structureKey
    const frame = requestAnimationFrame(() => void fitView(FIT_OPTIONS))
    return () => cancelAnimationFrame(frame)
  }, [structureKey, fitView])

  const flowNodes = useMemo(
    (): PartFlowNode[] =>
      picture.boxes.map((box) => ({
        id: box.id,
        type: 'systemMapPart',
        position: layout.positions.get(box.id) ?? { x: 0, y: 0 },
        style: { width: PART_W, height: PART_H },
        draggable: false,
        connectable: false,
        deletable: false,
        data: { box, now: builtAt }
      })),
    [picture.boxes, layout, builtAt]
  )
  const activeByLine = useMemo(() => {
    const m = new Map<string, SystemMapPlayStep[]>()
    for (const s of active) m.set(s.lineId, [...(m.get(s.lineId) ?? []), s])
    return m
  }, [active])
  const flowEdges = useMemo(
    (): LineFlowEdge[] =>
      picture.lines.map((line) => ({
        id: line.id,
        type: 'systemMapLine',
        source: line.from,
        target: line.to,
        deletable: false,
        selectable: false,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        data: { line, route: layout.routes.get(line.id) ?? [], active: activeByLine.get(line.id) ?? [], dotKey, dotMs: stepMs * 0.85 }
      })),
    [picture.lines, layout, activeByLine, dotKey, stepMs]
  )

  const scene = useMemo(() => {
    if (drawn !== '3d') return null
    const { nodes, edges, pinned } = systemMapTo3d(picture, active, stepStartedAt)
    const boxById = new Map(picture.boxes.map((b) => [`part:${b.id}`, b]))
    const lineById = new Map(picture.lines.map((l) => [l.id, l]))
    return {
      nodes,
      edges,
      pinned,
      describeNode: (n: GraphNode): string[] => {
        const box = boxById.get(n.id)
        return box ? systemMapPartText(box, Date.now()) : []
      },
      describeEdge: (e: GraphEdge): string[] => {
        const line = lineById.get(e.id)
        return line ? systemMapLineText(line, picture.boxes) : []
      }
    }
  }, [drawn, picture, active, stepStartedAt])

  const labelOf = useCallback((id: string) => picture.boxes.find((b) => b.id === id)?.label ?? id, [picture.boxes])
  const longest = useMemo(() => read.map.flows.reduce((max, f) => Math.max(max, f.steps.length), 0), [read.map.flows])
  const hasImplied = picture.lines.some((l) => l.implied)
  const fileNote = FILE_CHECK_NOTE[read.fileCheck]
  const isAll = selection?.kind === 'all'

  return (
    <div className="system-map">
      <aside className="system-map__flows" aria-label="Flows">
        <button
          type="button"
          className="system-map__flow"
          aria-pressed={isAll}
          disabled={longest === 0}
          onClick={() => pick({ kind: 'all' })}
        >
          <span className="system-map__flow-name">Everything at once</span>
          <span className="system-map__flow-steps">{stepsText(longest)}</span>
        </button>
        {picture.groups.map((g) => (
          <section key={g.group} className="system-map__group">
            <h3 className="system-map__group-title">{g.group}</h3>
            {g.flows.map((f) => (
              <button
                key={f.id}
                type="button"
                className="system-map__flow"
                aria-pressed={selection?.kind === 'flow' && selection.flowId === f.id}
                onClick={() => pick({ kind: 'flow', flowId: f.id })}
              >
                <span className="system-map__flow-name">{f.name}</span>
                <span className="system-map__flow-steps">{stepsText(f.steps)}</span>
              </button>
            ))}
          </section>
        ))}
      </aside>
      <div className="system-map__main">
        <div className="system-map__canvas">
          {drawn === '3d' && scene ? (
            render3d(scene)
          ) : (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
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
        </div>
        <div className="system-map__player" role="group" aria-label="Player" title={selected ? undefined : NOTHING_SELECTED}>
          <button type="button" className="agent-graph__button" aria-label="Previous step" disabled={!selected || at === 0} onClick={() => go(at - 1)}>
            Back
          </button>
          <button type="button" className="agent-graph__button" disabled={!selected} onClick={togglePlay}>
            {playing && selected ? 'Pause' : 'Play'}
          </button>
          <button
            type="button"
            className="agent-graph__button"
            aria-label="Next step"
            disabled={!selected || at >= steps.length - 1}
            onClick={() => go(at + 1)}
          >
            Forward
          </button>
          <div className="agent-graph__switch" role="group" aria-label="Speed">
            {SYSTEM_MAP_SPEEDS.map((s) => (
              <button key={s} type="button" className="agent-graph__button" aria-pressed={speed === s} disabled={!selected} onClick={() => setSpeed(s)}>
                {s}x
              </button>
            ))}
          </div>
          <span className="system-map__step" aria-live="polite">
            {selected ? `Step ${at + 1} of ${steps.length}` : NOTHING_SELECTED}
          </span>
        </div>
      </div>
      <aside className="system-map__side" aria-label="System map details">
        <section>
          <h3 className="system-map__side-title">What is moving</h3>
          {active.length === 0 ? (
            <p className="system-map__quiet">Nothing is moving.</p>
          ) : (
            <ul className="system-map__moving">
              {active.map((s) => (
                <li key={`${s.flowId}:${s.index}`}>
                  <div className="system-map__moving-head">
                    {isAll ? `${s.flowName} · ` : ''}
                    {labelOf(s.from)} → {labelOf(s.to)}
                  </div>
                  <div className="system-map__moving-label">{s.label}</div>
                  {s.mark && <span className="system-map__tag" data-mark={s.mark}>{s.mark}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3 className="system-map__side-title">Legend</h3>
          <ul className="system-map__legend">
            <li><span className="system-map__key" data-kind="caller" />Caller</li>
            <li><span className="system-map__key" data-kind="service" />Service</li>
            <li><span className="system-map__key" data-kind="store" />Store</li>
            <li><span className="system-map__key" data-kind="worker" />Worker</li>
            <li><span className="system-map__key" data-kind="external" />Outside the repo (dashed)</li>
            <li><span className="system-map__key" data-empty />No files</li>
            <li><span className="system-map__key" data-live />Agent editing its files now</li>
            <li>
              <span className="system-map__key-dot" /> Step / <span className="system-map__key-dot" data-mark="guard" /> Guard /{' '}
              <span className="system-map__key-dot" data-mark="refusal" /> Refusal dots
            </li>
            {hasImplied && <li><span className="system-map__key-line" data-implied />Drawn for a flow step only</li>}
          </ul>
        </section>
        {picture.unmatchedEdits > 0 && (
          <p className="system-map__note">
            {picture.unmatchedEdits === 1 ? '1 edit' : `${picture.unmatchedEdits} edits`} this app run matched no part.
          </p>
        )}
        {fileNote && <p className="system-map__note">{fileNote}</p>}
      </aside>
    </div>
  )
}

function SystemMapInner(props: SystemMapViewProps) {
  const { projectId, api, onMapThisRepo, onHeading } = props
  const mapApi = useMemo(() => (api ? { agentGraph: api } : undefined), [api])
  const { result } = useSystemMap(mapApi, projectId)

  const valid = result?.ok && result.read.kind === 'valid' ? result.read : null
  const headingTitle = valid ? valid.map.title : null
  const headingCommit = valid ? commitText(valid.lastCommit) : null
  useEffect(() => {
    onHeading(headingTitle !== null && headingCommit !== null ? { title: headingTitle, commit: headingCommit } : null)
  }, [headingTitle, headingCommit, onHeading])
  useEffect(() => () => onHeading(null), [onHeading])

  if (result === null) {
    return (
      <div className="agent-graph__flow">
        <p className="system-map__loading">Reading the system map…</p>
      </div>
    )
  }
  if (!result.ok) {
    return (
      <div className="agent-graph__flow">
        <ul className="agent-graph__notices">
          <li>{result.reason}</li>
        </ul>
      </div>
    )
  }
  const read = result.read
  if (read.kind === 'missing') {
    return (
      <div className="agent-graph__flow">
        <div className="agent-graph__empty">
          <span className="agent-graph__empty-icon"><IconGraph /></span>
          <p className="agent-graph__empty-title">{SYSTEM_MAP_EMPTY_TITLE}</p>
          <p>{SYSTEM_MAP_EMPTY_TEXT}</p>
          <div className="agent-graph__empty-actions">
            <button type="button" className="agent-graph__button" onClick={onMapThisRepo}>
              {SYSTEM_MAP_ACTION}
            </button>
          </div>
          <p className="agent-graph__empty-note">{SYSTEM_MAP_ACTION_NOTE}</p>
        </div>
      </div>
    )
  }
  if (read.kind === 'invalid') {
    return (
      <div className="agent-graph__flow">
        <div className="system-map__problems" role="alert">
          <p className="system-map__problems-title">{SYSTEM_MAP_PROBLEMS_TITLE}</p>
          <ul>
            {read.problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
          <p className="system-map__problems-note">Fix docs/system-map.json, or ask an agent to. This view reloads when the file changes.</p>
        </div>
      </div>
    )
  }
  return <SystemMapPictureView {...props} read={read} />
}

export function SystemMapView(props: SystemMapViewProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <SystemMapInner {...props} />
    </ReactFlowProvider>
  )
}
