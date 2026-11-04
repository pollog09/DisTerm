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
 * about is never "behind" anything. With no `next` edges nothing is. With no file there is no declared order, only the order things were
 * first seen, and then a rejection and a clean second run in one turn look the same: the line is marked
 * as a loop in its own colour, and its hover text says that nothing is known to have been rejected.
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
  /** Runs that may have been this stage or another: not counted in `runs`. */
  maybeRuns?: number
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
  /** Moves that may have taken this edge or another: hooks cannot tell which. Not traversals. */
  maybe?: number
  /** It re-entered a stage that had already run. */
  loop?: boolean
  /** Work moved along a route the ship-graph file does not declare. */
  undeclared?: boolean
  lastEventTs?: number
  /** A run this move led to is still going, by the same staleness line as a box's activity. Motion reads
   *  this, so a move placed by a guess never sets it. */
  running?: true
  /** When a move not placed by a guess last started along this line. `lastEventTs` is any event, and
   *  drives the arrival pulse; motion claims the route was taken, so it reads this. */
  movedAt?: number
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

/** A killed child fires no stop. Past the app's own staleness line it is no longer claimed as running,
 *  the same bound the canvas's status uses. */
const isLive = (run: SubRun, now: number): boolean => run.endedAt === undefined && now - run.lastSignalTs < WORKING_STALE_MS

function activityOf(runs: readonly SubRun[], now: number): GraphActivity {
  if (runs.length === 0) return 'idle'
  if (runs.every((r) => r.endedAt !== undefined)) return 'done'
  return runs.some((r) => isLive(r, now)) ? 'running' : 'stale'
}

function newestTs(runs: readonly SubRun[]): number | undefined {
  return runs.length ? Math.max(...runs.map((r) => r.lastEventTs)) : undefined
}

interface PipelineChoice {
  /** The one that fits best; null = none fits, or `tied` does. */
  pipeline: ShipPipeline | null
  /** More than one fits equally and they share these runs' agents, so nothing can say which ran. */
  tied: ShipPipeline[]
}

/** How well a pipeline explains these runs: stages it can name, then moves its `next` edges declare. */
function fitOf(pipeline: ShipPipeline, runs: readonly SubRun[]): [number, number] {
  const agents = new Set(pipeline.stages.map((s) => s.agent))
  const mine = runs.filter((r) => agents.has(r.type))
  const named = new Set(mine.map((r) => r.type)).size
  const agentOf = new Map(pipeline.stages.map((s) => [s.id, s.agent]))
  const moves = new Set(pipeline.edges.filter((e) => e.kind === 'next').map((e) => `${agentOf.get(e.from)}>${agentOf.get(e.to)}`))
  const preds = predecessors(mine)
  const inOrder = mine.filter((r, i) => preds[i] && moves.has(`${preds[i]!.type}>${r.type}`)).length
  return [named, inOrder]
}

/** Which pipeline these runs were: most stages named, then the observed order, never the file's list
 *  order, which would call a clean `hotfix` a rejected `ship`. A true tie picks nothing. */
function choosePipeline(pipelines: readonly ShipPipeline[], runs: readonly SubRun[]): PipelineChoice {
  let best: ShipPipeline[] = []
  let bestFit: [number, number] = [0, 0]
  for (const p of pipelines) {
    const fit = fitOf(p, runs)
    if (fit[0] === 0) continue
    if (fit[0] > bestFit[0] || (fit[0] === bestFit[0] && fit[1] > bestFit[1])) {
      best = [p]
      bestFit = fit
    } else if (fit[0] === bestFit[0] && fit[1] === bestFit[1]) {
      best.push(p)
    }
  }
  if (best.length <= 1) return { pipeline: best[0] ?? null, tied: [] }
  // Equal fit on different agents is two pipelines, each to be taken in turn, not a doubt about one.
  const ran = new Set(runs.map((r) => r.type))
  const agentsOf = (p: ShipPipeline): string[] => p.stages.map((st) => st.agent).filter((agent) => ran.has(agent))
  const first = new Set(agentsOf(best[0]))
  const rivals = best.slice(1).filter((p) => agentsOf(p).some((agent) => first.has(agent)))
  return rivals.length ? { pipeline: null, tied: [best[0], ...rivals] } : { pipeline: best[0], tied: [] }
}

