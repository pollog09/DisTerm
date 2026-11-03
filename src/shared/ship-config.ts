// A machine's ship process, as discovered ON that machine: its Claude agents and what they can run
// (`~/.claude`, the project's `.claude`), plus an optional `ship-graph.json` saying how work moves
// between them. There is no built-in process: with no file, the graph view draws what it observes.
//
// `ship-graph.json` travels in git, so everything in it is hostile display data. It is sanitized in
// `core/ship-config/sanitize.ts`, and nothing in it is ever executed: `trigger.command` is a name
// shown beside the pipeline, never a command anyone runs.

export type ShipEdgeKind = 'next' | 'reject'

export interface ShipStage {
  id: string
  /** The agent type this stage runs, matched against live subagents by exact name. */
  agent: string
  label?: string
}

export interface ShipEdge {
  from: string
  to: string
  kind: ShipEdgeKind
}

export interface ShipPipeline {
  id: string
  name: string
  /** Display only. */
  triggerCommand?: string
  stages: ShipStage[]
  edges: ShipEdge[]
}

/**
 * The `next` edges that define an order, and any that close a cycle. Walked in stage-list order, so the
 * edge that loses is the one returning to where the walk started: a way back written without
 * `"kind": "reject"`, which is the only honest reading of a process that has a first stage at all.
 */
export function splitNextCycle(
  stageIds: readonly string[],
  edges: readonly ShipEdge[]
): { order: ShipEdge[]; cycle: ShipEdge[] } {
  const out = new Map<string, ShipEdge[]>()
  for (const e of edges) if (e.kind === 'next') out.set(e.from, [...(out.get(e.from) ?? []), e])
  const order: ShipEdge[] = []
  const cycle: ShipEdge[] = []
  const state = new Map<string, 'walking' | 'done'>()
  const visit = (id: string): void => {
    state.set(id, 'walking')
    for (const e of out.get(id) ?? []) {
      const seen = state.get(e.to)
      if (seen === 'walking') {
        cycle.push(e)
        continue
      }
      order.push(e)
      if (!seen) visit(e.to)
    }
    state.set(id, 'done')
  }
  for (const id of stageIds) if (!state.has(id)) visit(id)
  return { order, cycle }
}

export type ShipScope = 'global' | 'project'

/** The eight names Claude Code accepts for an agent colour. Anything else is dropped. */
export const SHIP_AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'] as const
export type ShipAgentColor = (typeof SHIP_AGENT_COLORS)[number]

export interface ShipAgent {
  name: string
  description?: string
  model?: string
  color?: ShipAgentColor
  tools?: string[]
  scope: ShipScope
  /** A global agent of the same name exists and this project agent replaces it. */
  overridesGlobal?: true
}

export interface ShipMachine {
  kind: 'local' | 'ssh'
  /** The SSH host for `ssh`; empty for `local`, which the renderer names itself (`thisMachine()`). */
  label: string
}

export interface ShipConfig {
  machine: ShipMachine
  agents: ShipAgent[]
  commands: string[]
  workflows: string[]
  skills: string[]
  pipelines: ShipPipeline[]
  /** Which file `pipelines` came from; null = no usable file, so the graph is observation only. */
  graphSource: ShipScope | null
  /** Where the project's file is or would be; null on a project with no folder. */
  projectGraphPath: string | null
  globalGraphPath: string
  projectGraphExists: boolean
  globalGraphExists: boolean
  /** Something sits at that path that is not a readable regular file (a folder, a FIFO, a dead link):
   *  neither Open nor Create can do anything useful with it. A warning names it too. */
  projectGraphBlocked?: true
  globalGraphBlocked?: true
  /** Everything dropped, skipped or refused on the way here. Shown in the UI, never swallowed. */
  warnings: string[]
}

export type ShipConfigResult = { ok: true; config: ShipConfig } | { ok: false; reason: string }

export type ShipGraphCreateResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'exists' | 'unsupported' | 'failed'; message: string }

/** A view's hold on config polling. Renewed while the view lives, and left to expire if it dies with
 *  its renderer or its relay peer, which send no goodbye. Generous, because Chromium throttles a hidden
 *  window's timers to about one a minute; a renewal after an expiry simply starts the poll again. */
export const SHIP_LEASE_MS = 180_000
export const SHIP_LEASE_RENEW_MS = 60_000

/** Hold a lease until the returned stop is called. One implementation for both transports. */
export function holdShipConfigLease(send: { subscribe(leaseId: string): void; unsubscribe(leaseId: string): void }): () => void {
  const leaseId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  send.subscribe(leaseId)
  const timer = setInterval(() => send.subscribe(leaseId), SHIP_LEASE_RENEW_MS)
  return () => {
    clearInterval(timer)
    send.unsubscribe(leaseId)
  }
}

/** The file created on request. An example, not a default: it only exists if someone asks for it. */
export const SHIP_GRAPH_EXAMPLE = {
  pipelines: [
    {
      id: 'ship-change',
      name: 'Ship change',
      trigger: { command: 'ship-change' },
      stages: [
        { id: 'impl', agent: 'implementer' },
        { id: 'docs', agent: 'doc-writer' },
        { id: 'review', agent: 'change-reviewer' }
      ],
      edges: [
        { from: 'impl', to: 'docs' },
        { from: 'docs', to: 'review' },
        { from: 'review', to: 'impl', kind: 'reject' },
        { from: 'review', to: 'docs', kind: 'reject' }
      ]
    }
  ]
}
