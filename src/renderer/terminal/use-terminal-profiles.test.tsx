// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalProfile } from '@shared/terminal-profiles'
import { SessionContext } from '../session/session'
import { nextProfiles, PROFILE_REFRESH_GAP_MS, useTerminalProfiles } from './use-terminal-profiles'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WINDOWS: TerminalProfile = { value: 'pwsh', label: 'PowerShell 7', kind: 'windows' }
const UBUNTU: TerminalProfile = { value: 'wsl:Ubuntu', label: 'WSL: Ubuntu', kind: 'wsl' }
const DEBIAN: TerminalProfile = { value: 'wsl:Debian', label: 'WSL: Debian', kind: 'wsl' }

describe('nextProfiles', () => {
  it('takes a first read and a changed list', () => {
    expect(nextProfiles([], [WINDOWS, UBUNTU])).toEqual([WINDOWS, UBUNTU])
    expect(nextProfiles([WINDOWS, UBUNTU], [WINDOWS, DEBIAN])).toEqual([WINDOWS, DEBIAN])
  })

  it('does not let a read with no distributions erase a list that had them', () => {
    const current = [WINDOWS, UBUNTU]
    expect(nextProfiles(current, [WINDOWS])).toBe(current)
    expect(nextProfiles(current, [])).toBe(current)
  })

  it('keeps the same array for an unchanged answer', () => {
    const current = [WINDOWS, UBUNTU]
    expect(nextProfiles(current, [WINDOWS, UBUNTU])).toBe(current)
  })
})

describe('useTerminalProfiles', () => {
  const list = vi.fn<() => Promise<TerminalProfile[]>>()
  let seen: TerminalProfile[] = []
  let unmount: () => void = () => {}

  function Probe({ enabled }: { enabled: boolean }): null {
    seen = useTerminalProfiles(enabled)
    return null
  }

  async function mount(enabled: boolean): Promise<void> {
    const root = createRoot(document.createElement('div'))
    const session = { api: { pty: { terminalProfiles: list } } } as never
    await act(async () => {
      root.render(
        <SessionContext.Provider value={session}>
          <Probe enabled={enabled} />
        </SessionContext.Provider>
      )
    })
    unmount = () => act(() => root.unmount())
  }

  const focus = (): Promise<void> =>
    act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    list.mockReset()
    seen = []
  })
  afterEach(() => {
    unmount()
    vi.useRealTimers()
  })

  it('never runs wsl.exe when disabled, even on focus', async () => {
    await mount(false)
    await focus()
    expect(list).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })

  it('picks up distributions after a slow first read, once the gap has passed', async () => {
    list.mockResolvedValueOnce([WINDOWS]).mockResolvedValueOnce([WINDOWS, UBUNTU])
    await mount(true)
    expect(seen).toEqual([WINDOWS])
    await focus()
    expect(list).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + PROFILE_REFRESH_GAP_MS)
    await focus()
    expect(list).toHaveBeenCalledTimes(2)
    expect(seen).toEqual([WINDOWS, UBUNTU])
  })

  it('keeps the list when a later read rejects', async () => {
    list.mockResolvedValueOnce([WINDOWS, UBUNTU]).mockRejectedValueOnce(new Error('timeout'))
    await mount(true)
    vi.setSystemTime(Date.now() + PROFILE_REFRESH_GAP_MS)
    await focus()
    expect(seen).toEqual([WINDOWS, UBUNTU])
  })
})
