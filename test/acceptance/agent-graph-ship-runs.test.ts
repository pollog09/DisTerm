/**
 * Telling a second ship run from a rejection, end to end: real Claude hook payloads through the REAL
 * normalizer, subagent lifecycle (first, as `emitAgentStatus` runs it) and agent-status mirror, into the
 * core's graph log, out through the snapshot read, and into the renderer's model, as the view builds it.
 *
 * The counting rule is the whole point of the reject loop: a clean second run drawn as a rejection says
 * a review failed when it did not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentGraphLog } from '../../src/core/agent-graph/event-log'
import { readAgentGraphSnapshot } from '../../src/core/agent-graph/handlers'
import { recordAgentEvent, _resetForTest } from '../../src/core/agent-status-mirror'
import { ClaudeSubagentLifecycle } from '../../src/core/claude-subagent-lifecycle'
import { subagentReplay } from '../../src/core/subagent-replay'
import { WORKING_STALE_MS } from '../../src/shared/agents/stale'
import { normalizeClaude } from '../../src/shared/agents/normalize'
import type { ShipConfig, ShipEdge, ShipPipeline } from '../../src/shared/ship-config'
import { buildAgentGraphModel, type GraphEdge } from '../../src/renderer/lib/agentGraphModel'
import { graphEdgeColor, graphEdgeLabel, graphEdgeTitle } from '../../src/renderer/lib/agentGraphEdgeText'

const NODE = 'orch'
const SESSION = '11111111-1111-4111-8111-000000000001'
let clock = 1_000_000
let agentSeq = 0
let lifecycle = new ClaudeSubagentLifecycle()

function hook(payload: Record<string, unknown>): void {
  clock += 10
  vi.setSystemTime(clock)
  const ev = normalizeClaude({ nodeId: NODE, agentId: 'claude', payload: { session_id: SESSION, ...payload } })
  if (ev) for (const out of lifecycle.apply(ev)) recordAgentEvent(out)
}
const userPrompt = (): void => hook({ hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
const clear = (): void => hook({ hook_event_name: 'SessionStart', source: 'clear' })
const compact = (): void => hook({ hook_event_name: 'SessionStart', source: 'compact' })
const resume = (): void => hook({ hook_event_name: 'SessionStart', source: 'resume' })
const start = (agent_id: string, agent_type: string): void => hook({ hook_event_name: 'SubagentStart', agent_id, agent_type })
const stop = (agent_id: string, agent_type: string): void => hook({ hook_event_name: 'SubagentStop', agent_id, agent_type })
/** One subagent run in a second session, through the same path. */
function hook2(agent_type: string): void {
  const agent_id = newId()
  for (const hook_event_name of ['SubagentStart', 'SubagentStop']) {
    clock += 10
    vi.setSystemTime(clock)
    const ev = normalizeClaude({ nodeId: 'second', agentId: 'claude', payload: { session_id: '11111111-1111-4111-8111-000000000002', hook_event_name, agent_id, agent_type } })
    if (ev) for (const out of lifecycle.apply(ev)) recordAgentEvent(out)
  }
}
const newId = (): string => `a${(++agentSeq).toString(16).padStart(16, '0')}`
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

const STAGES = [{ id: 'impl', agent: 'implementer' }, { id: 'docs', agent: 'doc-writer' }, { id: 'review', agent: 'change-reviewer' }]

