import { describe, expect, it } from 'vitest'
import type { AgentGraphEvent, AgentGraphSnapshot } from '@shared/agent-graph'
import { WORKING_STALE_MS } from '@shared/agents/stale'
import type { ShipConfig, ShipPipeline } from '@shared/ship-config'
import {
  agentGraphStructureKey,
  buildAgentGraphModel,
  edgeInTransit,
  edgeShowsDirection,
  nextTransitChangeAt,
  reduceSubagents,
  TRANSIT_WINDOW_MS,
  type AgentGraphInput,
  type GraphEdge,
  type GraphSessionInput
} from './agentGraphModel'

const LOCAL = { kind: 'local' as const, label: 'this computer' }
const session = (id: string, over: Partial<GraphSessionInput> = {}): GraphSessionInput => ({
  id,
  kind: 'terminal',
  title: id,
  agentId: 'claude',
  machine: LOCAL,
  ...over
})

const snap = (events: AgentGraphEvent[], over: Partial<AgentGraphSnapshot> = {}): AgentGraphSnapshot => ({
  events,
  dropped: 0,
  capacity: 2000,
  history: 'board-log',
  historyTruncated: false,
  ...over
})

let seq = 0
const msg = (from: string, to: string, outcome: string, reason?: string): AgentGraphEvent => ({
  kind: 'delivery',
  id: `m${++seq}`,
  ts: ++seq,
  from,
  to,
  outcome,
  ...(reason ? { reason } : {})
})
const start = (nodeId: string, subId: string, type: string, ts: number, extra: object = {}): AgentGraphEvent => ({
  kind: 'subagent-start', id: `s-${subId}-${ts}`, ts, nodeId, subId, subagentType: type, ...extra
})
const end = (nodeId: string, subId: string, ts: number): AgentGraphEvent => ({
  kind: 'subagent-end', id: `e-${subId}-${ts}`, ts, nodeId, subId
})

const PIPELINE: ShipPipeline = {
  id: 'ship-change',
  name: 'Ship change',
  stages: [
    { id: 'impl', agent: 'implementer' },
    { id: 'docs', agent: 'doc-writer' },
    { id: 'review', agent: 'change-reviewer' }
  ],
  edges: [
    { from: 'impl', to: 'docs', kind: 'next' },
    { from: 'docs', to: 'review', kind: 'next' },
    { from: 'review', to: 'impl', kind: 'reject' },
    { from: 'review', to: 'docs', kind: 'reject' }
  ]
}

const ship = (over: Partial<ShipConfig> = {}): ShipConfig => ({
  machine: { kind: 'local', label: '' },
  agents: [
    { name: 'implementer', scope: 'global', color: 'blue', description: 'writes code' },
    { name: 'doc-writer', scope: 'global' },
    { name: 'change-reviewer', scope: 'global' }
  ],
  commands: [],
  workflows: [],
  skills: [],
  pipelines: [PIPELINE],
  graphSource: 'global',
  projectGraphPath: null,
  globalGraphPath: '/g',
  projectGraphExists: false,
  globalGraphExists: true,
  warnings: [],
  ...over
})

const build = (over: Partial<AgentGraphInput>) =>
  buildAgentGraphModel({ sessions: [], links: [], ropes: [], snapshot: snap([]), ship: null, now: 1000, ...over })
const edge = (edges: GraphEdge[], id: string): GraphEdge | undefined => edges.find((e) => e.id === id)

