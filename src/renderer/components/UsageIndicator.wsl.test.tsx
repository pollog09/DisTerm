// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UsageIndicator } from './UsageIndicator'
import { useSettings } from '../state/settings'
import { useProjects } from '../state/projects'
import { DEFAULT_SETTINGS, type ClaudeUsage, type RemoteAccountUsage } from '@shared/types'

let root: Root
let host: HTMLDivElement
const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const limit = { kind: 'weekly_all', group: 'weekly', usedPercent: 1, severity: null, resetsAt: null, windowMinutes: null, scopeLabel: null, isActive: false }
const snapshot = (over: Partial<ClaudeUsage>): ClaudeUsage => ({ limits: [], session: null, weekly: null, email: null, updatedAt: 1, status: 'unavailable', ...over })
const row = (usage: ClaudeUsage): RemoteAccountUsage => ({ hostKey: 'wsl:Ubuntu', accountId: null, label: 'WSL: Ubuntu', usage })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useSettings.setState({ hydrated: true, settings: { ...DEFAULT_SETTINGS, usagePercentMode: 'remaining' } })
  useProjects.setState({ projects: [{ id: 'p', name: 'p', nodes: [], cwd: UNC }] as never, activeProjectId: 'p' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useSettings.setState({ settings: DEFAULT_SETTINGS })
  useProjects.setState({ projects: [], activeProjectId: '' })
  vi.unstubAllGlobals()
})

async function render(remote: (q?: { hostKey?: string }) => Promise<RemoteAccountUsage[]>, local: ClaudeUsage | null = null): Promise<void> {
  Object.assign(window, {
    nodeTerminal: {
      usage: { remote, providers: async () => [], fetch: async () => local, onUpdate: () => () => {} },
      settings: { save: async () => {} }
    }
  })
  await act(async () => root.render(<UsageIndicator />))
}

it('shows the distribution’s numbers over an expired Windows login', async () => {
  const remote = vi.fn(async () => [row(snapshot({ status: 'ok', limits: [limit] }))])
  await render(remote, snapshot({ loginExpired: true }))
  expect(remote).toHaveBeenCalledWith({ hostKey: 'wsl:Ubuntu' })
  expect(host.querySelector('.usage-pill')?.textContent).toContain('99%')
  expect(host.querySelector('.usage-pill')?.getAttribute('title')).toBe('Agent usage in WSL: Ubuntu')
})

it('does not call a distribution SSH, or offer an account action on its row', async () => {
  await render(async () => [row(snapshot({ status: 'ok', limits: [limit] }))])
  await act(async () => (host.querySelector('.usage-pill') as HTMLButtonElement).click())
  expect(host.textContent).toContain('WSL: Ubuntu')
  expect(host.textContent).not.toContain('SSH')
  expect(host.textContent).not.toContain('new sessions')
})

it('says the login expired instead of disappearing, and names where', async () => {
  await render(async () => [row(snapshot({ loginExpired: true }))])
  const pill = host.querySelector('.usage-pill')!
  expect(pill.textContent).toContain('Login expired')
  expect(pill.getAttribute('title')).toContain('in WSL: Ubuntu')
  await act(async () => (pill as HTMLButtonElement).click())
  expect(host.textContent).toContain('The Claude login in WSL: Ubuntu has expired')
})

it('says so for this machine too, on a Windows project', async () => {
  useProjects.setState({ projects: [{ id: 'p', name: 'p', nodes: [], cwd: 'C:\\repo' }] as never })
  const remote = vi.fn(async () => [])
  await render(remote, snapshot({ loginExpired: true }))
  expect(remote).not.toHaveBeenCalled()
  const pill = host.querySelector('.usage-pill')!
  expect(pill.textContent).toContain('Login expired')
  expect(pill.getAttribute('title')).toContain('on this computer')
})

it('still hides for a login that is simply not there', async () => {
  await render(async () => [row(snapshot({}))])
  expect(host.querySelector('.usage-pill')).toBeNull()
})

it('notices a distribution that came up since, when the window takes focus', async () => {
  const remote = vi.fn(async (): Promise<RemoteAccountUsage[]> => [])
  await render(remote)
  expect(host.querySelector('.usage-pill')).toBeNull()
  remote.mockResolvedValue([row(snapshot({ status: 'ok', limits: [limit] }))])
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(host.querySelector('.usage-pill')?.textContent).toContain('99%')
})

it('retries while a booting distribution has given no row, then stops', async () => {
  vi.useFakeTimers()
  try {
    const remote = vi.fn(async (): Promise<RemoteAccountUsage[]> => [])
    await render(remote)
    const first = remote.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(remote.mock.calls.length).toBe(first + 1)
    remote.mockResolvedValue([row(snapshot({ status: 'ok', limits: [limit] }))])
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(host.querySelector('.usage-pill')?.textContent).toContain('99%')
    const settled = remote.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(remote.mock.calls.length).toBe(settled)
  } finally {
    vi.useRealTimers()
  }
})

it('gives up retrying after two minutes', async () => {
  vi.useFakeTimers()
  try {
    const remote = vi.fn(async (): Promise<RemoteAccountUsage[]> => [])
    await render(remote)
    await act(async () => { await vi.advanceTimersByTimeAsync(121_000) })
    const settled = remote.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(remote.mock.calls.length).toBe(settled)
  } finally {
    vi.useRealTimers()
  }
})

it('answers to the Claude switch, not the one labelled SSH hosts', async () => {
  const ok = async () => [row(snapshot({ status: 'ok', limits: [limit] }))]
  useSettings.setState({ settings: { ...useSettings.getState().settings, hiddenUsageProviders: ['claude-remote'] } })
  await render(ok)
  expect(host.querySelector('.usage-pill')?.textContent).toContain('99%')
  await act(async () => useSettings.setState({ settings: { ...useSettings.getState().settings, hiddenUsageProviders: ['claude'] } }))
  expect(host.querySelector('.usage-pill')).toBeNull()
})