function ship(edges: ShipEdge[], stages = STAGES): ShipConfig {
  return {
    machine: { kind: 'local', label: '' },
    agents: [],
    commands: [],
    workflows: [],
    skills: [],
    pipelines: [{
      id: 'ship-change',
      name: 'Ship change',
      stages,
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

async function model(edges: ShipEdge[] | null, stages = STAGES, now?: number) {
  const snapshot = await readAgentGraphSnapshot('P', { route: () => ({ kind: 'unsupported' }) })
  return buildAgentGraphModel({
    sessions: [{ id: NODE, kind: 'terminal', title: 'Orchestrator', agentId: 'claude', machine: { kind: 'local', label: 'x' } }],
    links: [],
    ropes: [],
    snapshot,
    ship: edges ? ship(edges, stages) : null,
    now: now ?? clock
  })
}
const edge = (edges: GraphEdge[], id: string) => edges.find((e) => e.id === id)
const REVIEW_TO_IMPL = 'ship:orch:ship-change:review:impl:reject'
const impl = 'stage:orch:ship-change:impl'

beforeEach(() => {
  _resetForTest()
  lifecycle = new ClaudeSubagentLifecycle()
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

  it('with no next edges there is no order: going down the list and back up calls nothing a loop', async () => {
    for (const edges of [[], [REJECT]]) {
      _resetForTest()
      lifecycle = new ClaudeSubagentLifecycle()
      run('doc-writer', 'implementer')
      const m = await model(edges)
      expect(m.edges.find((e) => e.source.endsWith(':docs') && e.target.endsWith(':impl'))).toMatchObject({ undeclared: true })
      expect(m.edges.some((e) => e.loop)).toBe(false)
      expect(m.nodes.some((n) => n.reentered)).toBe(false)
    }
  })
})

describe('a compaction or a resume is not a reset', () => {
  it('a real rejection right after an auto-compact is still a rejection', async () => {
    run('implementer', 'doc-writer', 'change-reviewer')
    compact()
    run('implementer')
    const m = await model([...NEXT, REJECT])
    expect(edge(m.edges, REVIEW_TO_IMPL)).toMatchObject({ traversals: 1, loop: true })
    expect(m.nodes.find((n) => n.id === impl)).toMatchObject({ reentered: true })
  })

  it('a clean run with a compact in the middle keeps its chain and gains no false entry', async () => {
    run('implementer', 'doc-writer')
    compact()
    run('change-reviewer')
    const m = await model([...NEXT, REJECT])
    expect(edge(m.edges, 'ship:orch:ship-change:docs:review:next')!.traversals).toBe(1)
    expect(edge(m.edges, 'spawned:orch:ship-change:review')).toBeUndefined()
  })

  it('a subagent running across a compaction is still running', async () => {
    start(newId(), 'implementer')
    compact()
    const m = await model([...NEXT, REJECT])
    expect(m.nodes.find((n) => n.id === impl)!.activity).toBe('running')
  })

  it('so is a chain across a resume', async () => {
    run('implementer', 'doc-writer')
    resume()
    run('change-reviewer')
    const m = await model([...NEXT, REJECT])
    expect(edge(m.edges, 'ship:orch:ship-change:docs:review:next')!.traversals).toBe(1)
  })

  it('a CLI that exits takes its running subagents with it, without starting a new run', async () => {
    run('implementer')
    start(newId(), 'doc-writer')
    hook({ hook_event_name: 'SessionEnd', reason: 'other' })
    const m = await model([...NEXT, REJECT])
    expect(m.nodes.find((n) => n.id === 'stage:orch:ship-change:docs')!.activity).toBe('done')
  })
})

describe('a pass under the same agent id', () => {
  it('a rejection resuming the implementer counts as a second pass and keeps the forward edge', async () => {
    const a1 = newId()
    start(a1, 'implementer')
    stop(a1, 'implementer')
    run('doc-writer', 'change-reviewer')
    start(a1, 'implementer')
    stop(a1, 'implementer')
    const m = await model([...NEXT, REJECT])
    expect(m.nodes.find((n) => n.id === impl)).toMatchObject({ runs: 2, reentered: true })
    expect(edge(m.edges, REVIEW_TO_IMPL)).toMatchObject({ traversals: 1, loop: true })
    expect(edge(m.edges, 'ship:orch:ship-change:impl:docs:next')!.traversals).toBe(1)
    expect(edge(m.edges, 'spawned:orch:ship-change:docs')).toBeUndefined()
  })
})

describe("a late end from the tool path", () => {
  it('does not move the end of the run it names, so the rejection stays on its declared edge', async () => {
    const agent = (tool_use_id: string, agent_type: string, id: string): void => {
      hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id, tool_input: { subagent_type: agent_type, description: 'x', run_in_background: true, prompt: 'p' } })
      start(id, agent_type)
    }
    agent('t1', 'implementer', 'a0000000000000001')
    stop('a0000000000000001', 'implementer')
    agent('t2', 'doc-writer', 'a0000000000000002')
    stop('a0000000000000002', 'doc-writer')
    agent('t3', 'change-reviewer', 'a0000000000000003')
    stop('a0000000000000003', 'change-reviewer')
    agent('t4', 'implementer', 'a0000000000000004')
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 't3', tool_input: { subagent_type: 'change-reviewer' }, tool_response: { agentId: 'a0000000000000003', status: 'completed' } })
    stop('a0000000000000004', 'implementer')
    const m = await model([...NEXT, REJECT])
    expect(edge(m.edges, REVIEW_TO_IMPL)).toMatchObject({ traversals: 1, loop: true })
    expect(m.edges.some((e) => e.undeclared)).toBe(false)
  })
})

