/**
 * Skills and MCP servers in the agent graph, against what Claude Code 2.1.318 really sent: the recorded
 * payloads (see the fixture's `_provenance`) go through the real extractor, the real log, the real
 * normalizer and subagent lifecycle, and the real model, in the order the hook route does them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentGraphLog } from '../../src/core/agent-graph/event-log'
import { readAgentGraphSnapshot } from '../../src/core/agent-graph/handlers'
import { recordAgentEvent, _resetForTest } from '../../src/core/agent-status-mirror'
import { ClaudeSubagentLifecycle } from '../../src/core/claude-subagent-lifecycle'
import { normalizeClaude } from '../../src/shared/agents/normalize'
import { claudeToolAccess } from '../../src/shared/agents/tool-access'
import type { ShipConfig } from '../../src/shared/ship-config'
import { buildAgentGraphModel } from '../../src/renderer/lib/agentGraphModel'
import { graphEdgeLabel, graphEdgeTitle } from '../../src/renderer/lib/agentGraphEdgeText'

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, '../../src/shared/agents/__fixtures__/claude/tool-access-hook-payloads.json'), 'utf8')
) as { scenarios: { skill_mcp_subagent_typed: { events: Array<Record<string, unknown>> } } }
const events = FIXTURE.scenarios.skill_mcp_subagent_typed.events

const NODE = 'orch'
let clock = 1_000_000
const lifecycle = new ClaudeSubagentLifecycle()

function play(payloads: readonly Record<string, unknown>[]): void {
  for (const payload of payloads) {
    clock += 10
    vi.setSystemTime(clock)
    const access = claudeToolAccess(payload)
    if (access) agentGraphLog.recordAccess(NODE, access, clock)
    const ev = normalizeClaude({ nodeId: NODE, agentId: 'claude', payload })
    if (ev) for (const out of lifecycle.apply(ev)) recordAgentEvent(out)
  }
}

const SHIP: ShipConfig = {
  machine: { kind: 'local', label: '' },
  agents: [],
  commands: [],
  workflows: [],
  skills: ['demo-skill'],
  mcpServers: [{ name: 'demo', scope: 'project', transport: 'stdio' }],
  mcpRead: true,
  pipelines: [],
  graphSource: null,
  projectGraphPath: null,
  globalGraphPath: '/g',
  projectGraphExists: false,
  globalGraphExists: false,
  warnings: []
}

async function model(ship: ShipConfig | null) {
  return buildAgentGraphModel({
    sessions: [{ id: NODE, kind: 'terminal', title: 'Orchestrator', agentId: 'claude', machine: { kind: 'local', label: 'x' }, state: 'working' }],
    links: [],
    ropes: [],
    snapshot: await readAgentGraphSnapshot('P', { route: () => ({ kind: 'unsupported' }) }),
    ship,
    now: clock
  })
}

beforeEach(() => {
  _resetForTest()
  vi.useFakeTimers()
  clock = 1_000_000
  vi.setSystemTime(clock)
})
afterEach(() => {
  _resetForTest()
  vi.useRealTimers()
})

describe('a session that calls a skill and an MCP tool, and a subagent that does too', () => {
  it('draws one box for each, shared, with the session and the subagent each on its own line', async () => {
    play(events)
    const m = await model(null)
    const lines = m.edges.filter((e) => e.kind === 'uses-skill' || e.kind === 'uses-mcp').map((e) => [e.id, graphEdgeLabel(e)])
    expect(lines).toEqual([
      ['uses:session:orch:skill:demo-skill', '×1'],
      ['uses:session:orch:mcp:demo', '×1'],
      ['uses:sub:orch:general-purpose:mcp:demo', '×1'],
      ['uses:sub:orch:general-purpose:skill:demo-skill', '×1']
    ])
    expect(m.nodes.filter((n) => n.kind === 'skill' || n.kind === 'mcp').map((n) => [n.id, n.runs, n.subtitle])).toEqual([
      ['skill:demo-skill', 2, undefined],
      ['mcp:demo', 2, 'echo_it']
    ])
    expect(m.nodes.find((n) => n.id === 'sub:orch:general-purpose')).toMatchObject({ kind: 'subagent', runs: 1 })
  })

  it('the typed /demo-skill joins the skill once the machine says it is one', async () => {
    play(events)
    expect((await model(null)).nodes.find((n) => n.id === 'skill:demo-skill')!.runs).toBe(2)
    const m = await model(SHIP)
    expect(m.nodes.find((n) => n.id === 'skill:demo-skill')!.runs).toBe(3)
    const line = m.edges.find((e) => e.id === 'uses:session:orch:skill:demo-skill')!
    expect(graphEdgeTitle(line)).toBe('2 calls to skill demo-skill this app run (1 typed as /demo-skill)')
  })

  it('the Harness box counts the session and the configured server', async () => {
    play(events)
    const m = await model(SHIP)
    expect(m.nodes.find((n) => n.kind === 'harness')).toMatchObject({ title: 'Harness', subtitle: 'x', harness: { sessions: 1, running: 1, skillsInstalled: 1, mcpConfigured: 1 } })
  })

  it('leaves the agent status alone: only the prompt and the subagent become mirror events', () => {
    play(events)
    const kinds = agentGraphLog.snapshot().events.map((e) => e.kind)
    expect(kinds.filter((k) => k === 'access')).toHaveLength(5)
    expect(kinds.filter((k) => k === 'subagent-start')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'turn-start')).toHaveLength(2)
  })
})
