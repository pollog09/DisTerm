// @vitest-environment jsdom
//
// The view against real React Flow: what it says for a real snapshot, that it covers the canvas while
// mounted, and that "go to node" lands on the terminal instead of nowhere. ModalTerminal is stubbed,
// because it opens an xterm and a pty; the session store and the view-mode store are the real ones.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentGraphEvent, AgentGraphSnapshot } from '@shared/agent-graph'
import { WORKING_STALE_MS } from '@shared/agents/stale'
import type { ShipConfig, ShipConfigResult, ShipPipeline, ShipTemplateCreateResult } from '@shared/ship-config'
import { ReactFlowProvider } from '@xyflow/react'
import type { Edge } from '@xyflow/react'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../kanban/ModalTerminal', () => ({
  ModalTerminal: ({ nodeId }: { nodeId: string }) => <div data-testid="modal-terminal">{nodeId}</div>
}))

const relationListeners: Array<(e: AgentGraphEvent) => void> = []
const snapshotResult: { current: AgentGraphSnapshot } = {
  current: { events: [], dropped: 0, capacity: 2000, history: 'board-log', historyTruncated: false }
}
const shipResult: { current: ShipConfigResult } = { current: { ok: false, reason: 'unset' } }
const offEvent = vi.fn()
const offShip = vi.fn()
const offLog = vi.fn()

const api = {
  agentGraph: {
    snapshot: vi.fn(async () => snapshotResult.current),
    onEvent: vi.fn((l: (e: AgentGraphEvent) => void) => {
      relationListeners.push(l)
      return offEvent
    }),
    readShipConfig: vi.fn(async () => shipResult.current),
    createShipGraph: vi.fn(),
    createShipTemplate: vi.fn(async (): Promise<ShipTemplateCreateResult> => ({ ok: true, root: '/p/.claude', created: ['agents/implementer.md', 'ship-graph.json'], kept: ['agents/doc-writer.md'] })),
    onShipConfigChanged: vi.fn(() => offShip)
  },
  boardLog: { onChanged: vi.fn(() => offLog) }
}

let AgentGraphView: typeof import('./AgentGraphView').AgentGraphView
let graphEdgeLabel: typeof import('./AgentGraphView').graphEdgeLabel
let graphEdgeColor: typeof import('./AgentGraphView').graphEdgeColor
let MessageCounts: typeof import('./AgentGraphView').MessageCounts
let GraphEdgeLine: typeof import('./AgentGraphView').GraphEdgeLine
let useEdgesInTransit: typeof import('./useAgentGraphData').useEdgesInTransit
let useViewMode: typeof import('../../state/viewMode').useViewMode
let canvasCoveredDepth: typeof import('../../lib/canvasCovered').canvasCoveredDepth
let resetCanvasCoveredForTest: typeof import('../../lib/canvasCovered').resetCanvasCoveredForTest

beforeAll(async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = api
  await import('../../session/localSession')
  ;({ AgentGraphView, graphEdgeLabel, graphEdgeColor, MessageCounts, GraphEdgeLine } = await import('./AgentGraphView'))
  ;({ useEdgesInTransit } = await import('./useAgentGraphData'))
  ;({ useViewMode } = await import('../../state/viewMode'))
  ;({ canvasCoveredDepth, resetCanvasCoveredForTest } = await import('../../lib/canvasCovered'))
})

const node = (id: string, title: string, agentId?: string) =>
  ({ id, type: 'terminal', position: { x: 0, y: 0 }, data: { title, ...(agentId ? { agentId } : {}) } }) as never

const noEdges: Edge[] = []
let root: Root
let host: HTMLDivElement
const onShowOnCanvas = vi.fn()
const onModalNodeChange = vi.fn()

const defaultNodes = (): unknown[] => [node('a', 'Orchestrator', 'claude'), node('b', 'Worker', 'claude')]

function view(nodes: unknown[], projectId = 'P', linkEdges: Edge[] = noEdges) {
  return (
    <AgentGraphView
      projectId={projectId}
      nodes={nodes as never}
      linkEdges={linkEdges}
      controlEdges={noEdges}
      onShowOnCanvas={onShowOnCanvas}
      onModalNodeChange={onModalNodeChange}
    />
  )
}