describe('what the file does not say is not a loop', () => {
  it('a way back written without kind:reject does not invent a loop on a clean first run', async () => {
    run('implementer', 'doc-writer', 'change-reviewer')
    const m = await model([...NEXT, { from: 'review', to: 'impl', kind: 'next' }])
    expect(m.edges.some((e) => e.loop)).toBe(false)
    expect(m.nodes.some((n) => n.reentered)).toBe(false)
  })

  it('and when that way back is really taken, it is one', async () => {
    run('implementer', 'doc-writer', 'change-reviewer', 'implementer')
    const m = await model([...NEXT, { from: 'review', to: 'impl', kind: 'next' }])
    expect(edge(m.edges, 'ship:orch:ship-change:review:impl:next')).toMatchObject({ loop: true })
  })

  it('a stage no edge touches is never behind anything', async () => {
    run('implementer', 'doc-writer', 'qa')
    const m = await model(NEXT, [...STAGES, { id: 'qa', agent: 'qa' }])
    const toQa = m.edges.find((e) => e.target.endsWith(':qa'))!
    expect(toQa).toMatchObject({ undeclared: true })
    expect(toQa.loop).toBeUndefined()
  })

  it('nor is one listed first, where a list order would put it behind everything', async () => {
    run('implementer', 'qa')
    const m = await model(NEXT, [{ id: 'qa', agent: 'qa' }, ...STAGES])
    expect(m.edges.find((e) => e.target.endsWith(':qa'))!.loop).toBeUndefined()
  })

  it('two branches of a fork are not behind each other, in either order', async () => {
    const fork: ShipEdge[] = [...NEXT, { from: 'impl', to: 'qa', kind: 'next' }]
    const stages = [...STAGES, { id: 'qa', agent: 'qa' }]
    run('implementer', 'doc-writer', 'qa')
    expect((await model(fork, stages)).edges.some((e) => e.loop)).toBe(false)
    clear()
    run('implementer', 'qa', 'doc-writer')
    expect((await model(fork, stages)).edges.some((e) => e.loop)).toBe(false)
  })
})

describe('with no file, going back cannot be told apart', () => {
  it('a clean second run in one turn draws an observed line that claims only that it repeated', async () => {
    run('implementer', 'doc-writer', 'change-reviewer', 'implementer', 'doc-writer', 'change-reviewer')
    const m = await model(null)
    expect(edge(m.edges, 'seq:orch:change-reviewer:implementer')).toMatchObject({ kind: 'observed', loop: true })
    expect(edge(m.edges, 'seq:orch:change-reviewer:implementer')!.undeclared).toBeUndefined()
  })
})

describe('a long healthy subagent', () => {
  it('streaming output keeps it running past the staleness line', async () => {
    const a = newId()
    start(a, 'implementer')
    const open = clock
    for (let t = open + 60_000; t < open + WORKING_STALE_MS + 60_000; t += 60_000) {
      clock = t
      vi.setSystemTime(clock)
      subagentReplay.touch(a)
    }
    const m = await model([...NEXT, REJECT])
    expect(m.nodes.find((n) => n.id === impl)!.activity).toBe('running')
    expect(m.nextStaleAt).toBeGreaterThan(clock)
  })

  it('one that goes silent is still called stale', async () => {
    start(newId(), 'implementer')
    const m = await model([...NEXT, REJECT], STAGES, clock + WORKING_STALE_MS + 1)
    expect(m.nodes.find((n) => n.id === impl)!.activity).toBe('stale')
  })
})

