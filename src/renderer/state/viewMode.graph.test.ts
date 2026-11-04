import { beforeEach, describe, expect, it } from 'vitest'
import {
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
