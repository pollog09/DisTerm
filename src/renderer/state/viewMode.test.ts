import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  parseViewMap,
  useViewMode,
  isKanbanOpen,
  isGlobalKanbanOpen,
  viewFor,
  openIssueOnBoard,
  showAllProjectsBoard,
  showProjectBoard,
  toggleAllProjectsBoard,
  toggleBoardView
} from './viewMode'

describe('parseViewMap', () => {
  it('keeps canvas/kanban entries, tolerates garbage', () => {
    expect(parseViewMap(null)).toEqual({})
    expect(parseViewMap('not json')).toEqual({})
    expect(parseViewMap('[1,2]')).toEqual({})
    expect(parseViewMap(JSON.stringify({ p1: 'kanban', p2: 'canvas', p3: 42 }))).toEqual({ p1: 'kanban', p2: 'canvas' })
  })
})

describe('toggle + default', () => {
  beforeEach(() => useViewMode.setState({ viewByProject: {}, defaultView: 'canvas' }))
  it('flips a project explicitly (stores canvas/kanban, overriding the default)', () => {
    useViewMode.getState().toggle('p1')
    expect(useViewMode.getState().viewByProject.p1).toBe('kanban')
    useViewMode.getState().toggle('p1')
    expect(useViewMode.getState().viewByProject.p1).toBe('canvas') // explicit, not deleted
  })
  it('an unset project follows the default; toggling flips FROM the resolved default', () => {
    const s = useViewMode.getState()
    expect(viewFor(s, 'x')).toBe('canvas')
    expect(isKanbanOpen('x')).toBe(false)
    useViewMode.setState({ defaultView: 'kanban' })
    expect(isKanbanOpen('x')).toBe(true) // now follows the kanban default
    // toggling an unset project flips off the resolved default → explicit 'canvas'
    useViewMode.getState().toggle('x')
    expect(useViewMode.getState().viewByProject.x).toBe('canvas')
    expect(isKanbanOpen('x')).toBe(false) // explicit choice beats the kanban default
  })
})

describe('card requests (board-aware "go to node")', () => {
  it('carries a one-shot request the board consumes', () => {
    useViewMode.setState({ requestedCardNodeId: null })
    useViewMode.getState().requestCard('term-1')
    expect(useViewMode.getState().requestedCardNodeId).toBe('term-1')
    useViewMode.getState().clearCardRequest()
    expect(useViewMode.getState().requestedCardNodeId).toBeNull()
    // Re-requesting the SAME node must work — it is a fresh "go to", not a state to dedupe.
    useViewMode.getState().requestCard('term-1')
    expect(useViewMode.getState().requestedCardNodeId).toBe('term-1')
  })

  it('a view toggle drops an unconsumed request', () => {
    useViewMode.setState({ viewByProject: {}, defaultView: 'canvas', requestedCardNodeId: null })
    useViewMode.getState().toggle('p9')
    expect(isKanbanOpen('p9')).toBe(true)
    useViewMode.getState().requestCard('term-2')
    // Leaving the board: the request belonged to the view we just left; firing it later would
    // pop a card open out of nowhere.
    useViewMode.getState().toggle('p9')
    expect(isKanbanOpen('p9')).toBe(false)
    expect(useViewMode.getState().requestedCardNodeId).toBeNull()
  })
})

describe('openIssueOnBoard (a node\'s #N chip)', () => {
  const ref = { owner: 'o', repo: 'r', number: 5 }
  beforeEach(() =>
    useViewMode.setState({ viewByProject: {}, defaultView: 'canvas', globalKanban: false, requestedIssue: null, requestedCardNodeId: null })
  )

  it('leaves the all-projects board, which has no issue lane, for this project\'s board', () => {
    showAllProjectsBoard()
    openIssueOnBoard('p1', ref, true, vi.fn())
    expect(isGlobalKanbanOpen()).toBe(false)
    expect(isKanbanOpen('p1')).toBe(true)
    expect(useViewMode.getState().requestedIssue).toEqual(ref)
  })

  it('brings up a board that can show the issue, then asks it to open the issue', () => {
    const open = vi.fn()
    openIssueOnBoard('p1', ref, true, open)
    expect(isKanbanOpen('p1')).toBe(true)
    // Requested AFTER the toggle — a toggle drops any unconsumed request.
    expect(useViewMode.getState().requestedIssue).toEqual(ref)
    expect(open).not.toHaveBeenCalled()
  })

  it('does NOT flip the saved view of a board that cannot show issues — it opens GitHub instead', () => {
    const open = vi.fn()
    openIssueOnBoard('p1', ref, false, open)
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/issues/5')
    expect(useViewMode.getState().viewByProject.p1).toBeUndefined()
    expect(useViewMode.getState().requestedIssue).toBeNull()
  })

  it('opens nothing for a reference that is not valid', () => {
    const open = vi.fn()
    openIssueOnBoard('p1', { owner: 'o', repo: 'r;x', number: 5 }, false, open)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('Omni is a scope of the kanban side, not a third view', () => {
  beforeEach(() => {
    useViewMode.setState({ viewByProject: {}, defaultView: 'canvas', globalKanban: false })
  })
  const where = (projectId: string): 'canvas' | 'board' | 'omni' =>
    isGlobalKanbanOpen() ? 'omni' : isKanbanOpen(projectId) ? 'board' : 'canvas'

  it('the view toggle goes canvas → all projects → canvas', () => {
    toggleBoardView('p1')
    expect(where('p1')).toBe('omni')
    toggleBoardView('p1')
    expect(where('p1')).toBe('canvas')
  })

  it('the view toggle leaves this project\'s own board for the canvas', () => {
    showProjectBoard('p1')
    toggleBoardView('p1')
    expect(where('p1')).toBe('canvas')
  })

  it('the view toggle from Omni lands on the CANVAS even when the project view was its board', () => {
    useViewMode.getState().setView('p1', 'kanban')
    showAllProjectsBoard()
    expect(where('p1')).toBe('omni')
    toggleBoardView('p1')
    expect(where('p1')).toBe('canvas')
  })

  it('leaving Omni through the scope switch lands on THIS project board, even from a canvas start', () => {
    toggleBoardView('p1') // canvas → Omni
    showProjectBoard('p1')
    expect(where('p1')).toBe('board')
  })

  it('the dedicated command flips between the two scopes, never to the canvas', () => {
    toggleAllProjectsBoard('p1')
    expect(where('p1')).toBe('omni')
    toggleAllProjectsBoard('p1')
    expect(where('p1')).toBe('board')
    toggleAllProjectsBoard('p1')
    expect(where('p1')).toBe('omni')
  })

  it('a project switch while Omni is up keeps Omni (the scope is not per project)', () => {
    showAllProjectsBoard()
    expect(where('p2')).toBe('omni') // p2's own view is the canvas
  })

})