describe('an agent used by more than one stage', () => {
  const STEPS = [{ id: 'impl', agent: 'implementer' }, { id: 'r1', agent: 'change-reviewer' }, { id: 'fix', agent: 'implementer' }, { id: 'r2', agent: 'change-reviewer' }]
  const CHAIN: ShipEdge[] = [{ from: 'impl', to: 'r1', kind: 'next' }, { from: 'r1', to: 'fix', kind: 'next' }, { from: 'fix', to: 'r2', kind: 'next' }]
  const stage = (m: Awaited<ReturnType<typeof model>>, id: string) => m.nodes.find((n) => n.id === `stage:orch:ship-change:${id}`)!

  it('a clean run walks the stages in order, with no loop', async () => {
    run('implementer', 'change-reviewer', 'implementer', 'change-reviewer')
    const m = await model(CHAIN, STEPS)
    for (const id of ['impl', 'r1', 'fix', 'r2']) expect(stage(m, id).runs, id).toBe(1)
    expect(m.edges.some((e) => e.loop || e.undeclared)).toBe(false)
    expect(m.nodes.some((n) => n.reentered)).toBe(false)
    expect(edge(m.edges, 'ship:orch:ship-change:fix:r2:next')!.traversals).toBe(1)
  })

  it('a retry of a stage stays on that stage', async () => {
    run('implementer', 'implementer', 'change-reviewer')
    const m = await model(CHAIN, STEPS)
    expect(stage(m, 'impl').runs).toBe(2)
    expect(stage(m, 'r1').runs).toBe(1)
  })

  it('a declared reject back to a repeated stage still reads as a rejection', async () => {
    run('implementer', 'change-reviewer', 'implementer', 'change-reviewer', 'implementer')
    const m = await model([...CHAIN, { from: 'r2', to: 'fix', kind: 'reject' }], STEPS)
    expect(edge(m.edges, 'ship:orch:ship-change:r2:fix:reject')).toMatchObject({ traversals: 1, loop: true })
    expect(stage(m, 'fix')).toMatchObject({ runs: 2, reentered: true })
  })

  it('with no route to any of them it says so, and draws no move', async () => {
    run('change-reviewer', 'implementer')
    const m = await model([], STEPS)
    expect(m.notices.join()).toMatch(/could not be placed/)
    expect(m.edges.some((e) => e.kind !== 'spawned' && (e.loop || e.undeclared || e.traversals))).toBe(false)
  })
})

describe('next and reject to the same agent', () => {
  const STEPS = [{ id: 'impl', agent: 'implementer' }, { id: 'r1', agent: 'change-reviewer' }, { id: 'fix', agent: 'implementer' }, { id: 'r2', agent: 'change-reviewer' }]
  const CHAIN: ShipEdge[] = [
    { from: 'impl', to: 'r1', kind: 'next' }, { from: 'r1', to: 'fix', kind: 'next' }, { from: 'fix', to: 'r2', kind: 'next' },
    { from: 'r1', to: 'impl', kind: 'reject' }
  ]
  const stage = (m: Awaited<ReturnType<typeof model>>, id: string) => m.nodes.find((n) => n.id === `stage:orch:ship-change:${id}`)!
  const toFix = 'ship:orch:ship-change:r1:fix:next'
  const toImpl = 'ship:orch:ship-change:r1:impl:reject'

  it('asserts neither forward progress nor a rejection: both edges are maybe, and a notice names them', async () => {
    run('implementer', 'change-reviewer', 'implementer')
    const m = await model(CHAIN, STEPS)
    for (const id of [toFix, toImpl]) {
      expect(edge(m.edges, id)).toMatchObject({ maybe: 1 })
      expect(edge(m.edges, id)!.traversals).toBeUndefined()
      expect(edge(m.edges, id)!.loop).toBeUndefined()
      expect(graphEdgeLabel(edge(m.edges, id)!)).toBe('maybe ×1')
      expect(graphEdgeColor(edge(m.edges, id)!)).toBe('var(--state-warning)')
    }
    expect(stage(m, 'impl')).toMatchObject({ runs: 1, maybeRuns: 1 })
    expect(stage(m, 'fix')).toMatchObject({ runs: 0, maybeRuns: 1 })
    expect(stage(m, 'impl').reentered).toBeUndefined()
    expect(m.notices.join()).toMatch(/after r1, implementer could be the next stage fix or a rejection back to impl/)
  })

  it('what follows stays uncertain: a reviewer after it may be either stage, with no false entry', async () => {
    run('implementer', 'change-reviewer', 'implementer', 'change-reviewer')
    const m = await model(CHAIN, STEPS)
    expect(stage(m, 'r1')).toMatchObject({ runs: 1, maybeRuns: 1 })
    expect(stage(m, 'r2')).toMatchObject({ runs: 0, maybeRuns: 1 })
    expect(edge(m.edges, 'ship:orch:ship-change:fix:r2:next')).toMatchObject({ maybe: 1 })
    expect(edge(m.edges, 'ship:orch:ship-change:impl:r1:next')).toMatchObject({ traversals: 1, maybe: 1 })
    expect(graphEdgeLabel(edge(m.edges, 'ship:orch:ship-change:impl:r1:next')!)).toBe('×1 + maybe ×1')
    expect(edge(m.edges, 'spawned:orch:ship-change:r2')).toBeUndefined()
    expect(m.edges.some((e) => e.loop)).toBe(false)
  })

  it('it settles at a stage only one route reaches', async () => {
    const stages = [...STEPS, { id: 'done', agent: 'releaser' }]
    run('implementer', 'change-reviewer', 'implementer', 'releaser')
    const m = await model([...CHAIN, { from: 'fix', to: 'done', kind: 'next' }], stages)
    expect(stage(m, 'done')).toMatchObject({ runs: 1 })
    expect(stage(m, 'done').maybeRuns).toBeUndefined()
    expect(edge(m.edges, 'ship:orch:ship-change:fix:done:next')).toMatchObject({ maybe: 1 })
    expect(edge(m.edges, 'spawned:orch:ship-change:done')).toBeUndefined() // it did not start the run
  })

  it('a new prompt ends the uncertainty', async () => {
    run('implementer', 'change-reviewer', 'implementer')
    userPrompt()
    run('implementer')
    const m = await model(CHAIN, STEPS)
    expect(stage(m, 'impl')).toMatchObject({ runs: 2, maybeRuns: 1 })
  })

  it("the real /ship-change shape is untouched: reject edges, no repeated agents, nothing maybe", async () => {
    const shape: ShipEdge[] = [...NEXT, REJECT, { from: 'review', to: 'docs', kind: 'reject' }]
    run('implementer', 'doc-writer', 'change-reviewer', 'implementer')
    const m = await model(shape)
    expect(m.edges.some((e) => e.maybe)).toBe(false)
    expect(m.nodes.some((n) => n.maybeRuns)).toBe(false)
    expect(m.notices.join()).not.toMatch(/could/)
    expect(edge(m.edges, REVIEW_TO_IMPL)).toMatchObject({ traversals: 1, loop: true })
  })

  it('a next chain with no reject between them is untouched too', async () => {
    run('implementer', 'change-reviewer', 'implementer', 'change-reviewer')
    const m = await model(CHAIN.filter((e) => e.kind === 'next'), STEPS)
    expect(m.edges.some((e) => e.maybe)).toBe(false)
    for (const id of ['impl', 'r1', 'fix', 'r2']) expect(stage(m, id).runs, id).toBe(1)
  })
})

