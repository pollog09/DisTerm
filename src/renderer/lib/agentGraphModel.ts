/**
 * The agent graph, as data: which boxes and lines the view draws for what the core observed.
 *
 * Pure on purpose. Everything that can be wrong about this view is a question of counting (does a
 * refusal read as one, does a re-entered stage read as a loop, does a message land on the right
 * pair), and those are answered here, away from React and away from layout. It reads hostile input
 * (a board log and a ship-graph.json both travel in git), so unknown names stay text and a forged
 * line only ever adds a line to a picture.
 *
 * WHO FOLLOWS WHOM. A subagent's predecessor is the latest one IN THE SAME RUN that had already ENDED
 * when it started. So a pipeline reads as a chain, and fan-out reads as siblings of the same parent
 * instead of a chain nobody ran.
 *
 * WHAT A RUN IS. A real reset (`/clear`, a fresh launch) or a new user prompt starts one, so a second
 * `/ship-change` is not a rejection of the first. A compaction or a resume does not: the same work goes
 * on. Inside one turn, hooks cannot tell "the reviewer rejected, go back to the first stage" from "start
 * over", so the file decides: a move the file declares is taken as declared (a reject), and an
 * undeclared move from a last stage to a first stage is a new run. A rejection a person relays in a new
 * prompt therefore reads as a new run: under-reporting a loop is the safer way round, since an invented
 * one says the review failed.
 *
 * WHAT A PASS IS. A subagent started again under the same id after it stopped is a second pass, with its
 * own place in the order and the first pass's end left alone. Rewriting that end would move it past
 * whatever ran in between, which is how a rejection erased the forward edge it came back along.
 *
 * WHAT BACKWARDS MEANS. With a pipeline, returning to a stage its `next` edges declare as coming before
 * this one, so review, impl, docs, review does not paint docs -> review, and a stage they say nothing
 * about is never "behind" anything. With no file there is no declared order, only the order things were
 * first seen, and then a rejection and a clean second run in one turn look the same: the line says it
 * went back, not that anything was rejected.
 */
import {
  deliveryClass,
  type AgentGraphEvent,
  type AgentGraphSnapshot,
  type DeliveryClass
} from '@shared/agent-graph'
import { WORKING_STALE_MS } from '@shared/agents/stale'
import { splitNextCycle, type ShipAgent, type ShipAgentColor, type ShipConfig, type ShipPipeline, type ShipStage } from '@shared/ship-config'

export type GraphNodeKind = 'session' | 'note' | 'ghost' | 'subagent' | 'stage'

export type GraphActivity = 'idle' | 'running' | 'done' | 'stale'

export interface GraphMachine {
  kind: 'local' | 'ssh' | 'relay'
  label: string
}

export interface GraphSessionInput {
  id: string
  kind: 'terminal' | 'note'
  title: string
  agentId?: string
  machine: GraphMachine
  /** Live state, as the agent-status store holds it. */
  state?: string
  /** What the station last reported about its task (`report-outcome`). */
  outcome?: 'succeeded' | 'failed'
  /** It was handed new work it has not finished (`station-handover`). */
  handedOver?: boolean
}

export interface GraphLinkInput {
  source: string
  target: string
  reader?: string
}

export interface GraphRopeInput extends GraphLinkInput {
  /** A wait (`--after`) rather than an opener (`isWaitRope`). */
  wait: boolean
}

export interface GraphNode {
  id: string
  kind: GraphNodeKind
  title: string
  subtitle?: string
  /** The terminal a click opens: the session itself, or the session that ran this subagent. */
  sessionId?: string
  agentId?: string
  machine?: GraphMachine
  state?: string
  outcome?: 'succeeded' | 'failed'
  handedOver?: boolean
  activity?: GraphActivity
  /** Runs of this agent or stage so far. */
  runs?: number
  /** A stage started again after a later stage had run. */
  reentered?: boolean
  /** No agent file names this stage's agent. Built-in and plugin agents have none, so this is not
   *  proof the agent is missing. */
  missingAgent?: boolean
  color?: ShipAgentColor
  description?: string
  /** Newest event that touched this node, for the arrival pulse. */
  lastEventTs?: number
}

