import { describe, expect, it } from 'vitest'
import type { ShipConfig } from '@shared/ship-config'
import type { GraphNode } from './agentGraphModel'
import { harnessInventory, integrationView, mcpNameKey, sessionStateCounts } from './harnessPanelModel'

const LOCAL = { kind: 'local' as const, label: 'this computer' }
const box = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({ id, kind: 'session', title: id, agentId: 'claude', machine: LOCAL, ...over })

describe('sessionStateCounts', () => {
  it('buckets agent sessions, and an agent that has said nothing is not idle', () => {
    const nodes = [
      box('a', { state: 'working' }),
      box('b', { state: 'waiting' }),
      box('c', { state: 'blocked' }),
      box('d', { state: 'done' }),
      box('e'),
      box('plain', { agentId: undefined }),
      { id: 'n', kind: 'note', title: 'n' } as GraphNode
    ]
    expect(sessionStateCounts(nodes)).toEqual({ running: 1, needsYou: 2, idle: 1, noSignal: 1 })
  })

  it('counts one machine at a time', () => {
    const remote = { kind: 'ssh' as const, label: 'box' }
    const nodes = [box('a', { state: 'working' }), box('b', { state: 'working', machine: remote })]
    expect(sessionStateCounts(nodes, remote).running).toBe(1)
  })
})

describe('integrationView', () => {
  const settings = { agents: { claude: 'enabled', codex: 'declined' }, hosts: { 'me@box': 'enabled' } } as const

  it('a local machine reads its own choices, only for agents on the canvas or enabled', () => {
    expect(integrationView(LOCAL, ['codex', 'gemini'], settings, null)).toEqual({
      rows: [{ agent: 'claude', status: 'enabled' }, { agent: 'codex', status: 'declined' }, { agent: 'gemini', status: 'not asked' }]
    })
  })

  it('a relay tab states nothing it cannot read', () => {
    const view = integrationView({ kind: 'relay', label: 'host' }, ['claude'], settings, null)
    expect(view.rows).toEqual([])
    expect(view.statement).toMatch(/host decides/)
  })

  it('an SSH host needs the host and the agent both', () => {
    const remote = { kind: 'ssh' as const, label: 'box' }
    const view = integrationView(remote, ['claude', 'codex', 'gemini'], { ...settings }, 'me@box')
    expect(view.rows).toEqual([{ agent: 'claude', status: 'enabled' }, { agent: 'codex', status: 'declined' }, { agent: 'gemini', status: 'not asked' }])
    expect(integrationView(remote, ['claude'], { agents: { claude: 'enabled' }, hosts: { 'me@box': 'declined' } }, 'me@box').rows).toEqual([{ agent: 'claude', status: 'declined' }])
    expect(integrationView(remote, ['claude'], { agents: { claude: 'enabled' } }, 'me@box').rows).toEqual([{ agent: 'claude', status: 'not asked' }])
  })

  it('an SSH host with no saved connection to match states nothing', () => {
    const view = integrationView({ kind: 'ssh', label: 'box' }, ['claude'], settings, null)
    expect(view.rows).toEqual([])
    expect(view.statement).toBeTruthy()
  })
})

describe('harnessInventory', () => {
  const config = (over: Partial<ShipConfig> = {}): ShipConfig => ({
    machine: { kind: 'local', label: '' }, agents: [], commands: ['ship-change'], workflows: [], skills: ['grill', 'tdd'],
    mcpServers: [{ name: 'demo', scope: 'global', transport: 'stdio' }, { name: 'my.server', scope: 'project', transport: 'http' }],
    mcpRead: true, pipelines: [], graphSource: null, projectGraphPath: null, globalGraphPath: '/g',
    projectGraphExists: false, globalGraphExists: false, warnings: [], ...over
  })
  const usage = {
    skills: [{ name: 'grill', calls: 4, lastEventTs: 2, typedCalls: 1 }, { name: 'ship-change', calls: 1, lastEventTs: 3, typedCalls: 1 }, { name: 'plugin:thing', calls: 2, lastEventTs: 1, typedCalls: 0 }],
    mcp: [{ name: 'demo', calls: 3, lastEventTs: 5, tool: 'echo_it', typedCalls: 0 }, { name: 'my_server', calls: 1, lastEventTs: 4, typedCalls: 0 }, { name: 'claude_ai_Notion', calls: 2, lastEventTs: 6, tool: 'notion-search', typedCalls: 0 }]
  }

  it('lists installed skills with their use, and used ones the machine has no folder for', () => {
    expect(harnessInventory(config(), usage).skills).toEqual([
      { name: 'grill', installed: true, command: false, calls: 4, typedCalls: 1 },
      { name: 'plugin:thing', installed: false, command: false, calls: 2, typedCalls: 0 },
      { name: 'ship-change', installed: false, command: true, calls: 1, typedCalls: 1 },
      { name: 'tdd', installed: true, command: false, calls: 0, typedCalls: 0 }
    ])
  })

  it('matches a configured server to its tool id even when Claude rewrote the name', () => {
    const rows = harnessInventory(config(), usage).mcp
    expect(rows.map((r) => [r.name, !!r.server, r.calls])).toEqual([
      ['demo', true, 3],
      ['claude_ai_Notion', false, 2],
      ['my.server', true, 1]
    ])
    expect(mcpNameKey('my.server')).toBe('my_server')
  })

  it('with no config the observed use is all there is, and configured is unstated', () => {
    const inv = harnessInventory(null, usage)
    expect(inv.mcpRead).toBe(false)
    expect(inv.skills.every((s) => !s.installed)).toBe(true)
    expect(inv.mcp.every((m) => !m.server)).toBe(true)
  })

  it('a config whose MCP files were not read lists none as configured', () => {
    const inv = harnessInventory(config({ mcpServers: [], mcpRead: false }), { skills: [], mcp: [] })
    expect(inv).toMatchObject({ mcpRead: false, mcp: [] })
  })
})