describe('an unplaced run', () => {
  const LISTED = [{ id: 'x1', agent: 'X' }, { id: 'y', agent: 'Y' }, { id: 'x2', agent: 'X' }, { id: 'z', agent: 'Z' }]
  const CHAIN: ShipEdge[] = [{ from: 'x1', to: 'y', kind: 'next' }, { from: 'y', to: 'x2', kind: 'next' }]

  it('goes on the earliest by declared order, however the stages are listed, and invents no loop', async () => {
    const shuffled = [LISTED[2], LISTED[1], LISTED[0], LISTED[3]]
    for (const stages of [LISTED, shuffled]) {
      _resetForTest()
      lifecycle = new ClaudeSubagentLifecycle()
      run('Z', 'X', 'Y')
      const m = await model(CHAIN, stages)
      expect(edge(m.edges, 'ship:orch:ship-change:x1:y:next')).toMatchObject({ traversals: 1 })
      expect(m.edges.some((e) => e.loop || e.undeclared)).toBe(false)
      expect(m.nodes.find((n) => n.id === 'stage:orch:ship-change:x1')).toMatchObject({ runs: 1 })
    }
  })

  it('a tie is by id, not list order', async () => {
    const stages = [{ id: 'b', agent: 'X' }, { id: 'a', agent: 'X' }]
    run('X')
    const m = await model([], stages)
    expect(m.nodes.find((n) => n.id === 'stage:orch:ship-change:a')).toMatchObject({ runs: 1 })
    expect(m.notices.join()).toMatch(/could not be placed/)
  })

  it('a move out of a guess never reads as a rejection or a loop, even along a declared edge', async () => {
    const stages = [{ id: 'w', agent: 'W' }, { id: 'x1', agent: 'X' }, { id: 'x2', agent: 'X' }, { id: 'z', agent: 'Z' }]
    const declared = async (kind: 'next' | 'reject') => {
      _resetForTest()
      lifecycle = new ClaudeSubagentLifecycle()
      run('Z', 'X', 'W')
      return model([{ from: 'w', to: 'x1', kind: 'next' }, { from: 'x1', to: 'x2', kind: 'next' }, { from: 'x1', to: 'w', kind }], stages)
    }
    const viaReject = await declared('reject')
    expect(edge(viaReject.edges, 'ship:orch:ship-change:x1:w:reject')!.traversals).toBeUndefined()
    const viaCycle = await declared('next') // closes a cycle, so the order says w comes first
    expect(viaCycle.edges.some((e) => e.loop)).toBe(false)
    expect(viaCycle.nodes.some((n) => n.reentered)).toBe(false)
  })

  it('nothing is judged backwards from a guess', async () => {
    const stages = [{ id: 'w', agent: 'W' }, { id: 'x1', agent: 'X' }, { id: 'x2', agent: 'X' }, { id: 'z', agent: 'Z' }]
    const edges: ShipEdge[] = [{ from: 'w', to: 'x1', kind: 'next' }, { from: 'x1', to: 'x2', kind: 'next' }]
    run('Z', 'X', 'W')
    const m = await model(edges, stages)
    expect(m.edges.some((e) => e.loop)).toBe(false)
    expect(m.nodes.some((n) => n.reentered)).toBe(false)
  })
})