describe('messages', () => {
  it('counts each outcome on one line per direction, and colours it by the newest', () => {
    const m = build({
      sessions: [session('a'), session('b')],
      snapshot: snap([msg('a', 'b', 'queued'), msg('a', 'b', 'delivered'), msg('a', 'b', 'delivered'), msg('b', 'a', 'delivered')])
    })
    const ab = edge(m.edges, 'message:a:b')!
    expect(ab.counts).toEqual({ delivered: 2, queued: 1, failed: 0, refused: 0 })
    expect(ab.latest).toBe('delivered')
    expect(edge(m.edges, 'message:b:a')!.counts!.delivered).toBe(1)
  })

  it('a refusal reads as a refusal, with its reason', () => {
    const m = build({
      sessions: [session('a'), session('b')],
      snapshot: snap([msg('a', 'b', 'delivered'), msg('a', 'b', 'notPermitted', 'messaging-off')])
    })
    const ab = edge(m.edges, 'message:a:b')!
    expect(ab.counts!.refused).toBe(1)
    expect(ab.latest).toBe('refused')
    expect(ab.reason).toBe('messaging-off')
  })

  it("a stranger's message from another project of this core is not this project's", () => {
    const m = build({ sessions: [session('a')], snapshot: snap([msg('x', 'y', 'delivered')]) })
    expect(m.edges).toEqual([])
    expect(m.nodes.map((n) => n.id)).toEqual(['session:a'])
  })

  it('an endpoint this canvas does not hold stays, in words that claim neither deleted nor alive', () => {
    const m = build({ sessions: [session('a')], snapshot: snap([msg('a', 'gone', 'delivered')]) })
    expect(m.nodes.find((n) => n.id === 'session:gone')).toMatchObject({ kind: 'ghost', title: 'Session outside this project' })
    expect(edge(m.edges, 'message:a:gone')!.counts!.delivered).toBe(1)
  })
})

describe('which sessions get a box', () => {
  it('agents always; a plain terminal or a note only when a line touches it', () => {
    const plain = session('plain', { agentId: undefined })
    const linked = session('linked', { agentId: undefined })
    const note = session('note', { agentId: undefined, kind: 'note' })
    const lonelyNote = session('lonely', { agentId: undefined, kind: 'note' })
    const m = build({
      sessions: [session('a'), plain, linked, note, lonelyNote],
      links: [{ source: 'a', target: 'note' }],
      ropes: [{ source: 'a', target: 'linked', wait: false }]
    })
    expect(m.nodes.map((n) => n.id).sort()).toEqual(['session:a', 'session:linked', 'session:note'])
    expect(m.nodes.find((n) => n.id === 'session:note')!.kind).toBe('note')
  })

  it('carries state, machine, outcome and hand-over onto the box', () => {
    const ssh = { kind: 'ssh' as const, label: 'box' }
    const m = build({ sessions: [session('a', { state: 'working', machine: ssh, outcome: 'failed', handedOver: true })] })
    expect(m.nodes[0]).toMatchObject({ state: 'working', machine: ssh, outcome: 'failed', handedOver: true, sessionId: 'a' })
  })
})

describe('canvas relations', () => {
  it('ropes split into opened and waits, and a rope to a node not on this canvas is not drawn', () => {
    const m = build({
      sessions: [session('a'), session('b')],
      ropes: [
        { source: 'a', target: 'b', wait: false },
        { source: 'b', target: 'a', wait: true },
        { source: 'a', target: 'nope', wait: false }
      ]
    })
    expect(m.edges.map((e) => [e.id, e.kind])).toEqual([['opened:a:b', 'opened'], ['wait:b:a', 'dependency']])
  })

  it('a one-way context link points at its reader', () => {
    const towardTarget = build({ sessions: [session('a'), session('b')], links: [{ source: 'a', target: 'b', reader: 'b' }] })
    expect(towardTarget.edges[0]).toMatchObject({ source: 'session:a', target: 'session:b', kind: 'context' })
    const towardSource = build({ sessions: [session('a'), session('b')], links: [{ source: 'a', target: 'b', reader: 'a' }] })
    expect(towardSource.edges[0]).toMatchObject({ source: 'session:b', target: 'session:a' })
  })
})