export type GraphEdgeKind =
  | 'message'
  | 'context'
  | 'dependency'
  | 'opened'
  | 'spawned'
  | 'observed'
  | 'ship-next'
  | 'ship-reject'

export type DeliveryCounts = Record<DeliveryClass, number>

export interface GraphEdge {
  id: string
  source: string
  target: string
  kind: GraphEdgeKind
  /** `message` only. Counts TRACES: a message that queued and then landed is one of each. */
  counts?: DeliveryCounts
  /** `message` only: the newest trace's class, which colours the line. */
  latest?: DeliveryClass
  /** The newest refusal's reason, when the trace kept one. */
  reason?: string
  /** How many times work moved along this edge. */
  traversals?: number
  /** It re-entered a stage that had already run. */
  loop?: boolean
  /** Work moved along a route the ship-graph file does not declare. */
  undeclared?: boolean
  lastEventTs?: number
}

export interface AgentGraphModel {
  nodes: GraphNode[]
  edges: GraphEdge[]
  notices: string[]
  /** When the next open run stops being claimed as running. Absent = nothing is open, so nothing
   *  about this picture can change until an event arrives. */
  nextStaleAt?: number
}

export interface AgentGraphInput {
  sessions: readonly GraphSessionInput[]
  links: readonly GraphLinkInput[]
  ropes: readonly GraphRopeInput[]
  snapshot: AgentGraphSnapshot | null
  ship: ShipConfig | null
  now: number
}

/** A session that started more distinct agent types than this is someone's outlier, and the box per
 *  type would bury the graph. What is dropped is named in a notice. */
export const MAX_OBSERVED_TYPES = 24

const UNKNOWN_SUBAGENT = 'subagent'

interface SubRun {
  subId: string
  type: string
  label?: string
  startedAt: number
  endedAt?: number
  lastEventTs: number
  /** Newest sign of life, streamed output included. Only staleness reads this: output is not an event
   *  worth a pulse. */
  lastSignalTs: number
  /** Which run of its session this belongs to: moved on by a reset or a new user prompt. */
  epoch: number
}

/** The subagent half of the stream, per parent session, in start order. */
export function reduceSubagents(events: readonly AgentGraphEvent[]): Map<string, SubRun[]> {
  const byParent = new Map<string, SubRun[]>()
  const epochs = new Map<string, number>()
  /** The newest pass under this id. */
  const find = (nodeId: string, subId: string): SubRun | undefined => {
    const runs = byParent.get(nodeId) ?? []
    for (let i = runs.length - 1; i >= 0; i--) if (runs[i].subId === subId) return runs[i]
    return undefined
  }
  for (const e of events) {
    if (e.kind === 'subagent-start') {
      // A native start replacing the card its tool call drew is the same run, not a second one.
      const replaced = e.supersedes ? find(e.nodeId, e.supersedes) : undefined
      if (replaced) replaced.subId = e.subId
      const run = replaced ?? find(e.nodeId, e.subId)
      if (run && run.endedAt === undefined) {
        // A repeated start of an open card corrects what it shows.
        if (e.subagentType) run.type = e.subagentType
        if (e.label) run.label = e.label
        run.lastEventTs = e.ts
        run.lastSignalTs = e.ts
        continue
      }
      // New, or started again after it stopped: a pass of its own. The earlier pass keeps its end.
      const list = byParent.get(e.nodeId) ?? []
      const type = e.subagentType || run?.type || UNKNOWN_SUBAGENT
      const label = e.label ?? run?.label
      list.push({
        subId: e.subId,
        type,
        ...(label ? { label } : {}),
        startedAt: e.ts,
        lastEventTs: e.ts,
        lastSignalTs: e.ts,
        epoch: epochs.get(e.nodeId) ?? 0
      })
      byParent.set(e.nodeId, list)
    } else if (e.kind === 'subagent-end') {
      const run = find(e.nodeId, e.subId)
      // The first end stands. The tool path can report a child's end again long after its native stop,
      // and moving it would put this run after whatever started in between.
      if (run && run.endedAt === undefined) {
        run.endedAt = e.ts
        run.lastEventTs = e.ts
      }
    } else if (e.kind === 'subagent-activity') {
      const run = find(e.nodeId, e.subId)
      if (run && run.endedAt === undefined) run.lastSignalTs = Math.max(run.lastSignalTs, e.ts)
    } else if (e.kind === 'session-end') {
      for (const run of byParent.get(e.nodeId) ?? []) run.endedAt ??= e.ts
    } else if (e.kind === 'session-reset') {
      for (const run of byParent.get(e.nodeId) ?? []) run.endedAt ??= e.ts
      epochs.set(e.nodeId, (epochs.get(e.nodeId) ?? 0) + 1)
    } else if (e.kind === 'turn-start') {
      epochs.set(e.nodeId, (epochs.get(e.nodeId) ?? 0) + 1)
    }
  }
  return byParent
}