async function mount(nodes: unknown[] = defaultNodes()): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(view(nodes))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const configWith = (over: Partial<ShipConfig> = {}): ShipConfigResult => ({
  ok: true,
  config: {
    machine: { kind: 'local', label: '' },
    agents: [],
    commands: [],
    workflows: [],
    skills: [],
    mcpServers: [],
    mcpRead: false,
    pipelines: [],
    graphSource: null,
    projectGraphPath: '/p/.claude/ship-graph.json',
    globalGraphPath: '/g/ship-graph.json',
    projectGraphExists: false,
    globalGraphExists: false,
    warnings: [],
    ...over
  }
})
const PIPELINE: ShipPipeline = { id: 'mine', name: 'A process', triggerCommand: 'ship-change', stages: [{ id: 's', agent: 'Plan' }], edges: [] }

beforeEach(() => {
  resetCanvasCoveredForTest()
  relationListeners.length = 0
  vi.clearAllMocks()
  api.agentGraph.createShipTemplate.mockClear()
  snapshotResult.current = { events: [], dropped: 0, capacity: 2000, history: 'board-log', historyTruncated: false }
  shipResult.current = { ok: false, reason: 'unset' }
  useViewMode.setState({ viewByProject: {}, defaultView: 'canvas', requestedCardNodeId: null })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  document.body.innerHTML = ''
})