interface DeclaredOrder {
  /** Does the file say `a` comes before `b`? False when it says nothing about them. */
  precedes(a: string, b: string): boolean
  isFirst(id: string): boolean
  isLast(id: string): boolean
}

/** What the file says about order: reachability along its `next` edges, where a cycle does not count.
 *  A file with no `next` edges declares no order, and the order stages are listed in is not one. */
function declaredOrder(pipeline: ShipPipeline): DeclaredOrder {
  const ids = pipeline.stages.map((s) => s.id)
  const { order } = splitNextCycle(ids, pipeline.edges)
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

interface RunPlacement {
  /** The stage each run filled, where that is known or guessed. Absent for an uncertain run. */
  certain: Map<SubRun, ShipStage>
  /** The stages an uncertain run may have filled: none is counted as fact. */
  maybe: Map<SubRun, ShipStage[]>
  /** Its position is a guess: no declared route led here, or it came from a position that was one. Only
   *  an agent one stage uses settles it, and only a declared next move is drawn into or out of it. */
  guessed: Set<SubRun>
  /** Declared routes an uncertain run may have taken. */
  maybeMoves: Array<{ from: string; to: string; ts: number }>
}

const stageName = (st: ShipStage): string => st.label ?? st.id

/**
 * Which stage each run filled. An agent used by one stage is that stage. An agent used by several is
 * placed by position, in this order: the stage declared next after the run it followed, a declared
 * reject from there, the stage it is already in (a retry, or an unvisited sibling of it when stages fan
 * out), and the nearest stage reachable from there.
 *
 * NEXT AND REJECT TO THE SAME AGENT CANNOT BE TOLD APART. Stages impl, r1, fix, r2 with `r1 -> fix` and a
 * reject `r1 -> impl`: an implementer after r1 is either, and hooks carry nothing that says which.
 * Choosing would state a passed review or a failed one as fact, so the run is counted on neither. Both
 * edges are marked maybe, and a notice names them.
 *
 * WHAT FOLLOWS AN UNCERTAIN RUN stays uncertain, because its position is what placed the next one: a run
 * is placed from every stage the last could have been. It settles at the first stage only one route
 * reaches, or an agent only one stage uses.
 *
 * NO ROUTE AT ALL: it goes on the earliest candidate by the declared order (by id on a tie, never list
 * order), with a notice, and draws no move. Picking between siblings that fan out is a guess too. A guess
 * stays one through every later run of a repeated agent, retries included, because each is placed from
 * the last, and a wrong position would otherwise find a reject edge the run never took. It ends at an
 * agent only one stage uses, whose position is fact. Nothing but a declared next move is drawn into or
 * out of a guess, so it can never read as a loop or a rejection.
 */
function placeRuns(
  pipeline: ShipPipeline,
  runs: readonly SubRun[],
  preds: ReadonlyArray<SubRun | null>,
  order: DeclaredOrder,
  notices: string[]
): RunPlacement {
  const placement: RunPlacement = { certain: new Map(), maybe: new Map(), guessed: new Set(), maybeMoves: [] }
  const declared = (from: string, to: string): boolean => pipeline.edges.some((e) => e.from === from && e.to === to)
  const edge = (from: string, to: string, kind: 'next' | 'reject'): boolean =>
    pipeline.edges.some((e) => e.from === from && e.to === to && e.kind === kind)
  const byId = (a: ShipStage, b: ShipStage): number => a.id.localeCompare(b.id)
  const earliestOf = (stages: readonly ShipStage[]): ShipStage[] =>
    stages.filter((c) => !stages.some((o) => order.precedes(o.id, c.id))).sort(byId)
  let visited = new Set<string>()
  let epoch: number | undefined
  let unsure = false
  /** `resolve` chose between stages the file does not separate. */
  let picked = false

  /** Where a run of these candidates goes from `from`: one stage, two when hooks cannot say, or none. */
  const resolve = (from: ShipStage, candidates: readonly ShipStage[]): ShipStage[] => {
    const nexts = candidates.filter((c) => edge(from.id, c.id, 'next'))
    const rejects = candidates.filter((c) => edge(from.id, c.id, 'reject'))
    const nextOne = nexts.find((c) => !visited.has(c.id)) ?? nexts[0]
    if (nexts.length > 1) picked = true
    if (nextOne && rejects.length) {
      const other = rejects.filter((c) => c.id !== nextOne.id)
      if (other.length) {
        notices.push(`${pipeline.name}: after ${stageName(from)}, ${candidates[0].agent} could be the next stage ${stageName(nextOne)} or a rejection back to ${other.map(stageName).join(' or ')}. Hooks cannot tell, so neither is counted, and what follows stays uncertain until one route is left.`)
        return [nextOne, ...other]
      }
    }
    if (nextOne) return [nextOne]
    if (rejects[0]) return [rejects[0]]
    if (candidates.some((c) => c.id === from.id)) {
      // Another run of this agent: a retry, unless a stage fanning out beside this one has not run yet.
      const sibling = candidates.find(
        (c) => c.id !== from.id && !visited.has(c.id) &&
          pipeline.edges.some((e) => e.kind === 'next' && e.to === c.id && edge(e.from, from.id, 'next'))
      )
      return [sibling ?? from]
    }
    const nearest = earliestOf(candidates.filter((c) => order.precedes(from.id, c.id)))
    return nearest.length ? [nearest[0]] : []
  }

  runs.forEach((run, i) => {
    if (run.epoch !== epoch) {
      epoch = run.epoch
      visited = new Set()
    }
    const candidates = pipeline.stages.filter((st) => st.agent === run.type)
    if (candidates.length === 0) return
    const pred = preds[i]
    const fromStages = pred
      ? placement.maybe.get(pred) ?? (placement.certain.has(pred) ? [placement.certain.get(pred)!] : [])
      : []
    let places: ShipStage[]
    picked = false
    if (candidates.length === 1) {
      places = candidates
    } else if (fromStages.length === 0) {
      // Nothing before it in this run: the one no other candidate comes before.
      const earliest = earliestOf(candidates)
      if (earliest.length !== 1) {
        unsure = true
        placement.guessed.add(run)
      }
      places = [earliest[0]]
    } else {
      places = [...new Map(fromStages.flatMap((f) => resolve(f, candidates)).map((st) => [st.id, st])).values()]
      if (places.length === 0) {
        unsure = true
        placement.guessed.add(run)
        places = [earliestOf(candidates)[0]]
      }
    }
    if (candidates.length > 1 && (picked || (!!pred && placement.guessed.has(pred)))) placement.guessed.add(run)
    if (places.length === 1 && !placement.guessed.has(run) && fromStages.length > 1) {
      // Settled, but it may have arrived by either route.
      for (const f of fromStages) {
        if (f.id !== places[0].id && declared(f.id, places[0].id)) placement.maybeMoves.push({ from: f.id, to: places[0].id, ts: run.startedAt })
      }
    }
    if (places.length > 1) {
      placement.maybe.set(run, places)
      for (const f of fromStages) {
        for (const to of places) {
          if (f.id !== to.id && declared(f.id, to.id)) placement.maybeMoves.push({ from: f.id, to: to.id, ts: run.startedAt })
        }
      }
    } else {
      placement.certain.set(run, places[0])
      visited.add(places[0].id)
    }
  })
  if (unsure) notices.push(`${pipeline.name}: an agent used by more than one stage could not be placed, so its runs may be on the wrong stage.`)
  return placement
}

const stageNodeId = (scope: string, pipelineId: string, stageId: string): string =>
  `stage:${scope}:${pipelineId}:${stageId}`

/** One pipeline as boxes and declared edges, lit by the runs a session made of it (none = a template
 *  showing the configured process before anything has run). */
function addPipeline(
  out: { nodes: GraphNode[]; edges: GraphEdge[]; notices: string[] },
  pipeline: ShipPipeline,
  scope: string,
  sessionId: string | null,
  runs: readonly SubRun[],
  agents: ReadonlyMap<string, ShipAgent>,
  now: number
): void {
  const preds = predecessors(runs)
  const order = declaredOrder(pipeline)
  const declared = new Set(pipeline.edges.map((e) => `${e.from}>${e.to}`))
  const placement = placeRuns(pipeline, runs, preds, order, out.notices)
  const stageOfRun = placement.certain

  // Walk the runs: which stage followed which, and whether a move went backwards.
  const traversals = new Map<string, { from: string; to: string; count: number; loop: boolean; ts: number; movedAt?: number; running: boolean }>()
  const reentered = new Set<string>()
  const entries = new Map<string, { count: number; ts: number; movedAt?: number; running: boolean }>()
  /** Hooks cannot confirm a route into or out of a guess, so it is counted but never shown moving. */
  const confirmed = (i: number): boolean =>
    !placement.guessed.has(runs[i]) && !(preds[i] && placement.guessed.has(preds[i]!))
  const noteMotion = (m: { movedAt?: number; running: boolean }, i: number): void => {
    if (!confirmed(i)) return
    m.movedAt = Math.max(m.movedAt ?? 0, runs[i].startedAt)
    m.running ||= isLive(runs[i], now)
  }
  let seen = new Set<string>()
  let epoch: number | undefined
  runs.forEach((run, i) => {
    const stage = stageOfRun.get(run)
    if (!stage) return
    if (run.epoch !== epoch) {
      epoch = run.epoch
      seen = new Set()
    }
    // After an uncertain run the route here is one of the maybe moves, and it is no entry either.
    if (preds[i] && placement.maybe.has(preds[i]!)) {
      seen.add(stage.id)
      return
    }
    const pred = preds[i] ? stageOfRun.get(preds[i]!) : undefined
    const startsOver = !!pred && !declared.has(`${pred.id}>${stage.id}`) && order.isLast(pred.id) && order.isFirst(stage.id)
    if (!pred || startsOver) {
      if (startsOver) seen = new Set()
      const entry = entries.get(stage.id) ?? { count: 0, ts: 0, running: false }
      entry.count++
      entry.ts = Math.max(entry.ts, run.startedAt)
      noteMotion(entry, i)
      entries.set(stage.id, entry)
    } else if (
      (placement.guessed.has(run) || placement.guessed.has(preds[i]!)) &&
      !pipeline.edges.some((e) => e.from === pred.id && e.to === stage.id && e.kind === 'next')
    ) {
      // Only a declared next move may touch a guess: anything else on a line here, and above all a
      // reject, would be the guess talking.
    } else if (pred.id !== stage.id) {
      const back = !placement.guessed.has(run) && !placement.guessed.has(preds[i]!) && order.precedes(stage.id, pred.id)
      if (back && seen.has(stage.id)) reentered.add(stage.id)
      const key = `${pred.id}>${stage.id}`
      const t = traversals.get(key) ?? { from: pred.id, to: stage.id, count: 0, loop: false, ts: 0, running: false }
      t.count++
      t.loop ||= back
      t.ts = Math.max(t.ts, run.startedAt)
      noteMotion(t, i)
      traversals.set(key, t)
    }
    seen.add(stage.id)
  })

  for (const stage of pipeline.stages) {
    const stageRuns = runs.filter((r) => stageOfRun.get(r)?.id === stage.id)
    const maybeRuns = runs.filter((r) => placement.maybe.get(r)?.some((st) => st.id === stage.id))
    const agent = agents.get(stage.agent)
    out.nodes.push({
      id: stageNodeId(scope, pipeline.id, stage.id),
      kind: 'stage',
      title: stage.label ?? stage.agent,
      subtitle: pipeline.triggerCommand ? `${pipeline.name} · /${pipeline.triggerCommand}` : pipeline.name,
      ...(sessionId ? { sessionId } : {}),
      // An open run that may be here keeps the stage lit. A finished one proves nothing.
      activity: activityOf([...stageRuns, ...maybeRuns.filter((r) => r.endedAt === undefined)], now),
      runs: stageRuns.length,
      ...(maybeRuns.length ? { maybeRuns: maybeRuns.length } : {}),
      ...(reentered.has(stage.id) ? { reentered: true } : {}),
      ...(agent ? {} : { missingAgent: true }),
      ...(agent?.color ? { color: agent.color } : {}),
      ...(agent?.description ? { description: agent.description } : {}),
      ...(stageRuns.length ? { lastEventTs: newestTs(stageRuns) } : {})
    })
  }

  const maybeOn = (from: string, to: string): Pick<GraphEdge, 'maybe' | 'lastEventTs'> => {
    const moves = placement.maybeMoves.filter((m) => m.from === from && m.to === to)
    return moves.length ? { maybe: moves.length, lastEventTs: Math.max(...moves.map((m) => m.ts)) } : {}
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
      ...(t ? { traversals: t.count, lastEventTs: t.ts, ...(t.loop ? { loop: true } : {}), ...(t.movedAt !== undefined ? { movedAt: t.movedAt } : {}), ...(t.running ? { running: true as const } : {}) } : {}),
      ...(maybeOn(edge.from, edge.to))
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
      ...(t.loop ? { loop: true } : {}),
      ...(t.movedAt !== undefined ? { movedAt: t.movedAt } : {}),
      ...(t.running ? { running: true as const } : {})
    })
  }

  // The session starts whatever ran with nothing before it.
  if (sessionId) {
    for (const [stageId, entry] of entries) {
      out.edges.push({
        id: `spawned:${scope}:${pipeline.id}:${stageId}`,
        source: `session:${sessionId}`,
        target: stageNodeId(scope, pipeline.id, stageId),
        kind: 'spawned',
        traversals: entry.count,
        lastEventTs: entry.ts,
        ...(entry.movedAt !== undefined ? { movedAt: entry.movedAt } : {}),
        ...(entry.running ? { running: true as const } : {})
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
    edge.movedAt = Math.max(edge.movedAt ?? 0, run.startedAt)
    if (isLive(run, now)) edge.running = true
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
  const ranTypes = new Set<string>()
  const ambiguous = new Set<string>()
  const lastTsBySession = new Map<string, number>()
  for (const [parent, allRuns] of runsByParent) {
    if (!known.has(parent)) continue
    const ts = newestTs(allRuns)
    if (ts !== undefined) lastTsBySession.set(parent, ts)
    // A run (a turn, or a reset to the next) was one pipeline or several in turn, so each is judged on
    // its own: a session that ran `ship` and then `triage` lit both, not the first and some boxes.
    const byPipeline = new Map<string, { pipeline: ShipPipeline; runs: SubRun[] }>()
    const taken = new Set<SubRun>()
    for (const epoch of new Set(allRuns.map((r) => r.epoch))) {
      let rest = allRuns.filter((r) => r.epoch === epoch)
      for (;;) {
        const { pipeline, tied } = choosePipeline(pipelines, rest)
        if (tied.length) {
          ambiguous.add(tied.map((p) => p.name).join(' or '))
          break
        }
        if (!pipeline) break
        const agentsOfPipeline = new Set(pipeline.stages.map((st) => st.agent))
        const mine = rest.filter((r) => agentsOfPipeline.has(r.type))
        const entry = byPipeline.get(pipeline.id) ?? { pipeline, runs: [] }
        entry.runs.push(...mine)
        byPipeline.set(pipeline.id, entry)
        for (const r of mine) taken.add(r)
        rest = rest.filter((r) => !agentsOfPipeline.has(r.type))
      }
    }
    for (const { pipeline, runs } of byPipeline.values()) addPipeline(out, pipeline, parent, parent, runs, agents, now)
    const rest = allRuns.filter((r) => !taken.has(r))
    if (rest.length) addObserved(out, parent, rest, agents, now)
    for (const r of allRuns) ranTypes.add(r.type)
  }
  for (const names of ambiguous) {
    out.notices.push(`These subagents fit ${names} equally, so they are drawn as observed, and nothing is called a rejection.`)
  }
  // A configured process nothing has run yet is still the machine's process: show it, unattached. One
  // whose agents did run is not shown as unrun, even when those runs belong to another pipeline.
  for (const pipeline of pipelines) {
    if (!pipeline.stages.some((st) => ranTypes.has(st.agent))) addPipeline(out, pipeline, 'template', null, [], agents, now)
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
  // One notice however many sessions hit it, and React keys the list on the text.
  const notices = [...new Set(out.notices)]
  return staleAt.length ? { ...out, notices, nextStaleAt: Math.min(...staleAt) } : { ...out, notices }
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

/** How long a move or a delivery still counts as passing along its line. */
export const TRANSIT_WINDOW_MS = 15_000

type TransitEdge = Pick<GraphEdge, 'kind' | 'latest' | 'traversals' | 'maybe' | 'running' | 'lastEventTs' | 'movedAt'>

/**
 * Whether a line runs one way. A context link is not a flow (read either way unless it says otherwise,
 * and pulled on demand when it does), so it gets no direction marks. Everything else does, including a
 * line nothing has used yet, because its direction is a fact about the process.
 */
export function edgeShowsDirection(edge: Pick<GraphEdge, 'kind'>): boolean {
  return edge.kind !== 'context'
}

const isRecent = (ts: number | undefined, now: number): boolean =>
  ts !== undefined && Math.abs(now - ts) < TRANSIT_WINDOW_MS

/**
 * Is something passing along this line right now? This decides what moves, and a moving mark keeps the
 * whole window at display rate (CLAUDE.md, "Idle energy"), so it answers no unless it has a reason:
 * - A message that landed moves for a moment. Queued has gone nowhere; failed and refused did not arrive.
 * - A move between agents moves while the run it led to is going, and for a moment after it started.
 *   That run, not the stage it reached: a stage entered twice has two lines in and only one is in use.
 * - A "maybe" does not, nor a move placed by a guess: hooks cannot say this route was taken, and motion
 *   would say that it was.
 * - An opener, a wait and a context link are relations, with nothing passing along them. A declared line
 *   nothing has used has no traversals.
 */
export function edgeInTransit(edge: TransitEdge, now: number): boolean {
  if (edge.kind === 'message') return edge.latest === 'delivered' && isRecent(edge.lastEventTs, now)
  if (edge.kind === 'context' || edge.kind === 'dependency' || edge.kind === 'opened') return false
  if (edge.maybe || !edge.traversals) return false
  return !!edge.running || isRecent(edge.movedAt, now)
}

/** When the next moving line goes still with no event to say so: for the view's one-shot timer. A line
 *  held by a running run is not here, because `nextStaleAt` and the run's own end rebuild the model. */
export function nextTransitChangeAt(edges: readonly TransitEdge[], now: number): number | undefined {
  let next: number | undefined
  for (const edge of edges) {
    if (edge.running || !edgeInTransit(edge, now)) continue
    const at = (edge.kind === 'message' ? edge.lastEventTs! : edge.movedAt!) + TRANSIT_WINDOW_MS
    if (next === undefined || at < next) next = at
  }
  return next
}
