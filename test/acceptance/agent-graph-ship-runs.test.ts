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
import type { ShipConfig, ShipEdge } from '../../src/shared/ship-config'
import { buildAgentGraphModel, type GraphEdge } from '../../src/renderer/lib/agentGraphModel'

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

  it('with no next edges, the stage list is the order', async () => {
    run('implementer', 'doc-writer', 'implementer')
    const m = await model([])
    expect(m.edges.find((e) => e.source.endsWith(':docs') && e.target.endsWith(':impl'))).toMatchObject({ undeclared: true, loop: true })
    expect(m.edges.find((e) => e.source.endsWith(':impl') && e.target.endsWith(':docs'))!.loop).toBeUndefined()
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
  it('a clean second run in one turn draws an observed line that claims only that it went back', async () => {
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