describe('AgentGraphView', () => {
  it('draws a box per agent session, under its title', async () => {
    await mount()
    const names = [...document.querySelectorAll('.agent-graph-node__name')].map((n) => n.textContent)
    expect(names.sort()).toEqual(['Harness', 'Orchestrator', 'Worker'])
  })

  it('reads through the session api, and lets go of every subscription on unmount', async () => {
    await mount()
    expect(api.agentGraph.snapshot).toHaveBeenCalledWith('P')
    expect(api.agentGraph.readShipConfig).toHaveBeenCalledWith('P')
    await act(async () => root.unmount())
    expect(offEvent).toHaveBeenCalled()
    expect(offShip).toHaveBeenCalled()
    expect(offLog).toHaveBeenCalled()
  })

  it('claims the canvas as covered while mounted, and releases it', async () => {
    await mount()
    expect(canvasCoveredDepth()).toBe(1)
    await act(async () => root.unmount())
    expect(canvasCoveredDepth()).toBe(0)
  })

  it('an empty canvas says so instead of showing an empty flow', async () => {
    await mount([])
    expect(document.querySelector('.agent-graph__empty')?.textContent).toMatch(/No agents on this canvas yet/)
    expect(document.querySelector('.react-flow')).toBeNull()
  })

  it('an empty canvas offers the way back and shows nothing about lines or runs', async () => {
    snapshotResult.current = { events: [], dropped: 7, capacity: 2000, history: 'memory', historyTruncated: false }
    shipResult.current = configWith()
    await mount([])
    expect(document.querySelector('.agent-graph__legend')).toBeNull()
    expect(document.querySelector('.agent-graph__notices')).toBeNull()
    await act(async () => (document.querySelector('.agent-graph__empty button') as HTMLButtonElement).click())
    expect(useViewMode.getState().viewByProject.P).toBe('canvas')
  })

  it('an empty canvas still names a config failure', async () => {
    shipResult.current = { ok: false, reason: 'This SSH project is not connected.' }
    await mount([])
    expect(document.querySelector('.agent-graph__notices')?.textContent).toContain('This SSH project is not connected.')
  })

  it('the legend lists only the kinds of line on screen', async () => {
    await mount(defaultNodes())
    expect(document.querySelector('.agent-graph__legend')).toBeNull()
    const lines = [{ id: 'l', source: 'a', target: 'b', data: {} }] as unknown as Edge[]
    await act(async () => root.render(view(defaultNodes(), 'P', lines)))
    const legend = document.querySelector('.agent-graph__legend')?.textContent ?? ''
    expect(legend).toContain('context link')
    expect(legend).not.toContain('refused')
  })

  it('names the machine on each box only when the boxes differ', async () => {
    await mount(defaultNodes())
    expect(document.querySelector('[data-machine]')).toBeNull()
    const mixed = defaultNodes().map((n, i) => (i === 0 ? { ...(n as { data: object }), data: { ...(n as { data: object }).data, ssh: { host: 'box' } } } : n))
    await act(async () => root.render(view(mixed)))
    expect([...document.querySelectorAll('[data-machine]')].map((b) => b.getAttribute('data-machine')).sort()).toEqual(['local', 'ssh'])
  })

  it('a config failure is named and the graph still draws', async () => {
    shipResult.current = { ok: false, reason: 'This SSH project is not connected.' }
    await mount()
    expect(document.querySelector('.agent-graph__notices')?.textContent).toContain('This SSH project is not connected.')
    expect(document.querySelectorAll('.agent-graph-node').length).toBe(3) // two sessions and their harness
  })

  it('a rejected read degrades to empty, no unhandled rejection', async () => {
    api.agentGraph.snapshot.mockRejectedValueOnce(new Error('E_NO_HANDLER'))
    api.agentGraph.readShipConfig.mockRejectedValueOnce(new Error('refused'))
    await mount()
    expect(document.querySelector('.agent-graph__notices')?.textContent).toContain('refused')
  })

  it('names the horizon when older events were dropped', async () => {
    snapshotResult.current = { events: [], dropped: 7, capacity: 2000, history: 'board-log', historyTruncated: false }
    await mount()
    expect(document.querySelector('.agent-graph__notices')?.textContent).toMatch(/7 have gone/)
  })

  it('a live event arrives without a re-read, and pulses once', async () => {
    await mount()
    expect(document.querySelector('.agent-graph-node__pulse')).toBeNull()
    const reads = api.agentGraph.snapshot.mock.calls.length
    const when = Date.now() + 1000
    await act(async () => {
      for (const l of relationListeners) l({ kind: 'delivery', id: 'x', ts: when, from: 'a', to: 'b', outcome: 'delivered' })
    })
    expect(api.agentGraph.snapshot.mock.calls.length).toBe(reads)
    expect(document.querySelector('.agent-graph-node__pulse')).not.toBeNull()
  })

  it('history from before the view opened does not flash', async () => {
    snapshotResult.current.events = [{ kind: 'delivery', id: 'old', ts: 1, from: 'a', to: 'b', outcome: 'delivered' }]
    await mount()
    expect(document.querySelector('.agent-graph-node__pulse')).toBeNull()
  })

  it('a "go to node" request opens the terminal here and is consumed', async () => {
    await mount()
    await act(async () => useViewMode.getState().requestCard('b'))
    expect(document.querySelector('[data-testid="modal-terminal"]')?.textContent).toBe('b')
    expect(useViewMode.getState().requestedCardNodeId).toBeNull()
    expect(onModalNodeChange).toHaveBeenLastCalledWith('b')
  })

  it('a request for a node with no terminal goes to the canvas', async () => {
    await mount()
    await act(async () => useViewMode.getState().requestCard('sticky-1'))
    expect(onShowOnCanvas).toHaveBeenCalledWith('sticky-1')
  })

  it('Show on canvas leaves through the prop, and Escape closes the modal', async () => {
    await mount()
    await act(async () => useViewMode.getState().requestCard('a'))
    const show = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Show on canvas'))!
    await act(async () => show.click())
    expect(onShowOnCanvas).toHaveBeenCalledWith('a')
    expect(document.querySelector('[data-testid="modal-terminal"]')).toBeNull()

    await act(async () => useViewMode.getState().requestCard('a'))
    expect(document.querySelector('[data-testid="modal-terminal"]')).not.toBeNull()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('[data-testid="modal-terminal"]')).toBeNull()
    expect(onModalNodeChange).toHaveBeenLastCalledWith(null)
  })

  it('the Canvas button returns this project to the canvas', async () => {
    useViewMode.getState().setView('P', 'graph')
    await mount()
    const btn = [...document.querySelectorAll('.agent-graph__button')].find((b) => b.textContent?.includes('Canvas')) as HTMLButtonElement
    await act(async () => btn.click())
    expect(useViewMode.getState().viewByProject.P).toBe('canvas')
  })

  it('the ship panel opens from the header', async () => {
    shipResult.current = {
      ok: true,
      config: {
        machine: { kind: 'local', label: '' },
        agents: [{ name: 'implementer', scope: 'global' }],
        commands: [],
        workflows: [],
        skills: [],
        mcpServers: [],
        mcpRead: false,
        pipelines: [],
        graphSource: null,
        projectGraphPath: '/p/.claude/ship-graph.json',
        globalGraphPath: '/g/ship-graph.json',
        projectGraphExists: false,
        globalGraphExists: false,
        warnings: []
      }
    }
    await mount()
    expect(document.querySelector('.ship-panel')).toBeNull()
    const btn = [...document.querySelectorAll('.agent-graph__button')].find((b) => b.textContent?.includes('Ship process')) as HTMLButtonElement
    await act(async () => btn.click())
    expect(document.querySelector('.ship-panel')?.textContent).toContain('implementer')
  })
})

