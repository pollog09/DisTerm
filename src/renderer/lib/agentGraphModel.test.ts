import { describe, expect, it } from 'vitest'
import type { AgentGraphEvent, AgentGraphSnapshot } from '@shared/agent-graph'
import { WORKING_STALE_MS } from '@shared/agents/stale'
import type { ShipConfig, ShipPipeline } from '@shared/ship-config'
import {
  agentGraphStructureKey,
  buildAgentGraphModel,
  reduceSubagents,
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
