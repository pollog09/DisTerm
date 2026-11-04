/**
 * The agent graph against what Claude Code really sends: payloads recorded live (see the fixture's
 * `_provenance`), driven through the REAL normalizer, subagent lifecycle, mirror, log and model.
 *
 * The other acceptance suite writes its own hook sequences, so it can only test the model against what
 * we believed. This one is what makes those beliefs facts: `/clear` is a new session id, a compaction and
 * a resume are not, an injected hand-back is not a user turn, and SendMessage resumes the same agent id.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentGraphLog } from '../../src/core/agent-graph/event-log'
import { readAgentGraphSnapshot } from '../../src/core/agent-graph/handlers'
import { recordAgentEvent, _resetForTest } from '../../src/core/agent-status-mirror'
import { ClaudeSubagentLifecycle } from '../../src/core/claude-subagent-lifecycle'
import { normalizeClaude } from '../../src/shared/agents/normalize'
import type { ShipConfig, ShipEdge } from '../../src/shared/ship-config'
import { buildAgentGraphModel } from '../../src/renderer/lib/agentGraphModel'

interface Payload {
  hook_event_name: string
  session_id: string
  source?: string
  reason?: string
  agent_id?: string
  agent_type?: string
  prompt?: string
}
const FIXTURE: { scenarios: Record<string, { events: Payload[] }> } = JSON.parse(
  readFileSync(join(__dirname, '../../src/shared/agents/__fixtures__/claude/session-boundary-hook-payloads.json'), 'utf8')
)
const events = (scenario: string): Payload[] => FIXTURE.scenarios[scenario].events

const NODE = 'orch'
let clock = 1_000_000
let lifecycle = new ClaudeSubagentLifecycle()

function play(payloads: readonly Payload[]): void {
  for (const payload of payloads) {
    clock += 10
    vi.setSystemTime(clock)
    const ev = normalizeClaude({ nodeId: NODE, agentId: 'claude', payload: payload as unknown as Record<string, unknown> })
    if (ev) for (const out of lifecycle.apply(ev)) recordAgentEvent(out)
  }
}

const kinds = (): string[] => agentGraphLog.snapshot().events.map((e) => e.kind)

const STAGES = [{ id: 'impl', agent: 'gt-impl' }, { id: 'slow', agent: 'gt-slow' }]
const EDGES: ShipEdge[] = [{ from: 'impl', to: 'slow', kind: 'next' }, { from: 'slow', to: 'impl', kind: 'reject' }]
const SHIP: ShipConfig = {
  machine: { kind: 'local', label: '' },
  agents: [],
  commands: [],
  workflows: [],
  skills: [],
  mcpServers: [],
  mcpRead: false,
  pipelines: [{ id: 'p', name: 'P', stages: STAGES, edges: EDGES }],
  graphSource: 'project',
  projectGraphPath: null,
  globalGraphPath: '/g',
  projectGraphExists: true,
  globalGraphExists: false,
  warnings: []
}

async function model(ship: ShipConfig | null) {
  return buildAgentGraphModel({
    sessions: [{ id: NODE, kind: 'terminal', title: 'Orchestrator', agentId: 'claude', machine: { kind: 'local', label: 'x' } }],
    links: [],
    ropes: [],
    snapshot: await readAgentGraphSnapshot('P', { route: () => ({ kind: 'unsupported' }) }),
    ship,
    now: clock
  })
}

beforeEach(() => {
  _resetForTest()
  lifecycle = new ClaudeSubagentLifecycle()
  vi.useFakeTimers()
  clock = 1_000_000
  vi.setSystemTime(clock)
})

afterEach(() => {
  _resetForTest()
  vi.useRealTimers()
})

describe('/clear, a slash command, /exit', () => {
  const clear = events('clear_slash_exit')

  it('is what the model assumes it is: an end with reason clear, then a start with a NEW session id', () => {
    const end = clear.findIndex((e) => e.hook_event_name === 'SessionEnd' && e.reason === 'clear')
    const start = clear.findIndex((e) => e.hook_event_name === 'SessionStart' && e.source === 'clear')
    expect(end).toBeGreaterThan(0)
    expect(start).toBe(end + 1)
    expect(clear[start].session_id).not.toBe(clear[end].session_id)
    expect(clear[clear.length - 1]).toMatchObject({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })
  })

  it('a custom slash command opens a turn; /clear itself sends no prompt', () => {
    expect(clear.filter((e) => e.hook_event_name === 'UserPromptSubmit').map((e) => e.prompt)).toEqual(['[prompt removed]', '/gt-cmd', '[prompt removed]'])
    play(clear)
    expect(kinds().filter((k) => k === 'turn-start')).toHaveLength(3)
  })

  it('reads as a reset, once for the launch and once for the clear, with the exits as ends', () => {
    play(clear)
    expect(kinds().filter((k) => k === 'session-reset')).toHaveLength(2)
    expect(kinds().filter((k) => k === 'session-end')).toHaveLength(2)
  })
})

describe('/compact after a subagent', () => {
  const compact = events('compact_after_subagent')

  it('keeps the session id and sends no end', () => {
    const at = compact.findIndex((e) => e.hook_event_name === 'SessionStart' && e.source === 'compact')
    expect(at).toBeGreaterThan(0)
    expect(compact[at].session_id).toBe(compact[0].session_id)
    expect(compact.slice(0, at).some((e) => e.hook_event_name === 'SessionEnd')).toBe(false)
  })

  it('starts no new run, and the hand-back it follows is not a user turn', () => {
    play(compact)
    expect(kinds().filter((k) => k === 'session-reset')).toHaveLength(1) // the launch
    expect(kinds().filter((k) => k === 'turn-start')).toHaveLength(2) // the two typed prompts, not the hand-back
  })

  it('one subagent is one run, though its stop fires twice around the hand-back, and side agents draw nothing', async () => {
    const stops = compact.filter((e) => e.hook_event_name === 'SubagentStop')
    expect(stops.filter((e) => e.agent_type === 'gt-impl')).toHaveLength(2)
    expect(stops.filter((e) => !e.agent_type).length).toBeGreaterThan(0)
    play(compact)
    const m = await model(null)
    expect(m.nodes.filter((n) => n.kind === 'subagent').map((n) => [n.title, n.runs, n.activity])).toEqual([['gt-impl', 1, 'done']])
  })
})

describe('--resume', () => {
  it('keeps the session id and is not a reset', () => {
    const before = events('compact_after_subagent')
    const resume = events('resume')
    expect(resume[0]).toMatchObject({ hook_event_name: 'SessionStart', source: 'resume', session_id: before[0].session_id })
    play(resume)
    expect(kinds()).not.toContain('session-reset')
  })
})

describe('SendMessage back to a subagent, which is what a real rejection does', () => {
  const all = events('send_message_then_running_across_compact')

  it('fires a second SubagentStart under the same agent id', () => {
    const starts = all.filter((e) => e.hook_event_name === 'SubagentStart' && e.agent_type === 'gt-impl')
    expect(starts).toHaveLength(2)
    expect(starts[1].agent_id).toBe(starts[0].agent_id)
  })

  it('counts as a second pass of that stage, in one turn', async () => {
    play(all)
    const m = await model(SHIP)
    expect(m.nodes.find((n) => n.id === 'stage:orch:p:impl')).toMatchObject({ runs: 2, activity: 'done' })
    expect(kinds().filter((k) => k === 'turn-start')).toHaveLength(2)
  })

  it('the injected hand-backs and task notification open no turn', () => {
    const injected = all.filter((e) => e.hook_event_name === 'UserPromptSubmit' && e.prompt !== '[prompt removed]')
    expect(injected.length).toBeGreaterThanOrEqual(3)
    for (const e of injected) {
      expect(normalizeClaude({ nodeId: NODE, agentId: 'claude', payload: e as unknown as Record<string, unknown> })!.newTurn).toBeUndefined()
    }
  })
})

describe('a subagent while /compact runs', () => {
  const all = events('send_message_then_running_across_compact')
  const slowStop = all.findIndex((e) => e.hook_event_name === 'SubagentStop' && e.agent_type === 'gt-slow')
  const preCompact = all.findIndex((e) => e.hook_event_name === 'PreCompact')

  it('was still running when the compaction began, and finished under its own stop', async () => {
    expect(preCompact).toBeGreaterThan(0)
    expect(slowStop).toBeGreaterThan(preCompact)
    play(all.slice(0, preCompact + 1))
    expect((await model(SHIP)).nodes.find((n) => n.id === 'stage:orch:p:slow')!.activity).toBe('running')
    play(all.slice(preCompact + 1, slowStop + 1))
    expect((await model(SHIP)).nodes.find((n) => n.id === 'stage:orch:p:slow')!.activity).toBe('done')
  })

  it('the compaction after it keeps the session id and the run', async () => {
    const at = all.findIndex((e) => e.hook_event_name === 'SessionStart' && e.source === 'compact')
    expect(all[at].session_id).toBe(all[0].session_id)
    play(all)
    expect(kinds().filter((k) => k === 'session-reset')).toHaveLength(1)
  })
})
