// @vitest-environment jsdom
//
// The 3D chunk that never arrives (a missing file, a failed fetch). `lazy()` keeps its first answer for
// the life of the module, so this needs its own module graph: here every import of the 3D view fails.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Edge } from '@xyflow/react'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../kanban/ModalTerminal', () => ({ ModalTerminal: () => null }))
vi.mock('./AgentGraph3D', () => {
  throw new Error('Failed to fetch dynamically imported module')
})

const api = {
  agentGraph: {
    snapshot: vi.fn(async () => ({ events: [], dropped: 0, capacity: 2000, history: 'board-log', historyTruncated: false })),
    onEvent: vi.fn(() => () => {}),
    readShipConfig: vi.fn(async () => ({ ok: false, reason: 'unset' })),
    createShipGraph: vi.fn(),
    createShipTemplate: vi.fn(),
    onShipConfigChanged: vi.fn(() => () => {})
  },
  boardLog: { onChanged: vi.fn(() => () => {}) }
}

let AgentGraphView: typeof import('./AgentGraphView').AgentGraphView
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
  ;({ useAgentGraphDisplay } = await import('../../state/agentGraphDisplay'))
})

let root: Root
let host: HTMLDivElement
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  vi.restoreAllMocks()
})

const node = (id: string, title: string) => ({ id, type: 'terminal', position: { x: 0, y: 0 }, data: { title, agentId: 'claude' } }) as never
const noEdges: Edge[] = []

describe('a 3D chunk that does not load', () => {
  it('hands back to 2D with the notice that says it could not be loaded', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ getExtension: () => ({ loseContext: () => {} }) })) as never)
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const swallow = (e: ErrorEvent) => e.preventDefault()
    window.addEventListener('error', swallow)
    useAgentGraphDisplay.setState({ dimension: '3d' })
    try {
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      await act(async () =>
        root.render(<AgentGraphView projectId="P" nodes={[node('a', 'Orchestrator')]} linkEdges={noEdges} controlEdges={noEdges} onShowOnCanvas={() => {}} onModalNodeChange={() => {}} onMapThisRepo={() => null} />)
      )
      for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    } finally {
      window.removeEventListener('error', swallow)
      quiet.mockRestore()
    }
    expect(document.querySelector('.react-flow')).not.toBeNull()
    const notice = document.querySelector('.agent-graph__notices')?.textContent ?? ''
    expect(notice).toContain('The 3D view could not be loaded. Showing the 2D view.')
    expect(notice).not.toContain('stopped with an error')
  })
})
