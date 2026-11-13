import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory storage, so the picture choice can be shown to survive a fresh store.
const memory = vi.hoisted(() => new Map<string, string>())
vi.mock('../lib/localStore', () => ({
  readLocal: (key: string, whenUnreadable: string | null = null) => (memory.has(key) ? memory.get(key)! : whenUnreadable),
  writeLocal: (key: string, value: string) => void memory.set(key, value)
}))
import { useAgentGraphDisplay } from './agentGraphDisplay'
import {
  GRAPH_PICTURE_KEY,
  graphPictureFor,
  parseGraphPictureMap,
  isBoardView,
  isGraphView,
  isKanbanOpen,
  openIssueOnBoard,
  parseViewMap,
  showCanvas,
  toggleBoardView,
  toggleGraphView,
  useViewMode,
  viewFor
} from './viewMode'

beforeEach(() => {
  useViewMode.setState({ viewByProject: {}, defaultView: 'canvas', globalKanban: false })
})

const view = (id: string) => viewFor(useViewMode.getState(), id)

describe('parseViewMap', () => {
  it('keeps graph beside canvas and kanban, and drops anything else', () => {
    expect(parseViewMap(JSON.stringify({ a: 'graph', b: 'kanban', c: 'canvas', d: 'nonsense', e: 3 }))).toEqual({ a: 'graph', b: 'kanban', c: 'canvas' })
  })
})

describe('the graph control', () => {
  it('goes in from the canvas or the board, and back to the canvas', () => {
    toggleGraphView('p')
    expect(view('p')).toBe('graph')
    toggleGraphView('p')
    expect(view('p')).toBe('canvas')

    useViewMode.getState().setView('p', 'kanban')
    toggleGraphView('p')
    expect(view('p')).toBe('graph')
  })

  it('has nothing to do with no project', () => {
    expect(toggleGraphView('')).toBe(false)
  })

  it('leaving Omni for the graph drops the Omni scope', () => {
    useViewMode.setState({ globalKanban: true })
    toggleGraphView('p')
    expect(useViewMode.getState().globalKanban).toBe(false)
    expect(view('p')).toBe('graph')
  })
})

describe('the board toggle stays canvas and board', () => {
  it('toggle flips the pair, and from the graph it opens the board', () => {
    useViewMode.getState().toggle('p')
    expect(view('p')).toBe('kanban')
    useViewMode.getState().toggle('p')
    expect(view('p')).toBe('canvas')
    useViewMode.getState().setView('p', 'graph')
    useViewMode.getState().toggle('p')
    expect(view('p')).toBe('kanban')
  })

  it('the shortcut from the graph opens the board, it does not read the graph as a board', () => {
    useViewMode.getState().setView('p', 'graph')
    toggleBoardView('p')
    expect(useViewMode.getState().globalKanban).toBe(true)
    toggleBoardView('p')
    expect(useViewMode.getState().globalKanban).toBe(false)
    expect(view('p')).toBe('canvas')
  })
})

describe('a GitHub issue chip clicked over the graph', () => {
  it('brings up the board that can show it, with the request standing', () => {
    useViewMode.getState().setView('p', 'graph')
    const ref = { repo: 'o/r', number: 7 } as never
    openIssueOnBoard('p', ref, true, () => {})
    expect(view('p')).toBe('kanban')
    expect(useViewMode.getState().requestedIssue).toBe(ref)
  })
})

describe('what covers the canvas', () => {
  it('the graph covers it like the board does, and only the board is a board', () => {
    useViewMode.getState().setView('p', 'graph')
    expect(isKanbanOpen('p')).toBe(true)
    expect(isGraphView('p')).toBe(true)
    expect(isBoardView('p')).toBe(false)

    useViewMode.getState().setView('p', 'kanban')
    expect(isKanbanOpen('p')).toBe(true)
    expect(isGraphView('p')).toBe(false)
    expect(isBoardView('p')).toBe(true)

    showCanvas('p')
    expect(isKanbanOpen('p')).toBe(false)
    expect(isKanbanOpen('')).toBe(false)
  })
})

describe('the graph picture per project', () => {
  beforeEach(() => {
    memory.clear()
    useViewMode.setState({ graphPictureByProject: {}, requestedCardNodeId: null, requestedIssue: null })
  })
  const picture = (id: string) => graphPictureFor(useViewMode.getState(), id)

  it('parse keeps only agents / system-map, and drops bad JSON whole', () => {
    expect(parseGraphPictureMap(JSON.stringify({ a: 'agents', b: 'system-map', c: 'graph', d: 3, e: null }))).toEqual({ a: 'agents', b: 'system-map' })
    expect(parseGraphPictureMap('{nope')).toEqual({})
    expect(parseGraphPictureMap(null)).toEqual({})
    expect(parseGraphPictureMap('[]')).toEqual({})
    expect(parseGraphPictureMap('"system-map"')).toEqual({})
    expect(parseGraphPictureMap('null')).toEqual({})
  })

  it('a project with no entry shows the agent graph', () => {
    expect(picture('p')).toBe('agents')
  })

  it('persists per project and survives a reload of the store', async () => {
    useViewMode.getState().setGraphPicture('p', 'system-map')
    expect(picture('p')).toBe('system-map')
    expect(picture('q')).toBe('agents')
    expect(JSON.parse(memory.get(GRAPH_PICTURE_KEY)!)).toEqual({ p: 'system-map' })
    vi.resetModules()
    const fresh = await import('./viewMode')
    expect(fresh.graphPictureFor(fresh.useViewMode.getState(), 'p')).toBe('system-map')
    expect(fresh.graphPictureFor(fresh.useViewMode.getState(), 'q')).toBe('agents')
  })

  it('the same value returns the same state', () => {
    useViewMode.getState().setGraphPicture('p', 'system-map')
    const before = useViewMode.getState()
    useViewMode.getState().setGraphPicture('p', 'system-map')
    expect(useViewMode.getState()).toBe(before)
  })

  it('never clears a pending card or issue request', () => {
    useViewMode.getState().requestCard('n1')
    useViewMode.getState().requestIssue({ owner: 'o', repo: 'r', number: 1 } as never)
    useViewMode.getState().setGraphPicture('p', 'system-map')
    useViewMode.getState().setGraphPicture('p', 'agents')
    expect(useViewMode.getState().requestedCardNodeId).toBe('n1')
    expect(useViewMode.getState().requestedIssue).toEqual({ owner: 'o', repo: 'r', number: 1 })
  })

  it('is independent of the 2D/3D dimension', () => {
    useAgentGraphDisplay.getState().setDimension('3d')
    useViewMode.getState().setGraphPicture('p', 'system-map')
    expect(useAgentGraphDisplay.getState().dimension).toBe('3d')
    useAgentGraphDisplay.getState().setDimension('2d')
    expect(picture('p')).toBe('system-map')
    useViewMode.getState().setGraphPicture('p', 'agents')
    expect(useAgentGraphDisplay.getState().dimension).toBe('2d')
  })
})