describe('subagents with no ship graph: what was observed', () => {
  it('a chain of finished runs reads as a chain', () => {
    const m = build({
      sessions: [session('p')],
      snapshot: snap([start('p', '1', 'implementer', 10), end('p', '1', 20), start('p', '2', 'doc-writer', 30), end('p', '2', 40)])
    })
    expect(m.nodes.map((n) => n.id).sort()).toEqual(['session:p', 'sub:p:doc-writer', 'sub:p:implementer'])
    expect(edge(m.edges, 'spawned:p:implementer')).toMatchObject({ source: 'session:p', kind: 'spawned', traversals: 1 })
    expect(edge(m.edges, 'seq:p:implementer:doc-writer')).toMatchObject({ kind: 'observed', traversals: 1 })
    expect(edge(m.edges, 'seq:p:implementer:doc-writer')!.loop).toBeUndefined()
  })

  it('fan-out reads as siblings of the parent, not a chain nobody ran', () => {
    const m = build({
      sessions: [session('p')],
      snapshot: snap([start('p', '1', 'reviewer-a', 10), start('p', '2', 'reviewer-b', 11), end('p', '1', 20), end('p', '2', 21)])
    })
    expect(edge(m.edges, 'spawned:p:reviewer-a')).toBeDefined()
    expect(edge(m.edges, 'spawned:p:reviewer-b')).toBeDefined()
    expect(m.edges.some((e) => e.kind === 'observed')).toBe(false)
  })

  it('going back to an agent type that already ran is a loop', () => {
    const m = build({
      sessions: [session('p')],
      snapshot: snap([
        start('p', '1', 'impl', 10), end('p', '1', 20),
        start('p', '2', 'review', 30), end('p', '2', 40),
        start('p', '3', 'impl', 50), end('p', '3', 60)
      ])
    })
    expect(edge(m.edges, 'seq:p:review:impl')).toMatchObject({ loop: true, traversals: 1 })
    expect(edge(m.edges, 'seq:p:impl:review')!.loop).toBeUndefined()
    expect(m.nodes.find((n) => n.id === 'sub:p:impl')!.runs).toBe(2)
  })

  it('a retry of the same agent is a run count, not a self-edge', () => {
    const m = build({ sessions: [session('p')], snapshot: snap([start('p', '1', 'x', 10), end('p', '1', 20), start('p', '2', 'x', 30)]) })
    expect(m.edges.map((e) => e.id)).toEqual(['spawned:p:x'])
    expect(m.nodes.find((n) => n.id === 'sub:p:x')).toMatchObject({ runs: 2, activity: 'running' })
  })

  it('a subagent of a session on no canvas is drawn nowhere', () => {
    const m = build({ sessions: [session('a')], snapshot: snap([start('other', '1', 'x', 10)]) })
    expect(m.nodes.map((n) => n.id)).toEqual(['session:a'])
  })

  it('caps the agent types per session and names what it dropped', () => {
    const events = Array.from({ length: 30 }, (_, i) => start('p', `${i}`, `type-${i}`, i + 1))
    const m = build({ sessions: [session('p')], snapshot: snap(events) })
    expect(m.nodes.filter((n) => n.kind === 'subagent')).toHaveLength(24)
    expect(m.notices.join()).toMatch(/started 30 agent types/)
  })
})

describe('reduceSubagents', () => {
  it('a native start replacing its tool-path card is one run, keeping the original start', () => {
    const runs = reduceSubagents([start('p', 'tool', 'x', 10), start('p', 'native', 'x', 12, { supersedes: 'tool' })]).get('p')!
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ subId: 'native', startedAt: 10 })
  })

  it('a stop followed by a start of the same id is a new pass, and the first keeps its end', () => {
    const runs = reduceSubagents([start('p', 'a', 'x', 10), end('p', 'a', 20), start('p', 'a', 'x', 30)]).get('p')!
    expect(runs).toHaveLength(2)
    expect(runs[0].endedAt).toBe(20)
    expect(runs[1].endedAt).toBeUndefined()
  })

  it('a second end does not move the first', () => {
    const runs = reduceSubagents([start('p', 'a', 'x', 10), end('p', 'a', 20), end('p', 'a', 50)]).get('p')!
    expect(runs[0].endedAt).toBe(20)
  })

  it('activity moves only the signal, on the open pass', () => {
    const activity = (ts: number): AgentGraphEvent => ({ kind: 'subagent-activity', id: 'activity:a', ts, nodeId: 'p', subId: 'a' })
    const runs = reduceSubagents([start('p', 'a', 'x', 10), activity(15), end('p', 'a', 20), activity(30)]).get('p')!
    expect(runs[0]).toMatchObject({ lastSignalTs: 15, lastEventTs: 20 })
  })

  it('a session reset ends what was running', () => {
    const reset: AgentGraphEvent = { kind: 'session-reset', id: 'r', ts: 50, nodeId: 'p' }
    expect(reduceSubagents([start('p', 'a', 'x', 10), reset]).get('p')![0].endedAt).toBe(50)
  })

  it('an end with no start is ignored', () => {
    expect(reduceSubagents([end('p', 'a', 20)]).get('p')).toBeUndefined()
  })
})

