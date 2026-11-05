// Which program a `wsl:<distro>` shell becomes. The launch plan itself is tested in
// terminal-profiles.test.ts; this covers the routing in PtyManager.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'

const backend = vi.hoisted(() => ({
  supported: vi.fn(() => true),
  create: vi.fn(),
  attachExisting: vi.fn(),
  hasSession: vi.fn(async () => false)
}))

vi.mock('./session-host-backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-host-backend')>()),
  sessionHostSupported: backend.supported,
  createSessionHostPty: backend.create,
  attachExistingSessionHostPty: backend.attachExisting,
  sessionHostHasSession: backend.hasSession,
  sessionHostListSessions: vi.fn(async () => [])
}))

const resolver = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('./terminal-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./terminal-profiles')>()),
  resolveWslLaunch: resolver.resolve
}))

const nodePty = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: nodePty.spawn }))

vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

function fakeHostPty() {
  return {
    ready: Promise.resolve({ fresh: true }),
    onSize: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAttachError: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    destroy: vi.fn()
  }
}

const PLAN = { file: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu', '--exec', 'sh'] }

describe('PtyManager WSL routing', () => {
  let host: FakePlatform
  let PtyManagerCtor: typeof import('./pty-manager').PtyManager
  let manager: import('./pty-manager').PtyManager | undefined
  let defaultShell = ''

  beforeAll(async () => {
    PtyManagerCtor = (await import('./pty-manager')).PtyManager
  }, 60_000)

  beforeEach(() => {
    defaultShell = ''
    nodePty.spawn.mockReset().mockImplementation(() => fakeHostPty())
    host = fakePlatform()
    initPlatform(host)
    backend.supported.mockReturnValue(true)
    backend.create.mockReset().mockImplementation(() => fakeHostPty())
    backend.attachExisting.mockReset().mockImplementation(() => ({
      ...fakeHostPty(),
      ready: Promise.resolve({ fresh: false })
    }))
    backend.hasSession.mockReset().mockResolvedValue(false)
    resolver.resolve.mockReset().mockResolvedValue(PLAN)
  })

  afterEach(() => {
    manager = undefined
    resetPlatformForTests()
  })

  function create(platform: NodeJS.Platform, options: Record<string, unknown>) {
    manager = new PtyManagerCtor({ runtimePlatform: platform })
    ;(manager as unknown as { getSettings: () => unknown }).getSettings = () => ({
      ...DEFAULT_SETTINGS,
      defaultShell
    })
    manager.registerIpc()
    return host.handlers[IPC.ptyCreate](7, { cols: 80, rows: 24, persistKey: 'node-wsl', ...options })
  }

  it('gives the session host the trusted plan, never the profile name', async () => {
    await create('win32', { shell: 'wsl:Ubuntu', cwd: 'C:\\project' })
    expect(resolver.resolve).toHaveBeenCalledWith('Ubuntu', 'C:\\project')
    const spawn = backend.create.mock.calls[0][1]
    expect(spawn.shell).toBe(PLAN.file)
    expect(spawn.args).toEqual(PLAN.args)
    expect(spawn.launchDialect).toBeUndefined()
    expect(spawn.cwd).not.toBe('C:\\project')
  })

  it('rejects with the real reason and starts nothing when resolution fails', async () => {
    resolver.resolve.mockRejectedValue(new Error('WSL could not open "Z:\\x" in Ubuntu: nope'))
    await expect(create('win32', { shell: 'wsl:Ubuntu', cwd: 'Z:\\x' })).rejects.toThrow(
      'WSL could not open'
    )
    expect(backend.create).not.toHaveBeenCalled()
  })

  it('refuses a WSL profile on a non-Windows core instead of running another shell', async () => {
    await expect(create('linux', { shell: 'wsl:Ubuntu' })).rejects.toThrow(
      'A new WSL terminal can only be started by the Windows app.'
    )
    expect(resolver.resolve).not.toHaveBeenCalled()
    expect(backend.create).not.toHaveBeenCalled()
  })

  it('starts the Settings default in WSL when the node names no shell', async () => {
    defaultShell = 'wsl:Ubuntu'
    await create('win32', { cwd: 'C:\\project' })
    expect(resolver.resolve).toHaveBeenCalledWith('Ubuntu', 'C:\\project')
    expect(backend.create.mock.calls[0][1].shell).toBe(PLAN.file)
  })

  it('lets a node’s own shell win over a WSL default', async () => {
    defaultShell = 'wsl:Ubuntu'
    await create('win32', { shell: 'pwsh' })
    expect(resolver.resolve).not.toHaveBeenCalled()
    expect(backend.create.mock.calls[0][1].shell).toBe('pwsh')
  })

  it('refuses a WSL default on a non-Windows core, starting nothing', async () => {
    defaultShell = 'wsl:Ubuntu'
    await expect(create('linux', {})).rejects.toThrow('A new WSL terminal')
    expect(backend.create).not.toHaveBeenCalled()
  })

  it('reattaches a live session without asking WSL, even if the directory is gone', async () => {
    backend.hasSession.mockResolvedValue(true)
    resolver.resolve.mockRejectedValue(new Error('must not be asked'))
    await create('win32', { shell: 'wsl:Ubuntu', cwd: 'Z:\\unmapped' })
    expect(resolver.resolve).not.toHaveBeenCalled()
    expect(backend.attachExisting).toHaveBeenCalledTimes(1)
    expect(backend.create).not.toHaveBeenCalled()
  })

  it('reattaches a live session at the size the viewer asked for', async () => {
    backend.hasSession.mockResolvedValue(true)
    await create('win32', { shell: 'wsl:Ubuntu', cols: 78, rows: 25 })
    expect(backend.attachExisting).toHaveBeenCalledWith(expect.stringMatching(/^nt-/), {
      cols: 78,
      rows: 25
    })
  })

  it.each(['wsl:My Distro', 'wsl:%2Dfoo', 'wsl:bad%ZZ', 'wsl:-foo', `wsl:${'a'.repeat(200)}`])(
    'refuses the malformed value %s by name instead of starting another shell',
    async (shell) => {
      await expect(create('win32', { shell })).rejects.toThrow('is not a valid WSL distribution')
      expect(resolver.resolve).not.toHaveBeenCalled()
      expect(backend.create).not.toHaveBeenCalled()
    }
  )

  it('gives direct node-pty the plan when there is no session host', async () => {
    backend.supported.mockReturnValue(false)
    await create('win32', { shell: 'wsl:Ubuntu', cwd: 'C:\\project' })
    expect(nodePty.spawn.mock.calls[0].slice(0, 2)).toEqual([PLAN.file, PLAN.args])
  })

  it('uses a WSL default when the node’s own shell is not a usable program', async () => {
    defaultShell = 'wsl:Ubuntu'
    await create('win32', { shell: 'a;b', cwd: 'C:\\project' })
    expect(resolver.resolve).toHaveBeenCalledWith('Ubuntu', 'C:\\project')
    expect(backend.create.mock.calls[0][1].shell).toBe(PLAN.file)
  })

  it('honours a project’s local WSL shell through the create path', async () => {
    manager = new PtyManagerCtor({ runtimePlatform: 'win32' })
    manager.registerIpc()
    ;(manager as unknown as { projectSpawnOverrides: () => unknown }).projectSpawnOverrides =
      async () => ({ shell: 'wsl:Ubuntu' })
    await host.handlers[IPC.ptyCreate](7, { cols: 80, rows: 24, persistKey: 'node-wsl' })
    expect(resolver.resolve).toHaveBeenCalledWith('Ubuntu', undefined)
    expect(backend.create.mock.calls[0][1].shell).toBe(PLAN.file)
  })

  it('does not treat an unanswered session probe as "no session"', async () => {
    backend.hasSession.mockRejectedValue(new Error('host unreachable'))
    await expect(create('win32', { shell: 'wsl:Ubuntu', cwd: 'Z:\\x' })).rejects.toThrow(
      'Could not check for a running WSL terminal: host unreachable'
    )
    expect(resolver.resolve).not.toHaveBeenCalled()
    expect(backend.create).not.toHaveBeenCalled()
  })

  it('an SSH node ignores a WSL default', async () => {
    defaultShell = 'wsl:Ubuntu'
    const outcome = await Promise.resolve(
      create('linux', {
        sshRemote: {
          controlPath: '/var/tmp/nt-test-cm',
          conn: { host: 'box.test', user: 'deploy' },
          remoteCwd: '/srv/app'
        }
      })
    ).catch((err: unknown) => err)
    expect(String(outcome)).not.toContain('WSL')
    expect(resolver.resolve).not.toHaveBeenCalled()
    expect(JSON.stringify(nodePty.spawn.mock.calls)).not.toContain('wsl:')
  })

  describe('a phone attaching over the relay', () => {
    async function relayAttach(live: boolean, node: { shell?: string } = { shell: 'wsl:Ubuntu' }) {
      backend.hasSession.mockResolvedValue(live)
      manager = new PtyManagerCtor({ runtimePlatform: 'win32' })
      manager.init(() => ({ ...DEFAULT_SETTINGS, defaultShell }))
      manager.setRelayNodeResolver({
        placements: () => [
          { projectId: 'p1', node: { kind: 'terminal', cwd: 'C:\\project', ...node } }
        ],
        refFor: () => undefined,
        projectIsRemote: () => false
      } as unknown as Parameters<typeof manager.setRelayNodeResolver>[0])
      const prep = await manager.prepareRelayAttach('node-wsl', { cols: 80, rows: 24 })
      if (prep.kind !== 'ready') throw new Error(`expected ready, got ${prep.kind}`)
      return prep.attach({ onData: () => {}, onExit: () => {} } as never)
    }

    it('joins a live WSL terminal', async () => {
      await relayAttach(true)
      expect(backend.attachExisting).toHaveBeenCalledTimes(1)
      expect(backend.create).not.toHaveBeenCalled()
    })

    it('joins a live terminal whose WSL shell came from the default', async () => {
      defaultShell = 'wsl:Ubuntu'
      await relayAttach(true, {})
      expect(backend.attachExisting).toHaveBeenCalledTimes(1)
    })

    it('cannot start a new one', async () => {
      await expect(relayAttach(false)).rejects.toThrow('WSL terminal')
      expect(backend.create).not.toHaveBeenCalled()
    })
  })

  it('leaves an ordinary shell on its existing path', async () => {
    await create('win32', { shell: 'pwsh', cwd: 'C:\\project' })
    expect(resolver.resolve).not.toHaveBeenCalled()
    expect(backend.create.mock.calls[0][1].shell).toBe('pwsh')
  })
})