/** For each run, the run it followed: the latest one of its run already over when it started. */
function predecessors(runs: readonly SubRun[]): Array<SubRun | null> {
  return runs.map((run, i) => {
    let best: SubRun | null = null
    for (let j = 0; j < i; j++) {
      const r = runs[j]
      if (r.epoch !== run.epoch) continue
      if (r.endedAt !== undefined && r.endedAt <= run.startedAt && (!best || r.endedAt >= best.endedAt!)) best = r
    }
    return best
  })
}

function activityOf(runs: readonly SubRun[], now: number): GraphActivity {
  if (runs.length === 0) return 'idle'
  const running = runs.filter((r) => r.endedAt === undefined)
  if (running.length === 0) return 'done'
  // A killed child fires no stop. Past the app's own staleness line it is no longer claimed as
  // running, the same bound the canvas's status uses.
  return running.some((r) => now - r.lastSignalTs < WORKING_STALE_MS) ? 'running' : 'stale'
}

function newestTs(runs: readonly SubRun[]): number | undefined {
  return runs.length ? Math.max(...runs.map((r) => r.lastEventTs)) : undefined
}

function bestPipeline(pipelines: readonly ShipPipeline[], runs: readonly SubRun[]): ShipPipeline | null {
  const types = new Set(runs.map((r) => r.type))
  let best: ShipPipeline | null = null
  let bestScore = 0
  for (const p of pipelines) {
    const score = p.stages.filter((s) => types.has(s.agent)).length
    if (score > bestScore) {
      best = p
      bestScore = score
    }
  }
  return best
}

interface DeclaredOrder {
  /** Does the file say `a` comes before `b`? False when it says nothing about them. */
  precedes(a: string, b: string): boolean
  isFirst(id: string): boolean
  isLast(id: string): boolean
}

/** What the file says about order: reachability along its `next` edges (a cycle does not count), or
 *  the list itself when there are no `next` edges at all. */
function declaredOrder(pipeline: ShipPipeline): DeclaredOrder {
  const ids = pipeline.stages.map((s) => s.id)
  const { order } = splitNextCycle(ids, pipeline.edges)
  if (order.length === 0) {
    const index = new Map(ids.map((id, i) => [id, i]))
    return {
      precedes: (a, b) => index.get(a)! < index.get(b)!,
      isFirst: (id) => index.get(id) === 0,
      isLast: (id) => index.get(id) === ids.length - 1
    }
  }
  const after = new Map<string, string[]>()
  for (const e of order) after.set(e.from, [...(after.get(e.from) ?? []), e.to])
  const reach = (from: string, seen = new Set<string>()): Set<string> => {
    for (const to of after.get(from) ?? []) {
      if (!seen.has(to)) {
        seen.add(to)
        reach(to, seen)
      }
    }
    return seen
  }
  const reachable = new Map(ids.map((id) => [id, reach(id)]))
  const targets = new Set(order.map((e) => e.to))
  return {
    precedes: (a, b) => !!reachable.get(a)?.has(b),
    isFirst: (id) => after.has(id) && !targets.has(id),
    isLast: (id) => targets.has(id) && !after.has(id)
  }
}