describe('with a ship graph', () => {
  const run = (...spec: Array<[string, string, number, number?]>): AgentGraphEvent[] =>
    spec.flatMap(([id, type, s, e]) => [start('p', id, type, s), ...(e ? [end('p', id, e)] : [])])

  it('with nothing run yet, the configured process shows unattached', () => {
    const m = build({ sessions: [session('p')], ship: ship() })
    const stages = m.nodes.filter((n) => n.kind === 'stage')
    expect(stages.map((n) => n.id)).toEqual(['stage:template:ship-change:impl', 'stage:template:ship-change:docs', 'stage:template:ship-change:review'])
    expect(stages.every((n) => n.activity === 'idle' && !n.sessionId)).toBe(true)
    expect(m.edges.filter((e) => e.kind === 'ship-reject')).toHaveLength(2)
    expect(m.edges.some((e) => e.kind === 'spawned')).toBe(false)
  })

  it('live subagents map onto stages by agent name', () => {
    const m = build({ sessions: [session('p')], ship: ship(), snapshot: snap(run(['1', 'implementer', 10, 20], ['2', 'doc-writer', 30])) })
    const stage = (id: string) => m.nodes.find((n) => n.id === `stage:p:ship-change:${id}`)!
    expect(stage('impl')).toMatchObject({ activity: 'done', runs: 1, sessionId: 'p', color: 'blue', description: 'writes code' })
    expect(stage('docs')).toMatchObject({ activity: 'running', runs: 1 })
    expect(stage('review')).toMatchObject({ activity: 'idle', runs: 0 })
    expect(edge(m.edges, 'spawned:p:ship-change:impl')).toMatchObject({ source: 'session:p', kind: 'spawned' })
    expect(edge(m.edges, 'ship:p:ship-change:impl:docs:next')!.traversals).toBe(1)
    expect(m.nodes.some((n) => n.kind === 'subagent')).toBe(false)
    expect(m.nodes.some((n) => n.id.startsWith('stage:template'))).toBe(false) // it has an instance now
  })

  it('a stage re-entered after a later stage is the reject loop', () => {
    const m = build({
      sessions: [session('p')],
      ship: ship(),
      snapshot: snap(run(
        ['1', 'implementer', 10, 20],
        ['2', 'doc-writer', 30, 40],
        ['3', 'change-reviewer', 50, 60],
        ['4', 'implementer', 70, 80]
      ))
    })
    expect(edge(m.edges, 'ship:p:ship-change:review:impl:reject')).toMatchObject({ kind: 'ship-reject', traversals: 1, loop: true })
    expect(m.nodes.find((n) => n.id === 'stage:p:ship-change:impl')).toMatchObject({ reentered: true, runs: 2 })
    expect(m.nodes.find((n) => n.id === 'stage:p:ship-change:docs')!.reentered).toBeUndefined()
    // The forward edges stayed forward.
    expect(edge(m.edges, 'ship:p:ship-change:impl:docs:next')!.loop).toBeUndefined()
  })

  it('the second pass forward after a rejection is not itself a loop', () => {
    const m = build({
      sessions: [session('p')],
      ship: ship(),
      snapshot: snap(run(
        ['1', 'implementer', 10, 20],
        ['2', 'doc-writer', 30, 40],
        ['3', 'change-reviewer', 50, 60],
        ['4', 'implementer', 70, 80],
        ['5', 'doc-writer', 90, 100],
        ['6', 'change-reviewer', 110, 120]
      ))
    })
    expect(edge(m.edges, 'ship:p:ship-change:impl:docs:next')).toMatchObject({ traversals: 2 })
    expect(edge(m.edges, 'ship:p:ship-change:impl:docs:next')!.loop).toBeUndefined()
    expect(edge(m.edges, 'ship:p:ship-change:docs:review:next')!.loop).toBeUndefined()
    expect(edge(m.edges, 'ship:p:ship-change:review:impl:reject')).toMatchObject({ traversals: 1, loop: true })
    expect(m.nodes.find((n) => n.id === 'stage:p:ship-change:docs')!.reentered).toBeUndefined()
    expect(m.nodes.find((n) => n.id === 'stage:p:ship-change:impl')!.reentered).toBe(true)
  })

  it('work along a route the file does not declare still appears, marked', () => {
    const m = build({ sessions: [session('p')], ship: ship(), snapshot: snap(run(['1', 'implementer', 10, 20], ['2', 'change-reviewer', 30])) })
    expect(edge(m.edges, 'ship:p:ship-change:impl:review:undeclared')).toMatchObject({ kind: 'observed', undeclared: true, traversals: 1 })
  })

  it('a subagent outside the pipeline is drawn observed, beside it', () => {
    const m = build({ sessions: [session('p')], ship: ship(), snapshot: snap(run(['1', 'implementer', 10, 20], ['2', 'explorer', 30])) })
    expect(m.nodes.find((n) => n.id === 'sub:p:explorer')).toBeDefined()
    expect(m.nodes.find((n) => n.id === 'stage:p:ship-change:impl')).toBeDefined()
  })

  it('no matching subagent means the pipeline stays a template and the runs are observed', () => {
    const m = build({ sessions: [session('p')], ship: ship(), snapshot: snap(run(['1', 'explorer', 10])) })
    expect(m.nodes.find((n) => n.id === 'sub:p:explorer')).toBeDefined()
    expect(m.nodes.find((n) => n.id === 'stage:template:ship-change:impl')).toBeDefined()
  })

  it('shows the trigger beside the pipeline name', () => {
    const m = build({ ship: ship({ pipelines: [{ ...PIPELINE, triggerCommand: 'ship-change' }] }) })
    expect(m.nodes.find((n) => n.kind === 'stage')!.subtitle).toBe('Ship change · /ship-change')
  })

  it('a stage naming an agent this machine lacks says so', () => {
    const m = build({ sessions: [session('p')], ship: ship({ agents: [] }) })
    expect(m.nodes.filter((n) => n.kind === 'stage').every((n) => n.missingAgent)).toBe(true)
  })

  it('two sessions get a pipeline instance each, with no shared ids', () => {
    const ev = [start('p', '1', 'implementer', 10), start('q', '2', 'implementer', 11)]
    const m = build({ sessions: [session('p'), session('q')], ship: ship(), snapshot: snap(ev) })
    expect(m.nodes.filter((n) => n.id.endsWith(':impl')).map((n) => n.id).sort()).toEqual(['stage:p:ship-change:impl', 'stage:q:ship-change:impl'])
    expect(new Set(m.nodes.map((n) => n.id)).size).toBe(m.nodes.length)
    expect(new Set(m.edges.map((e) => e.id)).size).toBe(m.edges.length)
  })
})

