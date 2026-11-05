// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjects } from '../state/projects'
import { useWslTerminals } from '../state/wslTerminals'
import { Dock } from './Dock'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const onAddWslTerminal = vi.fn()
const onAddWslClaude = vi.fn()
const noop = (): void => {}

function renderDockMenu(): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <Dock
        onUndo={noop}
        onRedo={noop}
        onGoBack={noop}
        onGoForward={noop}
        onSave={noop}
        onFitView={noop}
        onSaveLayout={noop}
        onRestoreLayout={noop}
        onUpdateLayout={noop}
        onRenameLayout={noop}
        onDeleteLayout={noop}
        onZoomIn={noop}
        onZoomOut={noop}
        onZoomTo={noop}
        onDictate={noop}
        dirty={false}
        zoomPct={100}
        canUndo={false}
        canRedo={false}
        canGoBack={false}
        canGoForward={false}
        dictateActive={false}
        onAddTerminal={noop}
        onAddWslTerminal={onAddWslTerminal}
        onAddWslClaude={onAddWslClaude}
        onAddAgent={noop}
        onAddRemote={noop}
        onConnectRemote={noop}
        onAddSticky={noop}
        onSpawnTeam={noop}
        onAddDino={noop}
        onAddWhiteboard={noop}
        onAddTrigger={noop}
        onAddFiles={noop}
        onAddRun={noop}
        onAddSimulator={noop}
        onOpenFile={noop}
        onAddBrowser={noop}
        onAddWeb={noop}
        onNewFile={noop}
        onAddWorktree={noop}
      />
    )
  })
  act(() => {
    container.querySelector<HTMLButtonElement>('button[aria-label="Add node"]')!.click()
  })
  return {
    container,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    }
  }
}

const rowLabels = (c: HTMLElement): string[] =>
  [...c.querySelectorAll('.dock-add-menu button')].map((b) => b.textContent ?? '')

describe('the Dock add menu', () => {
  beforeEach(() => {
    onAddWslTerminal.mockReset()
    onAddWslClaude.mockReset()
    useProjects.setState({ projects: [{ id: 'p', nodes: [] }] as never, activeProjectId: 'p' })
  })
  afterEach(() => useWslTerminals.getState().publish([]))

  it('offers each distribution beside Terminal, and starts the one picked', () => {
    useWslTerminals
      .getState()
      .publish([{ value: 'wsl:Ubuntu', label: 'WSL: Ubuntu', kind: 'wsl' }])
    const { container, unmount } = renderDockMenu()
    const labels = rowLabels(container)
    expect(labels.indexOf('WSL: Ubuntu')).toBe(labels.indexOf('Terminal') + 1)
    act(() => {
      ;[...container.querySelectorAll<HTMLButtonElement>('.dock-add-menu button')]
        .find((b) => b.textContent === 'WSL: Ubuntu')!
        .click()
    })
    expect(onAddWslTerminal).toHaveBeenCalledWith('wsl:Ubuntu')
    unmount()
  })

  it('offers a Claude in each distribution, and starts the one picked', () => {
    useWslTerminals
      .getState()
      .publish([{ value: 'wsl:Ubuntu', label: 'WSL: Ubuntu', kind: 'wsl' }])
    const { container, unmount } = renderDockMenu()
    act(() => {
      ;[...container.querySelectorAll<HTMLButtonElement>('.dock-add-menu button')]
        .find((b) => b.textContent === 'Claude: WSL: Ubuntu')!
        .click()
    })
    expect(onAddWslClaude).toHaveBeenCalledWith('wsl:Ubuntu')
    expect(onAddWslTerminal).not.toHaveBeenCalled()
    unmount()
  })

  it('shows no WSL row off Windows, where the list is empty', () => {
    const { container, unmount } = renderDockMenu()
    const labels = rowLabels(container)
    expect(labels).toContain('Terminal')
    expect(labels.some((l) => l.includes('WSL'))).toBe(false)
    unmount()
  })

  it('shows no WSL row in an SSH project', () => {
    useWslTerminals
      .getState()
      .publish([{ value: 'wsl:Ubuntu', label: 'WSL: Ubuntu', kind: 'wsl' }])
    useProjects.setState({
      projects: [{ id: 'p', nodes: [], ssh: { server: {}, remoteCwd: '/srv' } }] as never,
      activeProjectId: 'p'
    })
    const { container, unmount } = renderDockMenu()
    expect(rowLabels(container).some((l) => l.includes('WSL'))).toBe(false)
    unmount()
  })
})
