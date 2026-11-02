/**
 * Telling a second ship run from a rejection, end to end: real Claude hook payloads through the REAL
 * normalizer and agent-status mirror, into the core's graph log, out through the snapshot read, and
 * into the renderer's model, exactly as the view builds it.
 *
 * The counting rule is the whole point of the reject loop: a clean second run drawn as a rejection says
 * a review failed when it did not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentGraphLog } from '../../src/core/agent-graph/event-log'
import { readAgentGraphSnapshot } from '../../src/core/agent-graph/handlers'
import { recordAgentEvent, _resetForTest } from '../../src/core/agent-status-mirror'
import { normalizeClaude } from '../../src/shared/agents/normalize'
import type { ShipConfig, ShipEdge } from '../../src/shared/ship-config'
import { buildAgentGraphModel, type GraphEdge } from '../../src/renderer/lib/agentGraphModel'

const NODE = 'orch'
const SESSION = '11111111-1111-4111-8111-000000000001'
let clock = 1_000_000
let agentSeq = 0

function hook(payload: Record<string, unknown>): void {
  clock += 10
  vi.setSystemTime(clock)
  const ev = normalizeClaude({ nodeId: NODE, agentId: 'claude', payload: { session_id: SESSION, ...payload } })
  if (ev) recordAgentEvent(ev)
}
const userPrompt = (): void => hook({ hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
const clear = (): void => hook({ hook_event_name: 'SessionStart', source: 'clear' })
function run(...types: string[]): void {
  for (const agent_type of types) {
    const agent_id = `a${(++agentSeq).toString(16).padStart(16, '0')}`
    hook({ hook_event_name: 'SubagentStart', agent_id, agent_type })
    hook({ hook_event_name: 'SubagentStop', agent_id, agent_type })
  }
}

const NEXT: ShipEdge[] = [
  { from: 'impl', to: 'docs', kind: 'next' },
  { from: 'docs', to: 'review', kind: 'next' }
]
const REJECT: ShipEdge = { from: 'review', to: 'impl', kind: 'reject' }

function ship(edges: ShipEdge[]): ShipConfig {
  return {
    machine: { kind: 'local', label: '' },
    agents: [],
    commands: [],
    workflows: [],
    skills: [],
    pipelines: [{
      id: 'ship-change',
      name: 'Ship change',
      stages: [{ id: 'impl', agent: 'implementer' }, { id: 'docs', agent: 'doc-writer' }, { id: 'review', agent: 'change-reviewer' }],
      edges
    }],
    graphSource: 'project',
    projectGraphPath: null,
    globalGraphPath: '/g',
    projectGraphExists: true,
    globalGraphExists: false,
    warnings: []
  }
}

async function model(edges: ShipEdge[] | null) {
  const snapshot = await readAgentGraphSnapshot('P', { route: () => ({ kind: 'unsupported' }) })
  return buildAgentGraphModel({
    sessions: [{ id: NODE, kind: 'terminal', title: 'Orchestrator', agentId: 'claude', machine: { kind: 'local', label: 'x' } }],
    links: [],
    ropes: [],
    snapshot,
    ship: edges ? ship(edges) : null,
    now: clock
  })
}
const edge = (edges: GraphEdge[], id: string) => edges.find((e) => e.id === id)
const REVIEW_TO_IMPL = 'ship:orch:ship-change:review:impl:reject'
const impl = 'stage:orch:ship-change:impl'

beforeEach(() => {
  _resetForTest()
  vi.useFakeTimers()
  clock = 1_000_000
  vi.setSystemTime(clock)
  hook({ hook_event_name: 'SessionStart', source: 'startup' })
  userPrompt()
})

afterEach(() => {
  _resetForTest()
  vi.useRealTimers()
})

describe('a second ship run is not a rejection', () => {
  it('after /clear: no loop, no re-entry, and the session started the pipeline twice', async () => {
    run('implementer', 'doc-writer', 'change-reviewer')
    clear()
    run('implementer', 'doc-writer', 'change-reviewer')
    const m = await model([...NEXT, REJECT])
    expect(edge(m.edges, REVIEW_TO_IMPL)!.traversals).toBeUndefined()
    expect(edge(m.edges, REVIEW_TO_IMPL)!.loop).toBeUndefined()
    expect(m.nodes.find((n) => n.id === impl)).toMatchObject({ runs: 2 })
    expect(m.nodes.find((n) => n.id === impl)!.reentered).toBeUndefined()
    expect(edge(m.edges, 'spawned:orch:ship-change:impl')!.traversals).toBe(2)
    expect(edge(m.edges, 'ship:orch:ship-change:impl:docs:next')!.traversals).toBe(2)
  })

  it('after a new user prompt: the same', async () => {
    run('implementer', 'doc-writer', 'change-reviewer')
    userPrompt()
    run('implementer', 'doc-writer', 'change-reviewer')
    const m = await model([...NEXT, REJECT])
    expect(edge(m.edges, REVIEW_TO_IMPL)!.loop).toBeUndefined()
    expect(m.nodes.find((n) => n.id === impl)!.reentered).toBeUndefined()
  })

  it('in one turn with no reject declared, last stage back to first is a new run, not an undeclared loop', async () => {
    run('implementer', 'doc-writer', 'change-reviewer', 'implementer', 'doc-writer', 'change-reviewer')
    const m = await model(NEXT)
    expect(m.edges.some((e) => e.undeclared)).toBe(false)
    expect(m.edges.some((e) => e.loop)).toBe(false)
    expect(m.nodes.find((n) => n.id === impl)!.reentered).toBeUndefined()
    expect(edge(m.edges, 'spawned:orch:ship-change:impl')!.traversals).toBe(2)
  })

  it('observed mode: a new prompt starts over too', async () => {
    run('implementer', 'doc-writer')
    userPrompt()
    run('implementer', 'doc-writer')
    const m = await model(null)
    expect(m.edges.some((e) => e.loop)).toBe(false)
    expect(edge(m.edges, 'spawned:orch:implementer')!.traversals).toBe(2)
  })
})

describe('a rejection still reads as one', () => {
  it('in one turn, along a declared reject edge', async () => {
    run('implementer', 'doc-writer', 'change-reviewer', 'implementer')
    const m = await model([...NEXT, REJECT])
    expect(edge(m.edges, REVIEW_TO_IMPL)).toMatchObject({ traversals: 1, loop: true })
    expect(m.nodes.find((n) => n.id === impl)).toMatchObject({ reentered: true, runs: 2 })
  })

  it('observed mode: going back within a turn', async () => {
    run('implementer', 'change-reviewer', 'implementer')
    const m = await model(null)
    expect(edge(m.edges, 'seq:orch:change-reviewer:implementer')).toMatchObject({ loop: true })
  })
})

describe('backwards is judged against the declared order', () => {
  it('review, impl, docs, review does not paint the declared docs -> review', async () => {
    run('change-reviewer', 'implementer', 'doc-writer', 'change-reviewer')
    const m = await model([...NEXT, REJECT])
    expect(edge(m.edges, 'ship:orch:ship-change:docs:review:next')).toMatchObject({ traversals: 1 })
    expect(edge(m.edges, 'ship:orch:ship-change:docs:review:next')!.loop).toBeUndefined()
    expect(edge(m.edges, 'ship:orch:ship-change:impl:docs:next')!.loop).toBeUndefined()
    // The move back is a move back, but impl had not run in this run, so nothing was re-entered.
    expect(edge(m.edges, REVIEW_TO_IMPL)).toMatchObject({ traversals: 1, loop: true })
    expect(m.nodes.find((n) => n.id === impl)!.reentered).toBeUndefined()
  })

  it('with no next edges, the stage list is the order', async () => {
    run('implementer', 'doc-writer', 'implementer')
    const m = await model([])
    expect(m.edges.find((e) => e.source.endsWith(':docs') && e.target.endsWith(':impl'))).toMatchObject({ undeclared: true, loop: true })
    expect(m.edges.find((e) => e.source.endsWith(':impl') && e.target.endsWith(':docs'))!.loop).toBeUndefined()
  })
})