describe('nextStaleAt', () => {
  it('names when the oldest open run goes stale, and is absent with nothing open', () => {
    const open = build({ sessions: [session('p')], snapshot: snap([start('p', '1', 'x', 10), start('p', '2', 'y', 500)]), now: 600 })
    expect(open.nextStaleAt).toBe(10 + WORKING_STALE_MS)
    const closed = build({ sessions: [session('p')], snapshot: snap([start('p', '1', 'x', 10), end('p', '1', 20)]), now: 600 })
    expect(closed.nextStaleAt).toBeUndefined()
    const past = build({ sessions: [session('p')], snapshot: snap([start('p', '1', 'x', 10)]), now: 10 + WORKING_STALE_MS + 1 })
    expect(past.nextStaleAt).toBeUndefined()
    const elsewhere = build({ sessions: [session('p')], snapshot: snap([start('other', '1', 'x', 10)]), now: 600 })
    expect(elsewhere.nextStaleAt).toBeUndefined()
  })
})

describe('staleness', () => {
  it('a run with no signal past the stale line is no longer claimed as running', () => {
    const events = [start('p', '1', 'x', 10)]
    expect(build({ sessions: [session('p')], snapshot: snap(events), now: 20 }).nodes.find((n) => n.kind === 'subagent')!.activity).toBe('running')
    expect(build({ sessions: [session('p')], snapshot: snap(events), now: 10 + WORKING_STALE_MS + 1 }).nodes.find((n) => n.kind === 'subagent')!.activity).toBe('stale')
  })
})