const stageNodeId = (scope: string, pipelineId: string, stageId: string): string =>
  `stage:${scope}:${pipelineId}:${stageId}`

/** One pipeline as boxes and declared edges, lit by the runs a session made of it (none = a template
 *  showing the configured process before anything has run). */
function addPipeline(
  out: { nodes: GraphNode[]; edges: GraphEdge[] },
  pipeline: ShipPipeline,
  scope: string,
  sessionId: string | null,
  runs: readonly SubRun[],
  agents: ReadonlyMap<string, ShipAgent>,
  now: number
): void {
  const stageOfAgent = new Map<string, ShipStage>()
  for (const s of pipeline.stages) if (!stageOfAgent.has(s.agent)) stageOfAgent.set(s.agent, s)
  const preds = predecessors(runs)

  const order = declaredOrder(pipeline)
  const declared = new Set(pipeline.edges.map((e) => `${e.from}>${e.to}`))

  // Walk the runs: which stage followed which, and whether a move went backwards.
  const traversals = new Map<string, { from: string; to: string; count: number; loop: boolean; ts: number }>()
  const reentered = new Set<string>()
  const entries = new Map<string, number>()
  let seen = new Set<string>()
  let epoch: number | undefined
  runs.forEach((run, i) => {
    const stage = stageOfAgent.get(run.type)
    if (!stage) return
    if (run.epoch !== epoch) {
      epoch = run.epoch
      seen = new Set()
    }
    const pred = preds[i] ? stageOfAgent.get(preds[i]!.type) : undefined
    const startsOver = !!pred && !declared.has(`${pred.id}>${stage.id}`) && order.isLast(pred.id) && order.isFirst(stage.id)
    if (!pred || startsOver) {
      if (startsOver) seen = new Set()
      entries.set(stage.id, (entries.get(stage.id) ?? 0) + 1)
    } else if (pred.id !== stage.id) {
      const back = order.precedes(stage.id, pred.id)
      if (back && seen.has(stage.id)) reentered.add(stage.id)
      const key = `${pred.id}>${stage.id}`
      const t = traversals.get(key) ?? { from: pred.id, to: stage.id, count: 0, loop: false, ts: 0 }
      t.count++
      t.loop ||= back
      t.ts = Math.max(t.ts, run.startedAt)
      traversals.set(key, t)
    }
    seen.add(stage.id)
  })

  for (const stage of pipeline.stages) {
    const stageRuns = runs.filter((r) => stageOfAgent.get(r.type)?.id === stage.id)
    const agent = agents.get(stage.agent)
    out.nodes.push({
      id: stageNodeId(scope, pipeline.id, stage.id),
      kind: 'stage',
      title: stage.label ?? stage.agent,
      subtitle: pipeline.triggerCommand ? `${pipeline.name} · /${pipeline.triggerCommand}` : pipeline.name,
      ...(sessionId ? { sessionId } : {}),
      activity: activityOf(stageRuns, now),
      runs: stageRuns.length,
      ...(reentered.has(stage.id) ? { reentered: true } : {}),
      ...(agent ? {} : { missingAgent: true }),
      ...(agent?.color ? { color: agent.color } : {}),
      ...(agent?.description ? { description: agent.description } : {}),
      ...(stageRuns.length ? { lastEventTs: newestTs(stageRuns) } : {})
    })
  }

  for (const edge of pipeline.edges) {
    const key = `${edge.from}>${edge.to}`
    const t = traversals.get(key)
    traversals.delete(key)
    out.edges.push({
      id: `ship:${scope}:${pipeline.id}:${edge.from}:${edge.to}:${edge.kind}`,
      source: stageNodeId(scope, pipeline.id, edge.from),
      target: stageNodeId(scope, pipeline.id, edge.to),
      kind: edge.kind === 'reject' ? 'ship-reject' : 'ship-next',
      ...(t ? { traversals: t.count, lastEventTs: t.ts, ...(t.loop ? { loop: true } : {}) } : {})
    })
  }
  // Work that moved along a route the file does not declare still happened, so it is drawn.
  for (const t of traversals.values()) {
    out.edges.push({
      id: `ship:${scope}:${pipeline.id}:${t.from}:${t.to}:undeclared`,
      source: stageNodeId(scope, pipeline.id, t.from),
      target: stageNodeId(scope, pipeline.id, t.to),
      kind: 'observed',
      traversals: t.count,
      undeclared: true,
      lastEventTs: t.ts,
      ...(t.loop ? { loop: true } : {})
    })
  }

  // The session starts whatever ran with nothing before it.
  if (sessionId) {
    for (const [stageId, count] of entries) {
      out.edges.push({
        id: `spawned:${scope}:${pipeline.id}:${stageId}`,
        source: `session:${sessionId}`,
        target: stageNodeId(scope, pipeline.id, stageId),
        kind: 'spawned',
        traversals: count
      })
    }
  }
}

