// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canvasCoveredByView,
  canvasImagePasteArmedAfterKey,
  canvasImportRefusal,
  droppedDirectories,
  guardedCanvasImagePlacements,
  isCanvasImageDropTarget,
  isFolderDropTarget
} from './canvas-image-import'

describe('canvasImportRefusal', () => {
  it('refuses a relay tab, whose write and read land on different machines', () => {
    // The write is the LOCAL preload's, the node reads through the peer's core — so the node could
    // never render its own file. A message beats a broken node.
    expect(canvasImportRefusal(true)).toMatch(/remote tab/i)
    expect(canvasImportRefusal(false)).toBe(null)
  })
})

describe('isCanvasImageDropTarget', () => {
  it('accepts the real pane and rejects flow-wrap overlays and nodes', () => {
    const wrap = document.createElement('div')
    wrap.innerHTML = `
      <div class="react-flow__pane"><div class="react-flow__node"><span>node</span></div></div>
      <div class="welcome"><button>open</button></div>
      <div class="usage-indicator"><div class="usage-popover">usage</div></div>
    `
    const pane = wrap.querySelector('.react-flow__pane')!
    expect(isCanvasImageDropTarget(pane, wrap)).toBe(true)
    expect(isCanvasImageDropTarget(wrap.querySelector('.react-flow__node span'), wrap)).toBe(false)
    expect(isCanvasImageDropTarget(wrap.querySelector('.welcome'), wrap)).toBe(false)
    expect(isCanvasImageDropTarget(wrap.querySelector('.usage-popover'), wrap)).toBe(false)
  })

  it('rejects dialogs and sidebars outside the canvas wrapper', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div class="flow-wrap"><div class="react-flow__pane"></div></div>
      <div role="dialog">settings</div>
      <aside class="sessions-sidebar">sessions</aside>
    `
    const wrap = root.querySelector('.flow-wrap')!
    expect(isCanvasImageDropTarget(root.querySelector('[role="dialog"]'), wrap)).toBe(false)
    expect(isCanvasImageDropTarget(root.querySelector('.sessions-sidebar'), wrap)).toBe(false)
  })
})

describe('isFolderDropTarget', () => {
  it('accepts the canvas pane, the Welcome screen, and general app chrome', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div class="react-flow__pane"><span>pane</span></div>
      <div class="welcome"><span>welcome</span></div>
      <aside class="sessions-sidebar"><span>sidebar</span></aside>
    `
    expect(isFolderDropTarget(root.querySelector('.react-flow__pane span'))).toBe(true)
    expect(isFolderDropTarget(root.querySelector('.welcome span'))).toBe(true)
    expect(isFolderDropTarget(root.querySelector('.sessions-sidebar span'))).toBe(true)
  })

  it('accepts a Welcome-screen nav card even though it is a <button>', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div class="welcome__cards">
        <button class="welcome__card"><span class="welcome__card-title">Open folder…</span></button>
      </div>
    `
    expect(isFolderDropTarget(root.querySelector('.welcome__card'))).toBe(true)
    expect(isFolderDropTarget(root.querySelector('.welcome__card-title'))).toBe(true)
  })

  it('rejects terminals, editors, dialogs, form controls, and node bodies', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div class="xterm"><span>term</span></div>
      <div class="monaco-editor"><span>editor</span></div>
      <div role="dialog"><span>dialog</span></div>
      <input />
      <textarea></textarea>
      <button>btn</button>
      <div contenteditable="true"><span>editable</span></div>
      <div class="react-flow__node"><span>node body</span></div>
    `
    expect(isFolderDropTarget(root.querySelector('.xterm span'))).toBe(false)
    expect(isFolderDropTarget(root.querySelector('.monaco-editor span'))).toBe(false)
    expect(isFolderDropTarget(root.querySelector('[role="dialog"] span'))).toBe(false)
    expect(isFolderDropTarget(root.querySelector('input'))).toBe(false)
    expect(isFolderDropTarget(root.querySelector('textarea'))).toBe(false)
    expect(isFolderDropTarget(root.querySelector('button'))).toBe(false)
    expect(isFolderDropTarget(root.querySelector('[contenteditable] span'))).toBe(false)
    expect(isFolderDropTarget(root.querySelector('.react-flow__node span'))).toBe(false)
  })

  it('rejects a null target', () => {
    expect(isFolderDropTarget(null)).toBe(false)
  })
})