describe('notices', () => {
  it('name each horizon the counts have', () => {
    const m = build({ snapshot: snap([], { dropped: 5, historyTruncated: true, history: 'memory' }) })
    expect(m.notices.join('\n')).toMatch(/newest 2000.*5 have gone/)
    expect(m.notices.join('\n')).toMatch(/older messages are not counted/)
    expect(m.notices.join('\n')).toMatch(/this app run only/)
  })

  it('a /shipit run in another project is not this project\'s notice', () => {
    const elsewhere = snap([start('other-project-node', '1', 'shipit-agent', 1)])
    expect(build({ sessions: [session('a')], snapshot: elsewhere }).notices.join()).not.toMatch(/shipit/)
  })

  it('a full history says nothing', () => {
    expect(build({ snapshot: snap([]) }).notices).toEqual([])
  })

  it('names the Claude-only and shipit limits, when they apply', () => {
    expect(build({ sessions: [session('a', { agentId: 'codex' })] }).notices.join()).toMatch(/Claude-only/)
    expect(build({ sessions: [session('a')] }).notices.join()).not.toMatch(/Claude-only/)
    expect(build({ sessions: [session('a')], snapshot: snap([start('a', '1', 'shipit-agent', 1)]) }).notices.join()).toMatch(/shipit/)
  })
})

describe('agentGraphStructureKey', () => {
  it('moves on a new line, and not on a count or a state', () => {
    const base = { sessions: [session('a'), session('b')] }
    const one = build({ ...base, snapshot: snap([msg('a', 'b', 'delivered')]) })
    const two = build({ ...base, snapshot: snap([msg('a', 'b', 'delivered'), msg('a', 'b', 'notPermitted')]) })
    const stateChanged = build({ sessions: [session('a', { state: 'working' }), session('b')], snapshot: snap([msg('a', 'b', 'delivered')]) })
    const newLine = build({ ...base, snapshot: snap([msg('a', 'b', 'delivered'), msg('b', 'a', 'delivered')]) })
    expect(agentGraphStructureKey(two)).toBe(agentGraphStructureKey(one))
    expect(agentGraphStructureKey(stateChanged)).toBe(agentGraphStructureKey(one))
    expect(agentGraphStructureKey(newLine)).not.toBe(agentGraphStructureKey(one))
  })
})