describe('a guess stays a guess', () => {
  const STOPS = (m: Awaited<ReturnType<typeof model>>): GraphEdge[] =>
    m.edges.filter((e) => e.loop || (e.kind === 'ship-reject' && e.traversals))

  it('through a retry: X, X, W draws no rejection, as X, W does not', async () => {
    const stages = [{ id: 'a', agent: 'X' }, { id: 'b', agent: 'X' }, { id: 'w', agent: 'W' }]
    const edges: ShipEdge[] = [{ from: 'w', to: 'a', kind: 'next' }, { from: 'a', to: 'w', kind: 'reject' }]
    for (const walk of [['X', 'W'], ['X', 'X', 'W']]) {
      _resetForTest()
      lifecycle = new ClaudeSubagentLifecycle()
      run(...walk)
      const m = await model(edges, stages)
      expect(STOPS(m), walk.join()).toEqual([])
      expect(m.nodes.some((n) => n.reentered)).toBe(false)
    }
  })

  it('through a chain of them: a clean s2, s3, s4 draws no rejection', async () => {
    const stages = [{ id: 's0', agent: 'C' }, { id: 's1', agent: 'A' }, { id: 's2', agent: 'A' }, { id: 's3', agent: 'A' }, { id: 's4', agent: 'C' }]
    const edges: ShipEdge[] = [
      { from: 's0', to: 's1', kind: 'next' }, { from: 's1', to: 's0', kind: 'reject' },
      { from: 's2', to: 's1', kind: 'reject' }, { from: 's2', to: 's3', kind: 'next' }, { from: 's3', to: 's4', kind: 'next' }
    ]
    run('A', 'A', 'C')
    const m = await model(edges, stages)
    expect(STOPS(m)).toEqual([])
    expect(m.nodes.some((n) => n.reentered)).toBe(false)
  })

  it('out of a fork, where picking the wrong sibling would find its reject', async () => {
    const stages = [{ id: 'i', agent: 'I' }, { id: 'a', agent: 'R' }, { id: 'b', agent: 'R' }, { id: 'c', agent: 'I2' }]
    const edges: ShipEdge[] = [
      { from: 'i', to: 'a', kind: 'next' }, { from: 'i', to: 'b', kind: 'next' }, { from: 'b', to: 'c', kind: 'next' },
      { from: 'a', to: 'i', kind: 'reject' }
    ]
    run('I', 'R', 'I') // through b would be clean, and only the file's order says a
    const m = await model(edges, stages)
    expect(STOPS(m)).toEqual([])
    // The declared move into the fork is still drawn.
    expect(edge(m.edges, 'ship:orch:ship-change:i:a:next')).toMatchObject({ traversals: 1 })
  })

  it('an agent only one stage uses settles it, and a real rejection after that still reads as one', async () => {
    const stages = [{ id: 'a', agent: 'X' }, { id: 'b', agent: 'X' }, { id: 'w', agent: 'W' }, { id: 'y', agent: 'Y' }]
    const edges: ShipEdge[] = [{ from: 'w', to: 'y', kind: 'next' }, { from: 'y', to: 'w', kind: 'reject' }]
    run('X', 'W', 'Y', 'W')
    const m = await model(edges, stages)
    expect(edge(m.edges, 'ship:orch:ship-change:y:w:reject')).toMatchObject({ traversals: 1, loop: true })
  })

  it('the real /ship-change shape: a clean run has no loop, and a real rejection still does', async () => {
    const shape: ShipEdge[] = [...NEXT, REJECT, { from: 'review', to: 'docs', kind: 'reject' }]
    run('implementer', 'doc-writer', 'change-reviewer')
    expect(STOPS(await model(shape))).toEqual([])
    run('implementer')
    const rejected = await model(shape)
    expect(edge(rejected.edges, REVIEW_TO_IMPL)).toMatchObject({ traversals: 1, loop: true })
    expect(rejected.nodes.find((n) => n.id === impl)).toMatchObject({ reentered: true })
  })

  it('no clean walk of any pipeline, however its stages repeat agents, draws a loop or a rejection', async () => {
    // Fixed seed, so a failure is a failure every time, and the message says which pipeline.
    let state = 0x5eed1234
    const rand = (n: number): number => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) % n
    }
    let repeated = 0
    let guessed = 0
    for (let c = 0; c < 400; c++) {
      const size = 2 + rand(5)
      const ids = Array.from({ length: size }, (_, i) => `s${i}`)
      const stagesInOrder = ids.map((id) => ({ id, agent: 'ABC'[rand(3)] }))
      const edges: ShipEdge[] = []
      for (let i = 0; i < size; i++) {
        for (let j = i + 1; j < size; j++) if (rand(3) === 0) edges.push({ from: ids[i], to: ids[j], kind: 'next' })
      }
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
          if (i !== j && rand(5) === 0 && !edges.some((e) => e.from === ids[i] && e.to === ids[j])) edges.push({ from: ids[i], to: ids[j], kind: 'reject' })
        }
      }
      // A clean walk: from a stage nothing declares before it, along next edges only.
      const nextFrom = (id: string): string[] => edges.filter((e) => e.kind === 'next' && e.from === id).map((e) => e.to)
      const firsts = ids.filter((id) => !edges.some((e) => e.kind === 'next' && e.to === id))
      const walk = [firsts[rand(firsts.length)]]
      for (;;) {
        const onward = nextFrom(walk[walk.length - 1])
        if (onward.length === 0) break
        walk.push(onward[rand(onward.length)])
      }
      const listed = [...stagesInOrder]
      for (let i = listed.length - 1; i > 0; i--) {
        const j = rand(i + 1)
        ;[listed[i], listed[j]] = [listed[j], listed[i]]
      }
      const types = walk.map((id) => stagesInOrder.find((st) => st.id === id)!.agent)
      _resetForTest()
      lifecycle = new ClaudeSubagentLifecycle()
      run(...types)
      const m = await model(edges, listed)
      const label = JSON.stringify({ c, stages: listed, edges, walk })
      expect(STOPS(m).map((e) => e.id), label).toEqual([])
      expect(m.nodes.filter((n) => n.reentered).map((n) => n.id), label).toEqual([])
      if (new Set(types).size < types.length) repeated++
      if (m.notices.join().includes('could not be placed')) guessed++
    }
    // Not vacuous: the walks did repeat agents, and did reach the guessing path.
    expect(repeated).toBeGreaterThan(50)
    expect(guessed).toBeGreaterThan(10)
  })
})

