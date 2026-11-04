// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellSection } from './ShellSection'

const state = vi.hoisted(() => ({ defaultShell: '', update: vi.fn() }))

vi.mock('../../../state/settings', () => ({
  useSettings: (selector: (s: unknown) => unknown) =>
    selector({ settings: { defaultShell: state.defaultShell }, update: state.update })
}))
vi.mock('../../../terminal/use-core-platform', () => ({ useCoreIsWindows: () => true }))
vi.mock('../../../terminal/use-terminal-profiles', () => ({
  useTerminalProfiles: () => [
    { value: '', label: 'System default', kind: 'default' },
    { value: 'wsl:Ubuntu', label: 'WSL: Ubuntu', kind: 'wsl' }
  ]
}))
vi.mock('../SettingsSection', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('../SearchableRow', () => ({
  SearchableRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('../FieldRow', () => ({
  FieldRow: ({ control }: { control: React.ReactNode }) => <div>{control}</div>
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ShellSection on a Windows core', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    state.defaultShell = ''
    state.update.mockReset()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const show = (): void => act(() => root.render(<ShellSection isActive />))
  const textBox = (): HTMLInputElement | null => host.querySelector('input')
  const choose = (value: string): void => {
    const select = host.querySelector('select') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    act(() => {
      setter?.call(select, value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  it('stores the chosen distribution and hides the text box', () => {
    show()
    expect(textBox()).toBeNull()
    choose('wsl:Ubuntu')
    expect(state.update).toHaveBeenCalledWith({ defaultShell: 'wsl:Ubuntu' })
  })

  it('reveals the text box when Custom is chosen from a listed value', () => {
    show()
    choose('__custom__')
    expect(textBox()).not.toBeNull()
    expect(state.update).not.toHaveBeenCalled()
  })

  it('shows an unlisted saved shell in the text box', () => {
    state.defaultShell = 'C:\\tools\\nu.exe'
    show()
    expect(textBox()?.value).toBe('C:\\tools\\nu.exe')
  })
})