describe('what is in transit', () => {
  const NOW = 1_000_000
  const old = NOW - TRANSIT_WINDOW_MS - 1
  const base = { id: 'e', source: 'a', target: 'b' }
  const delivered = (lastEventTs: number): GraphEdge => ({ ...base, kind: 'message', latest: 'delivered', lastEventTs })

  it('a landed message moves for a moment, then stops', () => {
    expect(edgeInTransit(delivered(NOW - 1000), NOW)).toBe(true)
    expect(edgeInTransit(delivered(old), NOW)).toBe(false)
  })

  it('a queued, failed or refused message has not passed along the line', () => {
    for (const latest of ['queued', 'failed', 'refused'] as const) {
      expect(edgeInTransit({ ...base, kind: 'message', latest, lastEventTs: NOW }, NOW), latest).toBe(false)
    }
  })

  it('relations never move, whatever their clock says', () => {
    for (const kind of ['context', 'dependency', 'opened'] as const) {
      expect(edgeInTransit({ ...base, kind, lastEventTs: NOW, running: true, traversals: 1 }, NOW), kind).toBe(false)
    }
  })

  it('a declared line nothing used does not move, and a maybe does not claim the route', () => {
    expect(edgeInTransit({ ...base, kind: 'ship-next' }, NOW)).toBe(false)
    expect(edgeInTransit({ ...base, kind: 'ship-reject', maybe: 1, lastEventTs: NOW }, NOW)).toBe(false)
    expect(edgeInTransit({ ...base, kind: 'ship-next', traversals: 1, maybe: 1, running: true, lastEventTs: NOW }, NOW)).toBe(false)
  })

  it('a used line moves while its run goes on, and for a moment after it started', () => {
    expect(edgeInTransit({ ...base, kind: 'ship-next', traversals: 1, running: true, movedAt: old }, NOW)).toBe(true)
    expect(edgeInTransit({ ...base, kind: 'observed', traversals: 1, movedAt: NOW - 1 }, NOW)).toBe(true)
    expect(edgeInTransit({ ...base, kind: 'ship-reject', traversals: 2, movedAt: old }, NOW)).toBe(false)
  })

  it('any later event on a line is a pulse, not a reason to move: motion reads only a confirmed move', () => {
    expect(edgeInTransit({ ...base, kind: 'ship-next', traversals: 1, lastEventTs: NOW }, NOW)).toBe(false)
    expect(nextTransitChangeAt([{ ...base, kind: 'observed', traversals: 1, movedAt: NOW - 1000, lastEventTs: NOW }], NOW)).toBe(NOW - 1000 + TRANSIT_WINDOW_MS)
  })

  it('a clock far ahead does not move a line for as long as the skew lasts', () => {
    expect(edgeInTransit(delivered(NOW + TRANSIT_WINDOW_MS + 1), NOW)).toBe(false)
  })

  it('only a context link has no direction to show', () => {
    expect(edgeShowsDirection({ kind: 'context' })).toBe(false)
    for (const kind of ['message', 'dependency', 'opened', 'spawned', 'observed', 'ship-next', 'ship-reject'] as const) {
      expect(edgeShowsDirection({ kind }), kind).toBe(true)
    }
  })

  it('arms for the first moment to end, and not for a line a run is holding or one already still', () => {
    expect(nextTransitChangeAt([], NOW)).toBeUndefined()
    expect(nextTransitChangeAt([delivered(old)], NOW)).toBeUndefined()
    expect(nextTransitChangeAt([{ ...base, kind: 'observed', traversals: 1, running: true, movedAt: NOW }], NOW)).toBeUndefined()
    expect(nextTransitChangeAt([delivered(NOW - 5000), delivered(NOW - 1000)], NOW)).toBe(NOW - 5000 + TRANSIT_WINDOW_MS)
  })

  describe('from a real run', () => {
    const pipeline: ShipPipeline = {
      id: 'p', name: 'P',
      stages: [{ id: 'i', agent: 'I' }, { id: 'd', agent: 'D' }, { id: 'r', agent: 'R' }],
      edges: [{ from: 'i', to: 'd', kind: 'next' }, { from: 'd', to: 'r', kind: 'next' }, { from: 'r', to: 'i', kind: 'reject' }]
    }
    const ship: ShipConfig = {
      machine: { kind: 'local', label: '' }, agents: [], commands: [], workflows: [], skills: [],
      pipelines: [pipeline], graphSource: 'project', projectGraphPath: null, globalGraphPath: '/g',
      projectGraphExists: true, globalGraphExists: false, warnings: []
    }
    const started = (id: string, type: string, ts: number): AgentGraphEvent => ({ kind: 'subagent-start', id: `s${id}`, ts, nodeId: 'a', subId: id, subagentType: type })
    const ended = (id: string, ts: number): AgentGraphEvent => ({ kind: 'subagent-end', id: `e${id}`, ts, nodeId: 'a', subId: id })
    const moving = (events: AgentGraphEvent[], now: number): string[] => {
      const m = buildAgentGraphModel({ sessions: [session('a')], links: [], ropes: [], snapshot: snap(events), ship, now })
      return m.edges.filter((e) => edgeInTransit(e, now)).map((e) => `${e.source.split(':').pop()}>${e.target.split(':').pop()}`).sort()
    }
    const LONG = TRANSIT_WINDOW_MS * 4

    it('the line into the running stage moves, and the ones behind it do not', () => {
      const now = LONG * 3
      expect(moving([started('1', 'I', now - LONG)], now)).toEqual(['a>i'])
      expect(moving([started('1', 'I', now - LONG * 2), ended('1', now - LONG), started('2', 'D', now - LONG + 1)], now)).toEqual(['i>d'])
    })

    it('a second entry into a stage moves only the line it came along', () => {
      const now = LONG * 9
      const t = now - LONG * 6
      const events = [
        started('1', 'I', t), ended('1', t + 1),
        started('2', 'D', t + 2), ended('2', t + 3),
        started('3', 'R', t + 4), ended('3', t + 5),
        started('4', 'I', now - LONG)
      ]
      expect(moving(events, now)).toEqual(['r>i'])
    })

    it('nothing moves once it is over, and a stale run stops holding its line', () => {
      const now = WORKING_STALE_MS * 3
      expect(moving([started('1', 'I', 1), ended('1', 2)], now)).toEqual([])
      expect(moving([started('1', 'I', 1)], now)).toEqual([])
    })

    describe('a run placed by a guess', () => {
      // Two next stages share an agent, so `resolve` picks one, and nothing confirms which.
      const fork: ShipPipeline = {
        id: 'f', name: 'F',
        stages: [{ id: 'a', agent: 'A' }, { id: 'b1', agent: 'B' }, { id: 'b2', agent: 'B' }, { id: 'c', agent: 'C' }],
        edges: [{ from: 'a', to: 'b1', kind: 'next' }, { from: 'a', to: 'b2', kind: 'next' }, { from: 'b1', to: 'c', kind: 'next' }, { from: 'b2', to: 'c', kind: 'next' }]
      }
      const modelOf = (pipelines: ShipPipeline[], events: AgentGraphEvent[], now: number): GraphEdge[] =>
        buildAgentGraphModel({ sessions: [session('a')], links: [], ropes: [], snapshot: snap(events), ship: { ...ship, pipelines }, now }).edges
      const line = (edges: GraphEdge[], from: string, to: string): GraphEdge | undefined =>
        edges.find((e) => e.source.endsWith(`:${from}`) && e.target.endsWith(`:${to}`))

      it('counts the line into it and does not move it, running or just started', () => {
        const now = LONG * 3
        const edges = modelOf([fork], [started('1', 'A', now - 3), ended('1', now - 2), started('2', 'B', now - 1)], now)
        const into = line(edges, 'a', 'b1')!
        expect(into.traversals).toBe(1)
        expect(into.running).toBeUndefined()
        expect(into.movedAt).toBeUndefined()
        expect(into.lastEventTs).toBe(now - 1) // the pulse keeps its event
        expect(edgeInTransit(into, now)).toBe(false)
        expect(nextTransitChangeAt(edges.filter((e) => e === into), now)).toBeUndefined()
      })

      it('does not move the line out of it either, though the run after it is certain', () => {
        const now = LONG * 3
        const events = [started('1', 'A', now - 5), ended('1', now - 4), started('2', 'B', now - 3), ended('2', now - 2), started('3', 'C', now - 1)]
        const out = line(modelOf([fork], events, now), 'b1', 'c')!
        expect(out.traversals).toBe(1)
        expect(edgeInTransit(out, now)).toBe(false)
      })

      it('does not move the entry into a stage picked between two with no order', () => {
        const now = LONG * 3
        const twins: ShipPipeline = { id: 't', name: 'T', stages: [{ id: 'x1', agent: 'X' }, { id: 'x2', agent: 'X' }], edges: [] }
        const entry = modelOf([twins], [started('1', 'X', now - 1)], now).find((e) => e.kind === 'spawned')!
        expect(entry.traversals).toBe(1)
        expect(edgeInTransit(entry, now)).toBe(false)
      })

      it('an unambiguous stage still moves, so the rule is not simply off', () => {
        const now = LONG * 3
        const edges = modelOf([pipeline], [started('1', 'I', now - 2), ended('1', now - 1)], now)
        expect(edgeInTransit(edges.find((e) => e.kind === 'spawned')!, now)).toBe(true)
      })
    })

    it('with no file, the observed line moves the same way, and the unattached template never', () => {
      const now = LONG * 3
      const noFile = (events: AgentGraphEvent[]): GraphEdge[] =>
        buildAgentGraphModel({ sessions: [session('a')], links: [], ropes: [], snapshot: snap(events), ship: null, now }).edges
      const observed = noFile([started('1', 'x', now - LONG), ended('1', now - LONG + 1), started('2', 'y', now - LONG + 2)])
      expect(observed.filter((e) => edgeInTransit(e, now)).map((e) => e.id)).toEqual(['seq:a:x:y'])
      expect(moving([], now)).toEqual([])
    })
  })
})