describe('a run that goes quiet', () => {
  const subagentActivity = (): string | undefined =>
    (document.querySelector('.agent-graph-node--subagent') as HTMLElement | null)?.dataset.activity

  it('is no longer claimed as running once it passes the stale line, with no event to prompt it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      snapshotResult.current.events = [{ kind: 'subagent-start', id: 's', ts: Date.now(), nodeId: 'a', subId: 'k', subagentType: 'killed' }]
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      await act(async () => {
        root.render(view(defaultNodes()))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(subagentActivity()).toBe('running')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKING_STALE_MS - 1000)
      })
      expect(subagentActivity()).toBe('running')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(subagentActivity()).toBe('stale')
      expect(document.body.textContent).toContain('no recent signal')
    } finally {
      vi.useRealTimers()
    }
  })

  it('with no run open, arms no timer at all', async () => {
    snapshotResult.current.events = [
      { kind: 'subagent-start', id: 's', ts: Date.now(), nodeId: 'a', subId: 'k', subagentType: 'x' },
      { kind: 'subagent-end', id: 'e', ts: Date.now(), nodeId: 'a', subId: 'k' }
    ]
    const spy = vi.spyOn(globalThis, 'setTimeout')
    await mount()
    const long = spy.mock.calls.filter(([, ms]) => (ms ?? 0) > 60_000)
    spy.mockRestore()
    expect(subagentActivity()).toBe('done')
    expect(long).toEqual([])
  })
})

describe('switching between two projects that both show the graph', () => {
  it("does not keep A's process or machine on B while B's read is out", async () => {
    shipResult.current = configWith({ pipelines: [PIPELINE], graphSource: 'project', projectGraphPath: '/a/.claude/ship-graph.json' })
    await mount()
    expect(document.querySelector('.agent-graph-node--stage')).not.toBeNull()
    const btn = [...document.querySelectorAll('.agent-graph__button')].find((b) => b.textContent?.includes('Ship process')) as HTMLButtonElement
    await act(async () => btn.click())
    expect(document.querySelector('.ship-panel')?.textContent).toContain('/a/.claude/ship-graph.json')

    let answerB: (r: ShipConfigResult) => void = () => {}
    api.agentGraph.readShipConfig.mockImplementationOnce(() => new Promise<ShipConfigResult>((r) => { answerB = r }))
    await act(async () => root.render(view(defaultNodes(), 'B')))
    expect(document.querySelector('.agent-graph-node--stage')).toBeNull()
    expect(document.querySelector('.agent-graph__panel')?.textContent).not.toContain('/a/.claude')
    expect(document.querySelector('.agent-graph__source')).toBeNull()

    await act(async () => answerB(configWith({ projectGraphPath: '/b/.claude/ship-graph.json' })))
    expect(document.querySelector('.ship-panel')?.textContent).toContain('/b/.claude/ship-graph.json')
  })

  it("does not keep A's messages on B while B's history is out", async () => {
    snapshotResult.current.events = [{ kind: 'delivery', id: 'x', ts: 1, from: 'a', to: 'outsider', outcome: 'delivered' }]
    await mount()
    expect(document.body.textContent).toContain('Session outside this project')
    api.agentGraph.snapshot.mockImplementationOnce(() => new Promise<AgentGraphSnapshot>(() => {}))
    await act(async () => root.render(view(defaultNodes(), 'B')))
    expect(document.body.textContent).not.toContain('Session outside this project')
  })
})