describe('droppedDirectories', () => {
  const fakeItem = (opts: { isDirectory: boolean; file: File | null }): DataTransferItem =>
    ({
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: opts.isDirectory }),
      getAsFile: () => opts.file
    }) as unknown as DataTransferItem

  it('returns only directory entries, in order', () => {
    const dirA = new File([], 'project-a')
    const fileB = new File(['x'], 'notes.txt')
    const dirC = new File([], 'project-c')
    const dt = {
      items: [
        fakeItem({ isDirectory: true, file: dirA }),
        fakeItem({ isDirectory: false, file: fileB }),
        fakeItem({ isDirectory: true, file: dirC })
      ]
    } as unknown as DataTransfer
    expect(droppedDirectories(dt)).toEqual([dirA, dirC])
  })

  it('tolerates a directory entry whose getAsFile() returns null', () => {
    const dt = {
      items: [fakeItem({ isDirectory: true, file: null })]
    } as unknown as DataTransfer
    expect(droppedDirectories(dt)).toEqual([])
  })

  it('returns an empty array for a null DataTransfer or no items', () => {
    expect(droppedDirectories(null)).toEqual([])
    expect(droppedDirectories({ items: [] } as unknown as DataTransfer)).toEqual([])
  })

  it('ignores non-file items (e.g. a text/plain drag)', () => {
    const dt = {
      items: [{ kind: 'string', webkitGetAsEntry: () => null, getAsFile: () => null }]
    } as unknown as DataTransfer
    expect(droppedDirectories(dt)).toEqual([])
  })
})

describe('guardedCanvasImagePlacements', () => {
  it('places every resolved path while the originating project remains active', async () => {
    await expect(
      guardedCanvasImagePlacements(
        async () => ['/tmp/a.png', '/tmp/b.png'],
        'project-a',
        () => 'project-a',
        { x: 10, y: 20 }
      )
    ).resolves.toEqual([
      { filePath: '/tmp/a.png', center: { x: 10, y: 20 } },
      { filePath: '/tmp/b.png', center: { x: 46, y: 56 } }
    ])
  })

  it('abandons an async result after a project switch', async () => {
    let release!: (paths: string[]) => void
    const pending = new Promise<string[]>((resolve) => (release = resolve))
    let active = 'project-a'
    const placements = guardedCanvasImagePlacements(
      () => pending,
      'project-a',
      () => active,
      { x: 10, y: 20 }
    )
    active = 'project-b'
    release(['/tmp/a.png'])
    await expect(placements).resolves.toEqual([])
  })
})

describe('canvasImagePasteArmedAfterKey', () => {
  it('preserves a real Cmd+V sequence but revokes arming for a keyboard-opened overlay', () => {
    const meta = { key: 'Meta', metaKey: true, ctrlKey: false }
    const paste = { key: 'v', metaKey: true, ctrlKey: false }
    const openSettings = { key: ',', metaKey: true, ctrlKey: false }

    expect(canvasImagePasteArmedAfterKey(true, meta)).toBe(true)
    expect(canvasImagePasteArmedAfterKey(true, paste)).toBe(true)
    expect(canvasImagePasteArmedAfterKey(true, openSettings)).toBe(false)
    expect(canvasImagePasteArmedAfterKey(false, paste)).toBe(false)
  })
})

describe('canvasCoveredByView', () => {
  it('neither full-page view lets a paste through to the canvas', () => {
    expect(canvasCoveredByView(false, false)).toBe(false)
    expect(canvasCoveredByView(true, false)).toBe(true)
    expect(canvasCoveredByView(false, true)).toBe(true)
  })

  it('Canvas asks it with both flags. Canvas has no render harness, so this one reads the call site', () => {
    const src = readFileSync(join(__dirname, 'Canvas.tsx'), 'utf8')
    const guard = src.split('\n').find((l) => l.includes('canvasImagePasteArmedRef.current ||'))!
    expect(guard).toContain('canvasCoveredByView(kanbanOpen, graphOpen)')
  })
})