describe('stages of one agent that fan out', () => {
  const STAGES_FAN = [{ id: 'impl', agent: 'implementer' }, { id: 'a', agent: 'reviewer' }, { id: 'b', agent: 'reviewer' }]
  const FAN: ShipEdge[] = [{ from: 'impl', to: 'a', kind: 'next' }, { from: 'impl', to: 'b', kind: 'next' }]
  const runsOf = (m: Awaited<ReturnType<typeof model>>, id: string) => m.nodes.find((n) => n.id === `stage:orch:ship-change:${id}`)!.runs

  it('one after the other, the second goes on the sibling that has not run', async () => {
    run('implementer', 'reviewer', 'reviewer')
    const m = await model(FAN, STAGES_FAN)
    expect([runsOf(m, 'a'), runsOf(m, 'b')]).toEqual([1, 1])
  })

  it('in parallel, too', async () => {
    run('implementer')
    const [x, y] = [newId(), newId()]
    start(x, 'reviewer')
    start(y, 'reviewer')
    stop(x, 'reviewer')
    stop(y, 'reviewer')
    const m = await model(FAN, STAGES_FAN)
    expect([runsOf(m, 'a'), runsOf(m, 'b')]).toEqual([1, 1])
  })

  it('a third run is then a retry, not a third stage', async () => {
    run('implementer', 'reviewer', 'reviewer', 'reviewer')
    const m = await model(FAN, STAGES_FAN)
    expect(runsOf(m, 'a')! + runsOf(m, 'b')!).toBe(3)
    expect(m.edges.some((e) => e.loop)).toBe(false)
  })
})

describe('notices', () => {
  it('two sessions hitting the same one show it once', async () => {
    const stages = [{ id: 'a', agent: 'X' }, { id: 'b', agent: 'X' }]
    run('X')
    hook2('X')
    const snapshot = await readAgentGraphSnapshot('P', { route: () => ({ kind: 'unsupported' }) })
    const session = (id: string) => ({ id, kind: 'terminal' as const, title: id, agentId: 'claude', machine: { kind: 'local' as const, label: 'x' } })
    const m = buildAgentGraphModel({ sessions: [session(NODE), session('second')], links: [], ropes: [], snapshot, ship: ship([], stages), now: clock })
    expect(m.notices.filter((n) => n.includes('could not be placed'))).toHaveLength(1)
    expect(new Set(m.nodes.map((n) => n.id)).size).toBe(m.nodes.length)
  })
})