/** Subagents with no pipeline to map onto: one box per agent type, joined by what was observed. */
function addObserved(
  out: { nodes: GraphNode[]; edges: GraphEdge[]; notices: string[] },
  sessionId: string,
  runs: readonly SubRun[],
  agents: ReadonlyMap<string, ShipAgent>,
  now: number
): void {
  const types = [...new Set(runs.map((r) => r.type))]
  const shown = new Set(types.slice(0, MAX_OBSERVED_TYPES))
  if (types.length > shown.size) {
    out.notices.push(`A session started ${types.length} agent types; only the first ${MAX_OBSERVED_TYPES} are drawn.`)
  }
  const nodeId = (type: string): string => `sub:${sessionId}:${type}`
  for (const type of shown) {
    const typeRuns = runs.filter((r) => r.type === type)
    const agent = agents.get(type)
    const newest = typeRuns[typeRuns.length - 1]
    out.nodes.push({
      id: nodeId(type),
      kind: 'subagent',
      title: type,
      ...(newest.label ? { subtitle: newest.label } : {}),
      sessionId,
      activity: activityOf(typeRuns, now),
      runs: typeRuns.length,
      ...(agent?.color ? { color: agent.color } : {}),
      ...(agent?.description ? { description: agent.description } : {}),
      lastEventTs: newestTs(typeRuns)
    })
  }
  const preds = predecessors(runs)
  const edges = new Map<string, GraphEdge>()
  let firstSeen = new Map<string, number>()
  let epoch: number | undefined
  runs.forEach((run, i) => {
    if (!shown.has(run.type)) return
    if (run.epoch !== epoch) {
      epoch = run.epoch
      firstSeen = new Map()
    }
    const pred = preds[i]
    if (!firstSeen.has(run.type)) firstSeen.set(run.type, i)
    if (pred && pred.type === run.type) return // a retry of the same agent is its run count
    const from = pred && shown.has(pred.type) ? pred.type : null
    const key = from ? `seq:${sessionId}:${from}:${run.type}` : `spawned:${sessionId}:${run.type}`
    const edge = edges.get(key) ?? {
      id: key,
      source: from ? nodeId(from) : `session:${sessionId}`,
      target: nodeId(run.type),
      kind: from ? ('observed' as const) : ('spawned' as const),
      traversals: 0
    }
    edge.traversals! += 1
    edge.lastEventTs = Math.max(edge.lastEventTs ?? 0, run.startedAt)
    if (from && firstSeen.get(run.type)! < firstSeen.get(from)!) edge.loop = true
    edges.set(key, edge)
  })
  out.edges.push(...edges.values())
}

