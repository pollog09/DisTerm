// @vitest-environment jsdom
//
// The system map picture, mounted through AgentGraphView against real React Flow (the harness of
// AgentGraphView.test.tsx). jsdom measures no node, so React Flow draws no edges here: the boxes, the
// player, the "What is moving" panel and the legend are what is checked; the dots and line labels are
// not reachable (see the Gaps in .pipeline/test-results.md).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentGraphEvent, AgentGraphSnapshot } from '@shared/agent-graph'
import type { ShipConfigResult } from '@shared/ship-config'
import { parseSystemMap, type SystemMap, type SystemMapResult } from '@shared/system-map'
import type { Edge } from '@xyflow/react'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../kanban/ModalTerminal', () => ({
  ModalTerminal: ({ nodeId }: { nodeId: string }) => <div data-testid="modal-terminal">{nodeId}</div>
}))

const graph3d = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }))
vi.mock('./AgentGraph3D', () => ({
  default: (props: Record<string, unknown>) => {
    graph3d.last = props
    return <div data-testid="graph-3d" aria-label={props.ariaLabel as string} />
  }
}))

const snapshotResult: { current: AgentGraphSnapshot } = {
  current: { events: [], dropped: 0, capacity: 2000, history: 'board-log', historyTruncated: false }
}
const mapResult: { current: SystemMapResult } = { current: { ok: true, read: { kind: 'missing' } } }
const offMap = vi.fn()
const mapListeners: Array<() => void> = []

const api = {
  agentGraph: {
    snapshot: vi.fn(async () => snapshotResult.current),
    onEvent: vi.fn(() => () => {}),
    readShipConfig: vi.fn(async (): Promise<ShipConfigResult> => ({ ok: false, reason: 'unset' })),
    createShipGraph: vi.fn(),
    createShipTemplate: vi.fn(),
    onShipConfigChanged: vi.fn(() => () => {}),
    readSystemMap: vi.fn(async () => mapResult.current),
    onSystemMapChanged: vi.fn((_projectId: string, cb: () => void) => {
      mapListeners.push(cb)
      return offMap
    })
  },
  boardLog: { onChanged: vi.fn(() => () => {}) }
}

let AgentGraphView: typeof import('./AgentGraphView').AgentGraphView
let SV: typeof import('./SystemMapView')
let useViewMode: typeof import('../../state/viewMode').useViewMode
let useAgentGraphDisplay: typeof import('../../state/agentGraphDisplay').useAgentGraphDisplay

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
  ;({ AgentGraphView } = await import('./AgentGraphView'))
  SV = await import('./SystemMapView')
  ;({ useViewMode } = await import('../../state/viewMode'))
  ;({ useAgentGraphDisplay } = await import('../../state/agentGraphDisplay'))
})

const node = (id: string, title: string, agentId?: string) =>
  ({ id, type: 'terminal', position: { x: 0, y: 0 }, data: { title, ...(agentId ? { agentId } : {}) } }) as never
const noEdges: Edge[] = []
const defaultNodes = (): unknown[] => [node('a', 'Orchestrator', 'claude'), node('b', 'Worker', 'claude')]

let root: Root
let host: HTMLDivElement
const onShowOnCanvas = vi.fn()
const onModalNodeChange = vi.fn()
const onMapThisRepo = vi.fn((): void => {})

function view(nodes: unknown[] = defaultNodes(), projectId = 'P') {
  return (
    <AgentGraphView
      projectId={projectId}
      nodes={nodes as never}
      linkEdges={noEdges}
      controlEdges={noEdges}
      onShowOnCanvas={onShowOnCanvas}
      onModalNodeChange={onModalNodeChange}
      onMapThisRepo={onMapThisRepo}
    />
  )
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount(nodes: unknown[] = defaultNodes(), projectId = 'P'): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(view(nodes, projectId)))
  await flush()
}

const button = (name: string, within: ParentNode = document): HTMLButtonElement | undefined =>
  [...within.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name || b.textContent?.trim() === name)
