// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShipConfig, ShipConfigResult } from '@shared/ship-config'
import type { GraphNode } from '../../lib/agentGraphModel'
import { pinNeutralMachineNoun } from '../../lib/testMachineNoun'
import { HarnessPanel, type HarnessPanelProps } from './HarnessPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
pinNeutralMachineNoun()

const LOCAL = { kind: 'local' as const, label: 'this computer' }
const session = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({ id: `session:${id}`, kind: 'session', title: id, agentId: 'claude', machine: LOCAL, ...over })
const harness: GraphNode = { id: 'harness:local:this computer', kind: 'harness', title: 'Harness', machine: LOCAL, harness: { sessions: 3, running: 1 } }

const config = (over: Partial<ShipConfig> = {}): ShipConfigResult => ({
  ok: true,
  config: {
    machine: { kind: 'local', label: '' }, agents: [], commands: [], workflows: [], skills: ['grill', 'tdd'],
    mcpServers: [{ name: 'demo', scope: 'global', transport: 'stdio' }, { name: 'docs', scope: 'project', transport: 'http' }], mcpRead: true,
    pipelines: [], graphSource: null, projectGraphPath: null, globalGraphPath: '/g', projectGraphExists: false, globalGraphExists: false, warnings: [],
    ...over
  }
})

let root: Root
let host: HTMLDivElement
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})

async function show(over: Partial<HarnessPanelProps> = {}): Promise<string> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const props: HarnessPanelProps = {
    model: {
      nodes: [harness, session('a', { state: 'working' }), session('b', { state: 'waiting' }), session('c')],
      usage: {
        skills: [{ name: 'grill', calls: 4, lastEventTs: 2, typedCalls: 1 }, { name: 'plugin:thing', calls: 2, lastEventTs: 1, typedCalls: 0 }],
        mcp: [{ name: 'demo', calls: 3, lastEventTs: 3, tool: 'echo_it', typedCalls: 0 }, { name: 'claude_ai_Notion', calls: 1, lastEventTs: 1, tool: 'notion-search', typedCalls: 0 }]
      }
    },
    result: config(),
    session: { source: 'local', label: 'This computer' },
    integrations: { agents: { claude: 'enabled', codex: 'declined' } },
    sshHostKey: null,
    onReload: vi.fn(),
    ...over
  }
  await act(async () => root.render(<HarnessPanel {...props} />))
  return host.textContent ?? ''
}

describe('HarnessPanel', () => {
  it('names the machine and counts the sessions by what they have said', async () => {
    const text = await show()
    expect(text).toContain('this computer')
    expect(text).toContain('1 running')
    expect(text).toContain('1 needs you')
    expect(text).toContain('0 idle')
    expect(text).toContain('1 no signal yet')
  })

  it('states the hook choice for each agent on a local machine', async () => {
    const rows = await show({ model: { nodes: [harness, session('a'), session('x', { agentId: 'codex' })], usage: { skills: [], mcp: [] } } })
    expect(rows).toContain('Claude Codehooked')
    expect(rows).toContain('Codexdeclined')
  })

  it('does not state a relay host\'s hook choice', async () => {
    const relay = { kind: 'relay' as const, label: 'the-host' }
    const text = await show({
      session: { source: 'relay', label: 'the-host' },
      model: { nodes: [{ ...harness, machine: relay }, session('a', { machine: relay, state: 'working' })], usage: { skills: [], mcp: [] } }
    })
    expect(text).toContain('the-host')
    expect(text).toContain('The host decides which agents are hooked.')
    expect(text).not.toContain('Claude Codehooked')
  })

  it('lists installed skills with their use, and used ones from a plugin or built in', async () => {
    const text = await show()
    expect(text).toContain('2 installed, 1 used this app run.')
    expect(text).toContain('grillused ×4 · 1 typed')
    expect(text).toContain('tddnot used')
    expect(text).toContain('plugin:thingused ×2 · plugin or built-in')
  })

  it('lists configured MCP servers with transport and scope, and a connector only once used', async () => {
    const text = await show()
    expect(text).toContain('2 configured.')
    expect(text).toContain('demostdio · global · used ×3, newest echo_it')
    expect(text).toContain('docshttp · project · not used')
    expect(text).toContain('claude_ai_Notionconnector or plugin · used ×1, newest notion-search')
    expect(text).toContain('Claude.ai connectors are not in these files')
  })

  it('says an SSH host\'s MCP config was not read, and lists what was used', async () => {
    const text = await show({
      result: config({ machine: { kind: 'ssh', label: 'box' }, mcpServers: [], mcpRead: false }),
      model: { nodes: [{ ...harness, machine: { kind: 'ssh', label: 'box' } }, session('a', { machine: { kind: 'ssh', label: 'box' } })], usage: { skills: [], mcp: [{ name: 'demo', calls: 1, lastEventTs: 1, typedCalls: 0 }] } },
      sshHostKey: 'me@box'
    })
    expect(text).toContain('Not read on an SSH host. MCP servers appear here once used.')
    expect(text).toContain('democonnector or plugin · used ×1')
    expect(text).toContain('box')
  })

  it('a refused config shows its reason and still lists what was observed', async () => {
    const onReload = vi.fn()
    const text = await show({ result: { ok: false, reason: 'Viewers cannot read this machine\'s config.' }, onReload })
    expect(text).toContain('Viewers cannot read this machine\'s config.')
    expect(text).toContain('Installed skills are not known.')
    expect(text).toContain('grillused ×4')
    expect(text).not.toContain('configured.')
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
    expect(onReload).toHaveBeenCalledTimes(1)
  })
})
