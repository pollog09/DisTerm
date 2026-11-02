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
import type { ShipConfig, ShipConfigResult, ShipPipeline } from '@shared/ship-config'
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
    onShipConfigChanged: vi.fn(() => offShip)
  },
  boardLog: { onChanged: vi.fn(() => offLog) }
}

let AgentGraphView: typeof import('./AgentGraphView').AgentGraphView
let graphEdgeLabel: typeof import('./AgentGraphView').graphEdgeLabel
let graphEdgeColor: typeof import('./AgentGraphView').graphEdgeColor
let MessageCounts: typeof import('./AgentGraphView').MessageCounts
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
  ;({ AgentGraphView, graphEdgeLabel, graphEdgeColor, MessageCounts } = await import('./AgentGraphView'))
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

function view(nodes: unknown[], projectId = 'P') {
  return (
    <AgentGraphView
      projectId={projectId}
      nodes={nodes as never}
      linkEdges={noEdges}
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
    expect(names.sort()).toEqual(['Orchestrator', 'Worker'])
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

  it('a config failure is named and the graph still draws', async () => {
    shipResult.current = { ok: false, reason: 'This SSH project is not connected.' }
    await mount()
    expect(document.querySelector('.agent-graph__notices')?.textContent).toContain('This SSH project is not connected.')
    expect(document.querySelectorAll('.agent-graph-node').length).toBe(2)
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
  })
})