const pictureButton = (name: 'Agents' | 'System map') => button(name, document.querySelector('[role="group"][aria-label="Picture"]')!)!
const click = async (b: HTMLElement | undefined): Promise<void> => {
  expect(b).toBeTruthy()
  await act(async () => b!.click())
  await flush()
}
const toMap = async (): Promise<void> => click(pictureButton('System map'))
const stepText = (): string => document.querySelector('.system-map__step')?.textContent ?? ''
const parts = () => [...document.querySelectorAll<HTMLElement>('.system-map-part')]
const part = (label: string) => parts().find((p) => p.querySelector('.system-map-part__label')?.textContent === label)!

function mapOf(doc: unknown): SystemMap {
  const r = parseSystemMap(JSON.stringify(doc))
  if (!r.ok) throw new Error(r.problems.join('\n'))
  return r.map
}
const MAP = mapOf({
  version: 1,
  title: 'Shop',
  parts: [
    { id: 'web', label: 'Web', kind: 'caller', files: ['web/**'] },
    { id: 'api', label: 'API', subtitle: 'Go API', kind: 'service', files: ['src/api/**'] },
    { id: 'db', label: 'Postgres', kind: 'store', files: ['db/**'] },
    { id: 'jobs', label: 'Jobs', kind: 'worker', files: ['jobs/**'] },
    { id: 'stripe', label: 'Stripe', kind: 'external', files: [] }
  ],
  links: [{ from: 'web', to: 'api', label: 'REST' }, { from: 'api', to: 'db' }],
  flows: [
    {
      id: 'login',
      name: 'Log in',
      group: 'Auth',
      steps: [
        { from: 'web', to: 'api', label: 'POST /login' },
        { from: 'api', to: 'db', label: 'check the password', mark: 'guard' },
        { from: 'api', to: 'web', label: 'wrong password', mark: 'refusal' }
      ]
    },
    { id: 'pay', name: 'Pay', group: 'Billing', steps: [{ from: 'api', to: 'stripe', label: 'charge' }] }
  ]
})
const COMMIT = { sha: '0123456789abcdef', ts: Date.UTC(2026, 2, 4, 12), subject: 'map' }
const validResult = (over: Partial<Extract<SystemMapResult, { ok: true }>['read']> = {}): SystemMapResult => ({
  ok: true,
  read: { kind: 'valid', map: MAP, emptyParts: ['jobs'], fileCheck: 'checked', lastCommit: COMMIT, ...over } as Extract<SystemMapResult, { ok: true }>['read']
})
const touch = (over: Record<string, unknown>): AgentGraphEvent =>
  ({ kind: 'map-touch', id: `t-${Math.random()}`, ts: Date.now() - 30_000, projectId: 'P', nodeId: 'a', count: 1, ...over }) as AgentGraphEvent

beforeEach(() => {
  vi.clearAllMocks()
  mapListeners.length = 0
  snapshotResult.current = { events: [], dropped: 0, capacity: 2000, history: 'board-log', historyTruncated: false }
  mapResult.current = { ok: true, read: { kind: 'missing' } }
  onMapThisRepo.mockImplementation(() => {})
  useViewMode.setState({ viewByProject: {}, defaultView: 'canvas', requestedCardNodeId: null, graphPictureByProject: {} })
  useAgentGraphDisplay.setState({ dimension: '2d' })
  graph3d.last = null
})

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => root?.unmount())
  host?.remove()
  document.body.innerHTML = ''
})