const zeroCounts = (): DeliveryCounts => ({ delivered: 0, queued: 0, failed: 0, refused: 0 })

export function buildAgentGraphModel(input: AgentGraphInput): AgentGraphModel {
  const { sessions, links, ropes, snapshot, ship, now } = input
  const known = new Map(sessions.map((s) => [s.id, s]))
  const nodeFor = (id: string): string => `session:${id}`
  const out: { nodes: GraphNode[]; edges: GraphEdge[]; notices: string[] } = { nodes: [], edges: [], notices: [] }
  const events = snapshot?.events ?? []

  // Messages. The buffer spans every project of this core, so a line is kept only if it touches this
  // project. An endpoint this canvas does not hold (deleted, or in another project) becomes a ghost so
  // the counts stay true to the log rather than shrinking when a node is deleted.
  const ghosts = new Set<string>()
  const messages = new Map<string, GraphEdge>()
  for (const e of events) {
    if (e.kind !== 'delivery' || (!known.has(e.from) && !known.has(e.to))) continue
    if (!known.has(e.from)) ghosts.add(e.from)
    if (!known.has(e.to)) ghosts.add(e.to)
    const id = `message:${e.from}:${e.to}`
    const edge = messages.get(id) ?? {
      id,
      source: nodeFor(e.from),
      target: nodeFor(e.to),
      kind: 'message' as const,
      counts: zeroCounts()
    }
    const cls = deliveryClass(e.outcome)
    edge.counts![cls] += 1
    edge.latest = cls
    edge.lastEventTs = e.ts
    if (cls === 'refused') edge.reason = e.reason ?? e.outcome
    messages.set(id, edge)
  }
  out.edges.push(...messages.values())

  // The canvas's own relations, for the nodes this project holds.
  const related = (id: string): boolean => known.has(id)
  for (const rope of ropes) {
    if (!related(rope.source) || !related(rope.target)) continue
    out.edges.push({
      id: `${rope.wait ? 'wait' : 'opened'}:${rope.source}:${rope.target}`,
      source: nodeFor(rope.source),
      target: nodeFor(rope.target),
      kind: rope.wait ? 'dependency' : 'opened'
    })
  }
  for (const link of links) {
    if (!related(link.source) || !related(link.target)) continue
    // A one-way link reads toward its reader: context flows from the other end into it.
    const forward = link.reader !== link.source
    const source = forward ? link.source : link.target
    const target = forward ? link.target : link.source
    out.edges.push({ id: `context:${link.source}:${link.target}`, source: nodeFor(source), target: nodeFor(target), kind: 'context' })
  }

  // Subagents and the ship process.
  const agents = new Map((ship?.agents ?? []).map((a) => [a.name, a]))
  const pipelines = ship?.pipelines ?? []
  const runsByParent = reduceSubagents(events)
  const usedPipelines = new Set<string>()
  const lastTsBySession = new Map<string, number>()
  for (const [parent, allRuns] of runsByParent) {
    if (!known.has(parent)) continue
    const ts = newestTs(allRuns)
    if (ts !== undefined) lastTsBySession.set(parent, ts)
    const pipeline = bestPipeline(pipelines, allRuns)
    const inPipeline = pipeline ? new Set(pipeline.stages.map((s) => s.agent)) : new Set<string>()
    if (pipeline) {
      usedPipelines.add(pipeline.id)
      addPipeline(out, pipeline, parent, parent, allRuns.filter((r) => inPipeline.has(r.type)), agents, now)
    }
    const rest = allRuns.filter((r) => !inPipeline.has(r.type))
    if (rest.length) addObserved(out, parent, rest, agents, now)
  }
  // A configured process nothing has run yet is still the machine's process: show it, unattached.
  for (const pipeline of pipelines) {
    if (!usedPipelines.has(pipeline.id)) addPipeline(out, pipeline, 'template', null, [], agents, now)
  }

  // Which sessions get a box: every agent, plus anything a line touches. A plain terminal nobody
  // talks to is canvas furniture, not a participant.
  const touched = new Set<string>()
  for (const e of out.edges) {
    touched.add(e.source)
    touched.add(e.target)
  }
  for (const s of sessions) {
    if (!s.agentId && !touched.has(nodeFor(s.id))) continue
    const lastDelivery = Math.max(
      0,
      ...[...messages.values()]
        .filter((m) => m.source === nodeFor(s.id) || m.target === nodeFor(s.id))
        .map((m) => m.lastEventTs ?? 0)
    )
    const last = Math.max(lastDelivery, lastTsBySession.get(s.id) ?? 0)
    out.nodes.push({
      id: nodeFor(s.id),
      kind: s.kind === 'note' ? 'note' : 'session',
      title: s.title || s.id,
      ...(s.kind === 'terminal' ? { sessionId: s.id } : {}),
      ...(s.agentId ? { agentId: s.agentId } : {}),
      machine: s.machine,
      ...(s.state ? { state: s.state } : {}),
      ...(s.outcome ? { outcome: s.outcome } : {}),
      ...(s.handedOver ? { handedOver: true } : {}),
      ...(last ? { lastEventTs: last } : {})
    })
  }
  for (const id of ghosts) {
    // Deleted, or alive in another project of this core: the id cannot say which, so neither is claimed.
    out.nodes.push({ id: nodeFor(id), kind: 'ghost', title: 'Session outside this project', subtitle: id.slice(0, 16) })
  }

  // What the picture cannot say on its own.
  if (snapshot) {
    if (snapshot.dropped > 0) {
      out.notices.push(`Older events were dropped: this app keeps the newest ${snapshot.capacity}, and ${snapshot.dropped} have gone.`)
    }
    if (snapshot.historyTruncated) out.notices.push('Only the newest board-log lines were read, so older messages are not counted.')
    if (snapshot.history === 'memory') out.notices.push('This project has no reachable board log, so message counts cover this app run only.')
  }
  const others = sessions.filter((s) => s.agentId && s.agentId !== 'claude')
  if (others.length) {
    out.notices.push('Subagents are Claude-only: other CLIs appear as sessions and message lines.')
  }
  if ([...runsByParent].some(([parent, runs]) => known.has(parent) && runs.some((r) => r.type === 'shipit-agent'))) {
    out.notices.push('/shipit delegates share one agent type (shipit-agent), so they cannot be told apart by stage.')
  }
  const staleAt = [...runsByParent]
    .filter(([parent]) => known.has(parent))
    .flatMap(([, runs]) => runs.filter((r) => r.endedAt === undefined).map((r) => r.lastSignalTs + WORKING_STALE_MS))
    .filter((at) => at > now)
  return staleAt.length ? { ...out, nextStaleAt: Math.min(...staleAt) } : out
}

/**
 * What moves the layout. Status and counts change a box's contents, not its place, and a graph that
 * re-laid itself on every hook event would be unreadable.
 */
export function agentGraphStructureKey(model: Pick<AgentGraphModel, 'nodes' | 'edges'>): string {
  return JSON.stringify([model.nodes.map((n) => n.id), model.edges.map((e) => `${e.id}${isBackEdge(e) ? '<' : ''}`)])
}

/** A line that runs against the process: laid out as if forward, so it never sets the stage order. */
export function isBackEdge(edge: Pick<GraphEdge, 'kind' | 'loop'>): boolean {
  return edge.kind === 'ship-reject' || !!edge.loop
}