describe('an uncertain stage', () => {
  it('shows a maybe badge and does not count the run', async () => {
    const pipeline: ShipPipeline = {
      id: 'q', name: 'Q',
      stages: [{ id: 'impl', agent: 'I' }, { id: 'r1', agent: 'R' }, { id: 'fix', agent: 'I' }],
      edges: [{ from: 'impl', to: 'r1', kind: 'next' }, { from: 'r1', to: 'fix', kind: 'next' }, { from: 'r1', to: 'impl', kind: 'reject' }]
    }
    shipResult.current = configWith({ pipelines: [pipeline], graphSource: 'project' })
    const run = (id: string, type: string, ts: number): AgentGraphEvent[] => [
      { kind: 'subagent-start', id: `s${id}`, ts, nodeId: 'a', subId: id, subagentType: type },
      { kind: 'subagent-end', id: `e${id}`, ts: ts + 1, nodeId: 'a', subId: id }
    ]
    snapshotResult.current.events = [...run('1', 'I', 10), ...run('2', 'R', 20), ...run('3', 'I', 30)]
    await mount()
    const stages = [...document.querySelectorAll('.agent-graph-node--stage')]
    const fix = stages.find((n) => n.querySelector('.agent-graph-node__subtitle') && n.textContent!.includes('maybe') && !n.querySelector('.agent-graph-node__runs'))!
    expect(fix.textContent).toContain('maybe ×1')
    expect(document.querySelector('.agent-graph__notices')?.textContent).toMatch(/could be the next stage fix or a rejection back to impl/)
    const keys = [...document.querySelectorAll('.agent-graph__notices li')].map((l) => l.textContent)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('the file-mode notice', () => {
  it('names the inference and both limits whenever a file routes the graph', async () => {
    shipResult.current = configWith({ pipelines: [PIPELINE], graphSource: 'project' })
    await mount()
    const hint = document.querySelector('.agent-graph__hint')!.textContent
    expect(hint).toContain('inferred from hook order')
    expect(hint).toContain('clean second run in one turn')
    expect(hint).toContain('from the last stage to the first')
    expect(hint).toContain('marked maybe')
  })

  it('is absent with no file, where the line itself says it cannot tell', async () => {
    shipResult.current = configWith()
    await mount()
    expect(document.querySelector('.agent-graph__hint')).toBeNull()
  })
})

describe('what a stage says', () => {
  it('shows the trigger, and for an agent with no file does not claim it is missing', async () => {
    shipResult.current = configWith({ pipelines: [PIPELINE], graphSource: 'project' })
    await mount()
    const stage = document.querySelector('.agent-graph-node--stage')!
    expect(stage.textContent).toContain('A process · /ship-change')
    expect(stage.textContent).toContain('no agent file found')
    expect(stage.textContent).not.toContain('not on this machine')
  })
})

describe('what an edge says', () => {
  const counts = (over = {}) => ({ delivered: 0, queued: 0, failed: 0, refused: 0, ...over })

  it('spells a refusal out in words, and colours it as one', () => {
    const edge = { id: 'x', source: 'a', target: 'b', kind: 'message' as const, counts: counts({ delivered: 2, refused: 1 }), latest: 'refused' as const }
    expect(graphEdgeLabel(edge)).toBe('2 delivered · 1 refused')
    expect(graphEdgeColor(edge)).toBe('var(--state-error)')
    expect(graphEdgeColor({ ...edge, latest: 'delivered' })).toBe('var(--state-success)')
    expect(graphEdgeColor({ ...edge, latest: 'queued' })).toBe('var(--state-queued)')
  })

  it('gives each outcome its own colour, and hides the ones at zero', async () => {
    host = document.createElement('div')
    root = createRoot(host)
    await act(async () => root.render(<MessageCounts counts={counts({ delivered: 2, refused: 1 })} />))
    const spans = [...host.querySelectorAll('span')]
    expect(spans.map((s) => s.textContent)).toEqual(['2 delivered', ' · 1 refused'])
    expect(spans.map((s) => s.style.color)).toEqual(['var(--state-success)', 'var(--state-error)'])
  })

  it('names the other relations', () => {
    const base = { id: 'x', source: 'a', target: 'b' }
    expect(graphEdgeLabel({ ...base, kind: 'dependency' })).toBe('then')
    expect(graphEdgeLabel({ ...base, kind: 'context' })).toBe('context')
    expect(graphEdgeLabel({ ...base, kind: 'ship-reject' })).toBe('reject')
    expect(graphEdgeLabel({ ...base, kind: 'ship-reject', traversals: 2, loop: true })).toBe('re-entered ×2')
    expect(graphEdgeLabel({ ...base, kind: 'observed', undeclared: true, traversals: 1 })).toBe('not declared ×1')
    expect(graphEdgeLabel({ ...base, kind: 'ship-next' })).toBe('')
    expect(graphEdgeLabel({ ...base, kind: 'observed', loop: true, traversals: 1 })).toBe('×1')
    expect(graphEdgeLabel({ ...base, kind: 'observed', loop: true, undeclared: true, traversals: 1 })).toBe('re-entered ×1')
  })
})

describe('harness, skills and MCP in the view', () => {
  const accessEvent = (nodeId: string, target: 'skill' | 'mcp', name: string, count: number, tool?: string): AgentGraphEvent => ({
    kind: 'access', id: `access:${nodeId}::${target}:${name}`, ts: 5, nodeId, target, name, count, ...(tool ? { tool } : {})
  })
  const click = async (el: Element | null) => {
    expect(el).not.toBeNull()
    await act(async () => (el as HTMLElement).click())
  }
  const headerButton = (text: string) =>
    [...document.querySelectorAll('.agent-graph__button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement

  it('draws one Harness box for the machine, with what it can say', async () => {
    shipResult.current = configWith({ skills: ['grill', 'tdd'], mcpServers: [{ name: 'demo', scope: 'global', transport: 'stdio' }], mcpRead: true })
    await mount()
    const harness = document.querySelector('.agent-graph-node--harness')!
    expect(harness.querySelector('.agent-graph-node__name')?.textContent).toBe('Harness')
    expect([...harness.querySelectorAll('.agent-graph-badge')].map((b) => b.textContent)).toEqual(['2 sessions', '0 running', '2 skills installed', '1 MCP configured'])
  })

  it('leaves a figure off the Harness box when the config could not state it', async () => {
    shipResult.current = { ok: false, reason: 'unset' }
    await mount()
    expect([...document.querySelectorAll('.agent-graph-node--harness .agent-graph-badge')].map((b) => b.textContent)).toEqual(['2 sessions', '0 running'])
  })

  it('a skill and an MCP server that were used become boxes, with their counts', async () => {
    snapshotResult.current.events = [accessEvent('a', 'skill', 'grill', 3), accessEvent('b', 'mcp', 'demo', 2, 'echo_it')]
    await mount()
    const skill = document.querySelector('.agent-graph-node--skill')!
    expect(skill.textContent).toContain('grill')
    expect(skill.querySelector('.agent-graph-node__runs')?.textContent).toBe('×3')
    const mcp = document.querySelector('.agent-graph-node--mcp')!
    expect(mcp.textContent).toContain('echo_it')
  })

  it('the Harness button opens the inventory, and only one side panel shows at a time', async () => {
    shipResult.current = configWith({ skills: ['grill', 'tdd'], agents: [{ name: 'implementer', scope: 'global' }] })
    snapshotResult.current.events = [accessEvent('a', 'skill', 'grill', 3)]
    await mount()
    expect(document.querySelector('.harness-panel')).toBeNull()
    await click(headerButton('Harness'))
    expect(document.querySelector('.harness-panel')?.textContent).toContain('2 installed, 1 used this app run.')
    expect(headerButton('Harness').getAttribute('aria-pressed')).toBe('true')
    await click(headerButton('Ship process'))
    expect(document.querySelector('.harness-panel')).toBeNull()
    expect(document.querySelector('.ship-panel')?.textContent).toContain('implementer')
    await click(headerButton('Ship process'))
    expect(document.querySelector('.ship-panel')).toBeNull()
  })

  it('a click on a skill, an MCP or a Harness box opens the Harness panel, not a terminal', async () => {
    snapshotResult.current.events = [accessEvent('a', 'skill', 'grill', 3), accessEvent('a', 'mcp', 'demo', 1)]
    await mount()
    for (const id of ['skill:grill', 'mcp:demo', 'harness:local:this computer']) {
      await click(null === document.querySelector(`.react-flow__node[data-id="${id}"]`) ? null : document.querySelector(`.react-flow__node[data-id="${id}"]`))
      expect(document.querySelector('.harness-panel'), id).not.toBeNull()
      expect(document.querySelector('[data-testid="modal-terminal"]'), id).toBeNull()
      await click(headerButton('Harness'))
      expect(document.querySelector('.harness-panel')).toBeNull()
    }
  })

  it('has no running animation of its own when idle: no dot until an event arrives', async () => {
    snapshotResult.current.events = [accessEvent('a', 'skill', 'grill', 3)]
    await mount()
    expect(document.querySelector('.agent-graph-edge__dot')).toBeNull()
  })
})

describe('FlowDots', () => {
  let FlowDots: typeof import('./AgentGraphView').FlowDots
  let MAX_FLOW_DOTS: number
  beforeAll(async () => {
    ;({ FlowDots, MAX_FLOW_DOTS } = await import('./AgentGraphView'))
  })
  const dots = (): SVGCircleElement[] => [...document.querySelectorAll<SVGCircleElement>('.agent-graph-edge__dot')]
  const render = async (ts: number, extra: { reverse?: boolean } = {}) => {
    await act(async () => root.render(<svg><FlowDots ts={ts} path="M 0 0 L 10 0" color="red" {...extra} /></svg>))
  }
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  it('draws nothing for no event', async () => {
    await render(0)
    expect(dots()).toHaveLength(0)
  })

  it('draws one dot for an event, on the line\'s own path and in its colour', async () => {
    await render(1000)
    expect(dots()).toHaveLength(1)
    expect(dots()[0].style.fill).toBe('red')
    expect(dots()[0].style.offsetPath).toContain('M 0 0 L 10 0')
    expect(dots()[0].hasAttribute('data-reverse')).toBe(false)
  })

  it('does not draw a second for the same event, and one more for each new one', async () => {
    await render(1000)
    await render(1000)
    expect(dots()).toHaveLength(1)
    await render(2000)
    expect(dots()).toHaveLength(2)
  })

  it('keeps at most three at once, the newest', async () => {
    for (const ts of [1, 2, 3, 4, 5]) await render(ts)
    expect(MAX_FLOW_DOTS).toBe(3)
    expect(dots()).toHaveLength(3)
  })

  it('a dot is removed when its animation ends, and only that one', async () => {
    await render(1)
    await render(2)
    // React listens for the vendor-prefixed name where the DOM has only that (jsdom); a browser fires
    // the plain one. Sending both reaches whichever it chose.
    const first = dots()[0]
    await act(async () => {
      for (const name of ['animationend', 'webkitAnimationEnd']) first.dispatchEvent(new Event(name, { bubbles: true }))
    })
    expect(dots()).toHaveLength(1)
  })

  it('runs backwards on a line whose data flows against the way it points', async () => {
    await render(1000, { reverse: true })
    expect(dots()[0].hasAttribute('data-reverse')).toBe(true)
  })
})

describe('the marks along a line', () => {
  const ROUTE = [{ x: 0, y: 0 }, { x: 600, y: 0 }]
  const renderLine = async (edge: object, inTransit: boolean): Promise<void> => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const Line = GraphEdgeLine as unknown as (p: { id: string; data: object }) => React.JSX.Element
    await act(async () => root.render(
      <ReactFlowProvider>
        <svg><Line id="e" data={{ edge: { id: 'e', source: 'a', target: 'b', ...edge }, route: ROUTE, pulseKey: 0, inTransit }} /></svg>
      </ReactFlowProvider>
    ))
  }
  const marks = (): SVGPathElement[] => [...document.querySelectorAll<SVGPathElement>('.agent-graph-edge__chevron')]

  it('a still line shows its direction with no animation', async () => {
    await renderLine({ kind: 'ship-next' }, false)
    expect(marks().length).toBe(3)
    expect(marks().every((m) => !m.hasAttribute('data-moving'))).toBe(true)
  })

  it('a line in use moves its marks, in its own colour, at a pace from its length', async () => {
    await renderLine({ kind: 'observed', traversals: 1, loop: true }, true)
    expect(marks().length).toBe(3)
    expect(marks().every((m) => m.hasAttribute('data-moving'))).toBe(true)
    expect(marks()[0].style.stroke).toBe('var(--state-warning)')
    expect(marks()[0].style.animationDuration).toBe('10s')
    expect(marks().map((m) => parseFloat(m.style.animationDelay))).toEqual([-10 / 6, -5, -50 / 6].map((d) => expect.closeTo(d)))
  })

  it('a context link gets none', async () => {
    await renderLine({ kind: 'context' }, false)
    expect(marks()).toEqual([])
  })
})

describe('useEdgesInTransit', () => {
  const edge = (ts: number) => ({ id: 'm', source: 'a', target: 'b', kind: 'message' as const, latest: 'delivered' as const, lastEventTs: ts })
  let seen: string[] = []
  function Probe({ edges }: { edges: never[] }) {
    seen = [...useEdgesInTransit(edges)]
    return null
  }

  it('stops a moment of transit when its window ends, with no event to prompt it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const edges = [edge(Date.now())] as never[]
      host = document.createElement('div')
      root = createRoot(host)
      await act(async () => root.render(<Probe edges={edges} />))
      expect(seen).toEqual(['m'])
      await act(async () => { await vi.advanceTimersByTimeAsync(14_000) })
      expect(seen).toEqual(['m'])
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(seen).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('with nothing recent, arms no timer at all', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    host = document.createElement('div')
    root = createRoot(host)
    spy.mockClear()
    await act(async () => root.render(<Probe edges={[edge(1)] as never[]} />))
    const ours = spy.mock.calls.filter(([, ms]) => ms !== undefined && ms > 1000)
    spy.mockRestore()
    expect(seen).toEqual([])
    expect(ours).toEqual([])
  })
})

describe('setting a project up from the empty graph', () => {
  const button = (): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>('.agent-graph__empty button')].find((b) => /graph engineering|Setting up/.test(b.textContent ?? ''))

  it('offers it, says what it adds, and keeps the way to the canvas', async () => {
    shipResult.current = configWith()
    await mount([])
    expect(button()?.disabled).toBe(false)
    const text = document.querySelector('.agent-graph__empty')!.textContent
    expect(text).toContain('three agents, a /ship-change command and ship-graph.json')
    expect(text).toContain('Go to canvas')
    expect(api.agentGraph.createShipTemplate).not.toHaveBeenCalled()
  })

  it('while the machine has not answered, or could not, it claims nothing', async () => {
    api.agentGraph.readShipConfig.mockImplementationOnce(() => new Promise<ShipConfigResult>(() => {}))
    await mount([])
    expect(button()).toBeUndefined()
    await act(async () => root.unmount())
    host.remove()

    shipResult.current = { ok: false, reason: 'This SSH project is not connected.' }
    await mount([])
    expect(button()).toBeUndefined()
    expect(document.querySelector('.agent-graph__notices')?.textContent).toContain('not connected')
  })

  it('a canvas with no folder shows it disabled, with the reason', async () => {
    shipResult.current = configWith({ projectGraphPath: null })
    await mount([])
    expect(button()?.disabled).toBe(true)
    expect(document.querySelector('[data-role="reason"]')?.textContent).toBe('This canvas has no project folder.')
  })

  it('a project with a routing file is not offered it', async () => {
    for (const over of [{ projectGraphExists: true }, { projectGraphBlocked: true as const }, { graphSource: 'global' as const }]) {
      shipResult.current = configWith(over)
      await mount([])
      expect(button(), JSON.stringify(over)).toBeUndefined()
      await act(async () => root.unmount())
      host.remove()
    }
    await mount([])
  })

  it('on success the pipeline appears at once, and a line says what was made and how to run it', async () => {
    shipResult.current = configWith()
    await mount([])
    shipResult.current = configWith({ pipelines: [PIPELINE], graphSource: 'project', projectGraphExists: true })
    await act(async () => button()!.click())
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(api.agentGraph.createShipTemplate).toHaveBeenCalledWith('P')
    expect(document.querySelector('.agent-graph__empty')).toBeNull()
    expect(document.querySelector('.agent-graph-node--stage')).not.toBeNull()
    const note = document.querySelector('.agent-graph__template-note')!
    expect(note.getAttribute('role')).toBe('status')
    expect(note.textContent).toContain('Created 2 files in /p/.claude.')
    expect(note.textContent).toContain('agents/doc-writer.md')
    expect(note.textContent).toContain('/ship-change <task>')
    await act(async () => (note.querySelector('button') as HTMLButtonElement).click())
    expect(document.querySelector('.agent-graph__template-note')).toBeNull()
  })

  it('a failure is said in place, the offer stays, and it does not reject', async () => {
    shipResult.current = configWith()
    api.agentGraph.createShipTemplate.mockResolvedValueOnce({ ok: false, reason: 'failed', message: 'Could not write it.' })
    await mount([])
    await act(async () => button()!.click())
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelector('.agent-graph__empty [role="alert"]')?.textContent).toBe('Could not write it.')
    expect(button()?.disabled).toBe(false)

    api.agentGraph.createShipTemplate.mockRejectedValueOnce(new Error('refused by the host'))
    await act(async () => button()!.click())
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelector('.agent-graph__empty [role="alert"]')?.textContent).toContain('refused by the host')
  })

  it('is disabled while it runs, so a second click cannot start another', async () => {
    shipResult.current = configWith()
    let finish: (r: ShipTemplateCreateResult) => void = () => {}
    api.agentGraph.createShipTemplate.mockImplementationOnce(() => new Promise<ShipTemplateCreateResult>((r) => { finish = r }))
    await mount([])
    await act(async () => button()!.click())
    expect(button()?.disabled).toBe(true)
    expect(button()?.textContent).toBe('Setting up…')
    await act(async () => finish({ ok: false, reason: 'failed', message: 'x' }))
  })

  it("an answer for a project switched away from stays off this one", async () => {
    shipResult.current = configWith()
    let finish: (r: ShipTemplateCreateResult) => void = () => {}
    api.agentGraph.createShipTemplate.mockImplementationOnce(() => new Promise<ShipTemplateCreateResult>((r) => { finish = r }))
    await mount([])
    await act(async () => button()!.click())
    await act(async () => root.render(view([], 'B')))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const reads = api.agentGraph.readShipConfig.mock.calls.length
    await act(async () => finish({ ok: true, root: '/a/.claude', created: ['x'], kept: [] }))
    expect(document.querySelector('.agent-graph__template-note')).toBeNull()
    expect(api.agentGraph.readShipConfig.mock.calls.length).toBe(reads)
    expect(button()?.disabled).toBe(false)
  })
})