describe('the picture switch', () => {
  it('opens on Agents, switches to the system map, and is remembered per project', async () => {
    await mount()
    expect(pictureButton('Agents').getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.agent-graph__title')?.textContent).toBe('Agent graph')
    expect(api.agentGraph.readSystemMap).not.toHaveBeenCalled()
    await toMap()
    expect(pictureButton('System map').getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.agent-graph__title')?.textContent).toBe('System map')
    expect(api.agentGraph.readSystemMap).toHaveBeenCalledWith('P')
    expect(api.agentGraph.onSystemMapChanged).toHaveBeenCalledWith('P', expect.any(Function))

    await act(async () => root.unmount())
    await mount(defaultNodes(), 'P')
    expect(pictureButton('System map').getAttribute('aria-pressed')).toBe('true')
    await act(async () => root.unmount())
    await mount(defaultNodes(), 'Q')
    expect(pictureButton('Agents').getAttribute('aria-pressed')).toBe('true')
  })

  it('hides Harness and Ship process on the system map, and closes an open panel', async () => {
    await mount()
    await click(button('Harness'))
    expect(document.querySelector('aside[aria-label="Harness"]')).not.toBeNull()
    await toMap()
    expect(document.querySelector('aside[aria-label="Harness"]')).toBeNull()
    expect(button('Harness')).toBeUndefined()
    expect([...document.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Ship process'))).toBe(false)
    await click(pictureButton('Agents'))
    expect(button('Harness')).toBeTruthy()
    expect(document.querySelector('aside[aria-label="Harness"]')).toBeNull()
  })

  it('leaves the 2D/3D choice alone', async () => {
    useAgentGraphDisplay.setState({ dimension: '3d' })
    await mount()
    await toMap()
    expect(useAgentGraphDisplay.getState().dimension).toBe('3d')
    await click(pictureButton('Agents'))
    expect(useAgentGraphDisplay.getState().dimension).toBe('3d')
  })

  it('leaving the picture releases the map subscription', async () => {
    await mount()
    await toMap()
    expect(offMap).not.toHaveBeenCalled()
    await click(pictureButton('Agents'))
    expect(offMap).toHaveBeenCalledTimes(1)
  })

  it('a change pushed by the core re-reads the map', async () => {
    await mount()
    await toMap()
    expect(document.querySelector('.agent-graph__empty-title')?.textContent).toBe(SV.SYSTEM_MAP_EMPTY_TITLE)
    mapResult.current = validResult()
    await act(async () => mapListeners.at(-1)!())
    await flush()
    expect(parts()).toHaveLength(5)
  })
})

describe('the states', () => {
  it('missing: the empty state, and Map this repo hands off to the canvas without opening the modal', async () => {
    await mount()
    await toMap()
    const empty = document.querySelector('.agent-graph__empty')!
    expect(empty.textContent).toContain(SV.SYSTEM_MAP_EMPTY_TITLE)
    expect(empty.textContent).toContain(SV.SYSTEM_MAP_EMPTY_TEXT)
    expect(empty.textContent).toContain(SV.SYSTEM_MAP_ACTION_NOTE)
    await click(button(SV.SYSTEM_MAP_ACTION))
    expect(onMapThisRepo).toHaveBeenCalledTimes(1)
    // The modal never launches a CLI: the new node must mount on the canvas, which types its launch.
    await act(async () => root.render(view([...defaultNodes(), node('c', 'System map', 'claude')])))
    await flush()
    expect(document.querySelector('[data-testid="modal-terminal"]')).toBeNull()
  })

  it('missing, and addAgentNode refused: no modal', async () => {
    await mount()
    await toMap()
    await click(button(SV.SYSTEM_MAP_ACTION))
    expect(onMapThisRepo).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-testid="modal-terminal"]')).toBeNull()
  })

  it('a canvas with no folder: the reason, and no action', async () => {
    mapResult.current = { ok: false, reason: 'This canvas has no folder, so there is no repo to map.' }
    await mount()
    await toMap()
    expect(document.querySelector('.agent-graph__body .agent-graph__notices')?.textContent).toBe('This canvas has no folder, so there is no repo to map.')
    expect(button(SV.SYSTEM_MAP_ACTION)).toBeUndefined()
    expect(parts()).toHaveLength(0)
  })

  it('a rejected read shows its error as the reason', async () => {
    api.agentGraph.readSystemMap.mockImplementationOnce(async () => {
      throw new Error('relay refused')
    })
    await mount()
    await toMap()
    expect(document.querySelector('.agent-graph__body .agent-graph__notices')?.textContent).toContain('relay refused')
  })

  it('invalid: the problems listed', async () => {
    mapResult.current = { ok: true, read: { kind: 'invalid', problems: ['version: must be 1.', 'links[0].to: "x" is not a part.'], lastCommit: null } }
    await mount()
    await toMap()
    const box = document.querySelector('.system-map__problems')!
    expect(box.textContent).toContain(SV.SYSTEM_MAP_PROBLEMS_TITLE)
    expect([...box.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['version: must be 1.', 'links[0].to: "x" is not a part.'])
    expect(box.textContent).toContain('Fix docs/system-map.json, or ask an agent to. This view reloads when the file changes.')
  })

  it('valid: one box per part with its kind and the no-files badge, and the header names the map and its commit', async () => {
    mapResult.current = validResult()
    await mount()
    await toMap()
    expect(parts().map((p) => [p.querySelector('.system-map-part__label')?.textContent, p.dataset.kind, p.hasAttribute('data-empty')])).toEqual([
      ['Web', 'caller', false],
      ['API', 'service', false],
      ['Postgres', 'store', false],
      ['Jobs', 'worker', true],
      ['Stripe', 'external', false]
    ])
    expect(part('Jobs').querySelector('.system-map-part__badge')?.textContent).toBe('no files')
    expect(part('API').querySelector('.system-map-part__subtitle')?.textContent).toBe('Go API')
    const meta = [...document.querySelectorAll('.agent-graph__heading .agent-graph__source')].map((s) => s.textContent)
    expect(meta).toEqual(['Shop', `Last changed in 0123456, ${new Date(COMMIT.ts).toLocaleDateString()}`])
    expect(document.querySelector('.system-map__legend')?.textContent).toContain('Drawn for a flow step only')
  })

  it('never committed, and not a git repo: Not committed yet, no flags, and the note', async () => {
    mapResult.current = validResult({ lastCommit: null, emptyParts: [], fileCheck: 'not-git' } as never)
    await mount()
    await toMap()
    expect([...document.querySelectorAll('.agent-graph__heading .agent-graph__source')].map((s) => s.textContent)).toEqual(['Shop', 'Not committed yet'])
    expect(parts().some((p) => p.hasAttribute('data-empty'))).toBe(false)
    expect(document.querySelector('.system-map__side')?.textContent).toContain('Parts were not checked against files: not a git repository.')
  })

  it('too many files: the note, no flags', async () => {
    mapResult.current = validResult({ emptyParts: [], fileCheck: 'too-many-files' } as never)
    await mount()
    await toMap()
    expect(document.querySelector('.system-map__side')?.textContent).toContain('Parts were not checked against files: more than 50000 files.')
  })
})

describe('an empty-parts check over budget (Revision 1)', () => {
  it('shows its note and no badge', async () => {
    mapResult.current = validResult({ emptyParts: [], fileCheck: 'over-budget' } as never)
    await mount()
    await toMap()
    expect(parts()).toHaveLength(5)
    expect(parts().some((p) => p.hasAttribute('data-empty'))).toBe(false)
    expect(document.querySelectorAll('.system-map-part__badge')).toHaveLength(0)
    expect(document.querySelector('.system-map__side')?.textContent).toContain("Parts were not checked against files: the map's globs were too costly to check.")
  })
})

describe('live touches', () => {
  it('a touch from a terminal of this project lights the part and names the session', async () => {
    mapResult.current = validResult()
    snapshotResult.current.events = [touch({ partId: 'api' }), touch({ partId: 'db', subId: 'a404fab851c0d8e25', subType: 'general-purpose' })]
    await mount()
    await toMap()
    expect(part('API').hasAttribute('data-live')).toBe(true)
    expect(part('API').title).toContain('Edited by Orchestrator')
    expect(part('Postgres').title).toContain('Edited by Orchestrator › general-purpose')
    expect(part('Web').hasAttribute('data-live')).toBe(false)
  })

  it('a touch for another project\'s id, or from a node not on this canvas, does not', async () => {
    mapResult.current = validResult()
    snapshotResult.current.events = [touch({ partId: 'api', projectId: 'Q' }), touch({ partId: 'db', nodeId: 'elsewhere' })]
    await mount()
    await toMap()
    expect(parts().some((p) => p.hasAttribute('data-live'))).toBe(false)
  })

  it('the unmatched counter', async () => {
    mapResult.current = validResult()
    snapshotResult.current.events = [touch({ count: 1 })]
    await mount()
    await toMap()
    expect(document.querySelector('.system-map__side')?.textContent).toContain('1 edit this app run matched no part.')
    await act(async () => root.unmount())
    snapshotResult.current.events = [touch({ count: 2 }), touch({ nodeId: 'b', count: 1 })]
    await mount()
    expect(document.querySelector('.system-map__side')?.textContent).toContain('3 edits this app run matched no part.')
  })

  it('no unmatched edits, no counter', async () => {
    mapResult.current = validResult()
    await mount()
    await toMap()
    expect(document.querySelector('.system-map__side')?.textContent).not.toContain('matched no part')
  })
})

describe('playing a flow', () => {
  const flowButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('.system-map__flow')].find((b) => b.querySelector('.system-map__flow-name')?.textContent === name)!
  const moving = () => [...document.querySelectorAll('.system-map__moving li')].map((li) => li.textContent)
  const advance = async (ms: number): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('the flows list: Everything at once, then the groups with their step counts; nothing selected, nothing playing', async () => {
    mapResult.current = validResult()
    await mount()
    await toMap()
    const flows = [...document.querySelectorAll('.system-map__flow')].map((b) => b.textContent)
    expect(flows).toEqual(['Everything at once3 steps', 'Log in3 steps', 'Pay1 step'])
    expect([...document.querySelectorAll('.system-map__group-title')].map((h) => h.textContent)).toEqual(['Auth', 'Billing'])
    expect([...document.querySelectorAll('.system-map__flow')].every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect(stepText()).toBe('Pick a flow to play it.')
    for (const name of ['Previous step', 'Play', 'Next step', '0.5x', '1x', '2x']) expect(button(name)?.disabled, name).toBe(true)
    expect(document.querySelector('.system-map__side')?.textContent).toContain('Nothing is moving.')
    expect(document.querySelectorAll('.system-map-dot')).toHaveLength(0)
  })

  it('nothing selected: no timer at all', async () => {
    mapResult.current = validResult()
    await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await toMap()
    await advance(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('picking a flow plays it: Step 1 of n, then on by itself to the last step, which stays, with no timer left', async () => {
    mapResult.current = validResult()
    await mount()
    await toMap()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await click(flowButton('Log in'))
    expect(flowButton('Log in').getAttribute('aria-pressed')).toBe('true')
    expect(stepText()).toBe('Step 1 of 3')
    expect(button('Pause')).toBeTruthy()
    expect(moving()).toEqual(['Web → APIPOST /login'])
    await advance(1600)
    expect(stepText()).toBe('Step 2 of 3')
    expect(moving()).toEqual(['API → Postgrescheck the passwordguard'])
    await advance(1600)
    expect(stepText()).toBe('Step 3 of 3')
    expect(document.querySelector('.system-map__tag')?.getAttribute('data-mark')).toBe('refusal')
    await advance(1600)
    expect(stepText()).toBe('Step 3 of 3')
    expect(button('Play')).toBeTruthy()
    expect(vi.getTimerCount()).toBe(0)
    // Play at the last step starts over.
    await click(button('Play'))
    expect(stepText()).toBe('Step 1 of 3')
    expect(button('Pause')).toBeTruthy()
  })

  it('Pause stops the clock; Forward and Back step and clamp', async () => {
    mapResult.current = validResult()
    await mount()
    await toMap()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await click(flowButton('Log in'))
    await click(button('Pause'))
    expect(vi.getTimerCount()).toBe(0)
    await advance(10_000)
    expect(stepText()).toBe('Step 1 of 3')
    expect(button('Previous step')?.disabled).toBe(true)
    await click(button('Next step'))
    expect(stepText()).toBe('Step 2 of 3')
    await click(button('Next step'))
    expect(stepText()).toBe('Step 3 of 3')
    expect(button('Next step')?.disabled).toBe(true)
    await click(button('Previous step'))
    expect(stepText()).toBe('Step 2 of 3')
    expect(vi.getTimerCount()).toBe(0) // paused: stepping does not start the clock
  })

  it('the speed buttons: 1x by default, 2x halves the step', async () => {
    mapResult.current = validResult()
    await mount()
    await toMap()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await click(flowButton('Log in'))
    expect(button('1x')?.getAttribute('aria-pressed')).toBe('true')
    await click(button('2x'))
    expect(button('2x')?.getAttribute('aria-pressed')).toBe('true')
    await advance(799)
    expect(stepText()).toBe('Step 1 of 3')
    await advance(1)
    expect(stepText()).toBe('Step 2 of 3')
    await click(button('0.5x'))
    await advance(3199)
    expect(stepText()).toBe('Step 2 of 3')
    await advance(1)
    expect(stepText()).toBe('Step 3 of 3')
  })

  it('Everything at once moves step i of every flow, named by flow', async () => {
    mapResult.current = validResult()
    await mount()
    await toMap()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await click(flowButton('Everything at once'))
    expect(stepText()).toBe('Step 1 of 3')
    expect(moving()).toEqual(['Log in · Web → APIPOST /login', 'Pay · API → Stripecharge'])
  })

  it('a new map structure resets the selection to none', async () => {
    mapResult.current = validResult()
    await mount()
    await toMap()
    await click(flowButton('Log in'))
    expect(stepText()).toBe('Step 1 of 3')
    mapResult.current = validResult({ map: { ...MAP, links: [...MAP.links, { from: 'web', to: 'db' }] } } as never)
    await act(async () => mapListeners.at(-1)!())
    await flush()
    expect(stepText()).toBe('Pick a flow to play it.')
  })
})

describe('the rest of the view while the system map is up', () => {
  it('a go-to-node request opens the terminal in the modal and is consumed', async () => {
    mapResult.current = validResult()
    await mount()
    await toMap()
    await act(async () => useViewMode.getState().requestCard('b'))
    expect(document.querySelector('[data-testid="modal-terminal"]')?.textContent).toBe('b')
    expect(useViewMode.getState().requestedCardNodeId).toBeNull()
  })

  it('3D: the system map goes through the 3D view with its pins, hover text, no click row and its own label', async () => {
    mapResult.current = validResult()
    snapshotResult.current.events = [touch({ partId: 'api' })]
    useAgentGraphDisplay.setState({ dimension: '3d' })
    const ctx = { getExtension: () => null }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as never)
    await mount()
    await toMap()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(graph3d.last).not.toBeNull()
    const p = graph3d.last!
    expect(p.ariaLabel).toBe('System map in 3D. Fly with W A S D, Space and Shift; drag to turn.')
    expect(p.clickHint).toBeNull()
    expect(p.showMachine).toBe(false)
    expect((p.pinned as Map<string, unknown>).size).toBe(5)
    const nodes = p.nodes as Array<{ id: string; kind: string; activity?: string }>
    expect(nodes.map((n) => n.id)).toEqual(['part:web', 'part:api', 'part:db', 'part:jobs', 'part:stripe'])
    expect(nodes.find((n) => n.id === 'part:api')?.activity).toBe('running')
    expect((p.describeNode as (n: unknown) => string[])(nodes[1])).toContain('Service part')
  })

  it('3D with no WebGL: the agent graph\'s 2D fallback notice, and the system map draws in 2D', async () => {
    mapResult.current = validResult()
    useAgentGraphDisplay.setState({ dimension: '3d' })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => null) as never)
    await mount()
    await toMap()
    expect(graph3d.last).toBeNull()
    expect(document.querySelector('.agent-graph__notices')?.textContent).toMatch(/WebGL/)
    expect(parts()).toHaveLength(5)
  })
})