describe('which pipeline a run was', () => {
  const pipelineConfig = (pipelines: ShipPipeline[]): ShipConfig => ({ ...ship([]), pipelines })
  const SHIP: ShipPipeline = { id: 'ship', name: 'Ship', stages: STAGES, edges: [...NEXT, REJECT] }
  const HOTFIX: ShipPipeline = { id: 'hotfix', name: 'Hotfix', stages: [{ id: 'rv', agent: 'change-reviewer' }, { id: 'im', agent: 'implementer' }], edges: [{ from: 'rv', to: 'im', kind: 'next' }] }
  const TRIAGE: ShipPipeline = { id: 'triage', name: 'Triage', stages: [{ id: 't', agent: 'triager' }, { id: 'f', agent: 'fixer' }], edges: [{ from: 't', to: 'f', kind: 'next' }] }
  async function modelOf(pipelines: ShipPipeline[]) {
    const snapshot = await readAgentGraphSnapshot('P', { route: () => ({ kind: 'unsupported' }) })
    return buildAgentGraphModel({
      sessions: [{ id: NODE, kind: 'terminal', title: 'Orchestrator', agentId: 'claude', machine: { kind: 'local', label: 'x' } }],
      links: [], ropes: [], snapshot, ship: pipelineConfig(pipelines), now: clock
    })
  }

  it('a tie goes to the order they ran in, not the order the file lists', async () => {
    run('change-reviewer', 'implementer')
    const m = await modelOf([SHIP, HOTFIX])
    expect(edge(m.edges, 'ship:orch:hotfix:rv:im:next')!.traversals).toBe(1)
    expect(m.edges.some((e) => e.loop)).toBe(false)
    expect(m.nodes.some((n) => n.id.startsWith('stage:orch:ship:'))).toBe(false)
  })

  it('a session that ran two pipelines lights both, and shows neither as unrun', async () => {
    run('implementer', 'doc-writer', 'change-reviewer')
    userPrompt()
    run('triager', 'fixer')
    const m = await modelOf([SHIP, TRIAGE])
    expect(m.nodes.find((n) => n.id === 'stage:orch:triage:t')).toMatchObject({ runs: 1 })
    expect(m.nodes.find((n) => n.id === 'stage:orch:ship:impl')).toMatchObject({ runs: 1 })
    expect(m.nodes.some((n) => n.id.startsWith('stage:template:'))).toBe(false)
    expect(m.nodes.some((n) => n.kind === 'subagent')).toBe(false)
  })

  it('two pipelines in one turn are each taken in turn', async () => {
    run('implementer', 'doc-writer', 'triager', 'fixer')
    const m = await modelOf([SHIP, TRIAGE])
    expect(m.nodes.find((n) => n.id === 'stage:orch:ship:docs')).toMatchObject({ runs: 1 })
    expect(m.nodes.find((n) => n.id === 'stage:orch:triage:f')).toMatchObject({ runs: 1 })
  })

  it('a true tie is drawn as observed, says so, and calls nothing a rejection', async () => {
    const twin: ShipPipeline = { ...SHIP, id: 'twin', name: 'Twin' }
    run('implementer', 'doc-writer', 'change-reviewer', 'implementer')
    const m = await modelOf([SHIP, twin])
    expect(m.notices.join()).toMatch(/fit Ship or Twin equally/)
    expect(m.nodes.some((n) => n.kind === 'stage')).toBe(false)
    expect(m.edges.some((e) => e.kind === 'ship-reject')).toBe(false)
    expect(m.nodes.some((n) => n.reentered)).toBe(false)
    // The way back is on the line, in words and a colour that do not say rejection or "no file".
    const back = edge(m.edges, 'seq:orch:change-reviewer:implementer')!
    expect(graphEdgeLabel(back)).toBe('×1')
    expect(graphEdgeColor(back)).toBe('var(--state-warning)')
    expect(graphEdgeTitle(back)).not.toMatch(/no routing file/i)
  })

  it('a pipeline nothing ran stays a template', async () => {
    run('implementer')
    const m = await modelOf([SHIP, TRIAGE])
    expect(m.nodes.find((n) => n.id === 'stage:template:triage:t')).toMatchObject({ runs: 0 })
  })
})
