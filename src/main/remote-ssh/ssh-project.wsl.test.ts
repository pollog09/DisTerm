// A WSL host through SshProjectManager: refused before anything starts unless the endpoint says this
// project may connect, and warnings come out as their own status update.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/nodeterm-test' },
  ipcMain: { handle: () => undefined, on: () => undefined }
}))

import { SshProjectManager } from './ssh-project'
import { controlPathFor } from '../../core/remote-ssh/control-master'
import { WSL_HOST_SUFFIX, type WslWarning } from '../../shared/wsl-project'
import type { SshProjectStatusEvent } from '../../shared/types'

const conn = { host: `ubuntu-0123456789abcdef${WSL_HOST_SUFFIX}`, user: 'dev', port: 22 }
const plain = { host: 'h.example.com', user: 'dev', port: 22 }

function manager(over: Record<string, unknown> = {}) {
  const events: SshProjectStatusEvent[] = []
  const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn() }))
  const run = vi.fn(async () => ({ code: 0, stdout: '' }))
  const mgr = new SshProjectManager({
    userDataDir: '/ud',
    spawnMaster,
    run,
    runScp: vi.fn(async () => ({ code: 0 })),
    getHook: () => ({ port: 1, token: 't', version: '1' }),
    onStatus: (e: SshProjectStatusEvent) => events.push(e),
    ...over
  } as never)
  return { mgr, events, spawnMaster, run }
}

describe('SshProjectManager with a WSL host', () => {
  it('a refused project starts nothing and shows why', async () => {
    const authorizeEndpoint = vi.fn(async () => {
      throw new Error('This WSL connection was not set up for this project on this computer.')
    })
    const { mgr, events, spawnMaster, run } = manager({ authorizeEndpoint })
    await expect(mgr.connect('attached-p-abc', conn)).rejects.toThrow(/not set up for this project/)
    expect(spawnMaster).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(events).toEqual([
      { projectId: 'attached-p-abc', status: 'error', error: 'This WSL connection was not set up for this project on this computer.' }
    ])
  })

  it('a core without the gate refuses a WSL host rather than dialing it', async () => {
    const { mgr, spawnMaster } = manager()
    await expect(mgr.connect('p1', conn)).rejects.toThrow(/only available on Windows/)
    expect(spawnMaster).not.toHaveBeenCalled()
  })

  it('an authorized project connects on its own ControlPath', async () => {
    const authorizeEndpoint = vi.fn(async () => {})
    const { mgr, spawnMaster } = manager({ authorizeEndpoint })
    const { controlPath } = await mgr.connect('p1', conn)
    expect(authorizeEndpoint).toHaveBeenCalledWith('p1', conn, controlPathFor('p1'))
    expect(controlPath).toBe(controlPathFor('p1'))
    expect(spawnMaster).toHaveBeenCalledTimes(1)
  })

  it('names warnings in their own update, after connected', async () => {
    const warnings: WslWarning[] = [{ kind: 'tmux', message: 'tmux is not installed', install: 'sudo apt install tmux' }]
    const { mgr, events } = manager({ authorizeEndpoint: async () => {}, endpointWarnings: () => warnings })
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(events.some((e) => e.endpointWarnings)).toBe(true))
    const at = events.findIndex((e) => e.endpointWarnings)
    expect(events[at]).toEqual({ projectId: 'p1', status: 'connected', endpointWarnings: warnings })
    expect(events.findIndex((e) => e.status === 'connected' && !e.endpointWarnings)).toBeLessThan(at)
  })

  it('an empty update clears a warning the user has since fixed', async () => {
    const { mgr, events } = manager({ authorizeEndpoint: async () => {}, endpointWarnings: () => [] })
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(events.find((e) => e.endpointWarnings)?.endpointWarnings).toEqual([]))
  })

  it('reports the keepalive’s result without holding the connect, and a failure costs nothing', async () => {
    let release: () => void = () => {}
    const endpointConnected = vi.fn(() => new Promise<void>((_r, rej) => (release = () => rej(new Error('boom')))))
    const { mgr, events } = manager({ authorizeEndpoint: async () => {}, endpointConnected, endpointWarnings: () => [] })
    await expect(mgr.connect('p1', conn)).resolves.toMatchObject({ controlPath: controlPathFor('p1') })
    expect(endpointConnected).toHaveBeenCalledWith('p1', conn)
    expect(events.some((e) => e.endpointWarnings)).toBe(false)
    release()
    await vi.waitFor(() => expect(events.some((e) => e.endpointWarnings)).toBe(true))
  })

  it('the watchdog’s reconnect goes through the gate again, and an ordinary pass reuses a live master', async () => {
    const authorizeEndpoint = vi.fn(async () => {})
    const { mgr, spawnMaster } = manager({ authorizeEndpoint })
    await mgr.connect('p1', conn)
    await mgr.revalidateAll()
    expect(spawnMaster).toHaveBeenCalledTimes(1)
    expect(authorizeEndpoint).toHaveBeenCalledTimes(2)
  })

  it('after a disconnect the watchdog has nothing to revive, so a stopped distro stays stopped', async () => {
    const endpointDisconnected = vi.fn()
    const { mgr, spawnMaster } = manager({ authorizeEndpoint: async () => {}, endpointDisconnected })
    await mgr.connect('p1', conn)
    await mgr.disconnect('p1', { final: true })
    expect(endpointDisconnected).toHaveBeenCalledWith('p1', conn)
    spawnMaster.mockClear()
    await mgr.revalidateAll()
    expect(spawnMaster).not.toHaveBeenCalled()
  })

  it('leaves an ordinary SSH project alone: no gate, no warning update', async () => {
    const authorizeEndpoint = vi.fn(async () => {})
    const endpointConnected = vi.fn(async () => {})
    const { mgr, events } = manager({ authorizeEndpoint, endpointConnected, endpointWarnings: () => [] })
    await mgr.connect('p1', plain)
    await new Promise((r) => setTimeout(r, 10))
    expect(endpointConnected).not.toHaveBeenCalled()
    expect(authorizeEndpoint).not.toHaveBeenCalled()
    expect(events.some((e) => e.endpointWarnings)).toBe(false)
  })
})
