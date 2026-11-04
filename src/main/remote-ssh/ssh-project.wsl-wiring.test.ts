// `initSshProject` is where the WSL gate, the service and the IPC channels are joined. Runs the real
// function with Electron mocked. Only paths that are refused before anything starts are driven here,
// so wsl.exe is never spawned.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>())

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/nodeterm-test', on: () => undefined },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: () => undefined
  }
}))

import { initSshProject, type SshProjectManager } from './ssh-project'
import { IPC } from '../../shared/ipc'
import { setWslEndpoints, wslEndpoints } from '../../core/remote-ssh/native/wsl-endpoint'
import { WSL_HOST_SUFFIX } from '../../shared/wsl-project'

const invoke = (ch: string, ...args: unknown[]): unknown => (handlers.get(ch) as (...a: unknown[]) => unknown)({}, ...args)
const conn = { host: `ubuntu-0123456789abcdef${WSL_HOST_SUFFIX}`, user: 'dev', port: 22 }

describe('initSshProject wiring', () => {
  let mgr: SshProjectManager

  beforeEach(() => {
    handlers.clear()
    vi.stubEnv('NODETERM_NATIVE_SSH', '1')
    vi.stubEnv('NODETERM_WSL_PROJECTS', '1')
    mgr = initSshProject(undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => true)
  })

  afterEach(() => {
    mgr.stopWatchdog()
    setWslEndpoints(null)
    vi.unstubAllEnvs()
  })

  it('installs the service the transport reads, and every WSL channel', () => {
    expect(wslEndpoints()).not.toBeNull()
    for (const ch of [IPC.wslProjectList, IPC.wslProjectPrepare, IPC.wslProjectBind, IPC.wslProjectUnbind]) {
      expect(handlers.has(ch), ch).toBe(true)
    }
  })

  it('the connect channel runs the gate: a WSL host nobody set up is refused', async () => {
    await expect(invoke(IPC.sshConnectProject, 'project-x', conn)).rejects.toThrow(/not set up for this project/)
  })

  it('prepare refuses a connection that is not a browse, before listing anything', async () => {
    await expect(invoke(IPC.wslProjectPrepare, 'Ubuntu', 'project-x')).resolves.toMatchObject({ ok: false, code: 'invalid-distro' })
  })

  it('bind and unbind refuse a name that is not an endpoint', async () => {
    await expect(invoke(IPC.wslProjectBind, 'p1', conn.host)).resolves.toBe(false)
    await expect(invoke(IPC.wslProjectBind, 'p1', 'h.example.com')).resolves.toBe(false)
    await expect(invoke(IPC.wslProjectUnbind, 'p1', 'h.example.com')).resolves.toBe(false)
  })
})
