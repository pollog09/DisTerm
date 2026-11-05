// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyWindowTitle,
  composeWindowTitle,
  installActiveNodeTracker,
  nodeIdForFocusTarget,
  resetWindowBaseTitleForTest,
  windowBaseTitle
} from './windowTitle'

const BASE = 'DisTerm'

describe('composeWindowTitle', () => {
  it('disabled → the base title, whatever parts are around', () => {
    expect(
      composeWindowTitle({ enabled: false, baseTitle: BASE, nodeTitle: 'api', projectName: 'repo' })
    ).toBe(BASE)
  })

  it('node + project + base, em-dash separated', () => {
    expect(
      composeWindowTitle({ enabled: true, baseTitle: BASE, nodeTitle: 'api', projectName: 'repo' })
    ).toBe('api — repo — DisTerm')
  })

  it('no node → project + base; nothing at all → base alone', () => {
    expect(composeWindowTitle({ enabled: true, baseTitle: BASE, projectName: 'repo' })).toBe(
      'repo — DisTerm'
    )
    expect(composeWindowTitle({ enabled: true, baseTitle: BASE })).toBe(BASE)
  })

  it('whitespace-only parts drop out instead of leaving a dangling separator', () => {
    expect(
      composeWindowTitle({ enabled: true, baseTitle: BASE, nodeTitle: '  ', projectName: 'repo' })
    ).toBe('repo — DisTerm')
  })

  it('a node titled exactly like its project shows once, not twice', () => {
    expect(
      composeWindowTitle({ enabled: true, baseTitle: BASE, nodeTitle: 'repo', projectName: 'repo' })
    ).toBe('repo — DisTerm')
  })
})

describe('nodeIdForFocusTarget', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function nodeWithTextarea(id: string): HTMLTextAreaElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'react-flow__node'
    wrapper.setAttribute('data-id', id)
    const ta = document.createElement('textarea')
    wrapper.appendChild(ta)
    document.body.appendChild(wrapper)
    return ta
  }

  it('resolves the React Flow wrapper id for focus inside a node', () => {
    const ta = nodeWithTextarea('n1')
    expect(nodeIdForFocusTarget(ta)).toBe('n1')
  })

  it('answers null for focus outside every node, and for non-elements', () => {
    const stray = document.createElement('input')
    document.body.appendChild(stray)
    expect(nodeIdForFocusTarget(stray)).toBeNull()
    expect(nodeIdForFocusTarget(null)).toBeNull()
    expect(nodeIdForFocusTarget(window)).toBeNull()
  })

  it('tracker reports on focusin inside a node and stays quiet outside; teardown stops it', () => {
    const ta = nodeWithTextarea('n2')
    const stray = document.createElement('input')
    document.body.appendChild(stray)
    const report = vi.fn()
    const stop = installActiveNodeTracker({ report })
    ta.focus()
    expect(report).toHaveBeenCalledWith('n2')
    report.mockClear()
    stray.focus()
    expect(report).not.toHaveBeenCalled()
    stop()
    ta.focus()
    expect(report).not.toHaveBeenCalled()
  })
})

describe('base title capture + apply', () => {
  beforeEach(() => {
    resetWindowBaseTitleForTest()
    document.title = BASE
  })

  it('captures the boot title once, before any write, and restores through it', () => {
    expect(windowBaseTitle()).toBe(BASE)
    applyWindowTitle('api — repo — DisTerm')
    expect(document.title).toBe('api — repo — DisTerm')
    // The capture is not re-read after writes — restoring composes back to the boot title.
    applyWindowTitle(composeWindowTitle({ enabled: false, baseTitle: windowBaseTitle() }))
    expect(document.title).toBe(BASE)
  })
})
