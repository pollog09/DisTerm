import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import { SHIP_LEASE_MS, holdShipConfigLease } from '../../shared/ship-config'
import type { CorePlatform } from '../platform'
import { testTmpDir } from '../test-tmp'
import {
  SHIP_POLL_LOCAL_MS,
  SHIP_POLL_REMOTE_MS,
  createShipGraph,
  readShipConfig,
  registerShipConfigHandlers,
  type ShipConfigRouter
} from './handlers'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const local = (cwd: string | null): ShipConfigRouter => ({ route: () => ({ kind: 'local', cwd }) })

/** A real POSIX sh standing in for the host at the far end of ssh. */
function hostRunner(home: string, extraEnv: Record<string, string> = {}) {
  return async (script: string): Promise<{ code: number; stdout: string }> => {
    try {
      const stdout = execFileSync('sh', ['-s'], { input: script, cwd: home, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '', HOME: home, ...extraEnv } })
      return { code: 0, stdout }
    } catch (err) {
      const e = err as { status?: number; stdout?: string }
      return { code: e.status ?? 1, stdout: e.stdout ?? '' }
    }
  }
}

describe('readShipConfig', () => {
  it('reads this machine for a local project, from CLAUDE_CONFIG_DIR when it is set', async () => {
    const dir = testTmpDir('ship-read-')
    vi.stubEnv('CLAUDE_CONFIG_DIR', dir)
    fs.mkdirSync(path.join(dir, 'agents'))
    fs.writeFileSync(path.join(dir, 'agents', 'a.md'), '---\nname: a\n---\n')
    const r = await readShipConfig('P', local(null))
    expect(r).toMatchObject({ ok: true, config: { machine: { kind: 'local' }, projectGraphPath: null, globalGraphPath: path.join(dir, 'ship-graph.json') } })
    expect(r.ok && r.config.agents.map((a) => a.name)).toEqual(['a'])
  })

  it('reads the HOST for an SSH project, never this machine', async () => {
    const localDir = testTmpDir('ship-read-')
    vi.stubEnv('CLAUDE_CONFIG_DIR', localDir)
    fs.mkdirSync(path.join(localDir, 'agents'))
    fs.writeFileSync(path.join(localDir, 'agents', 'local-only.md'), '---\nname: local-only\n---\n')
    const home = testTmpDir('ship-host-')
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'agents', 'on-host.md'), '---\nname: on-host\n---\n')
    const r = await readShipConfig('P', { route: () => ({ kind: 'remote', remoteCwd: home, host: 'box', runScript: hostRunner(home) }) })
    expect(r.ok && r.config.machine).toEqual({ kind: 'ssh', label: 'box' })
    expect(r.ok && r.config.agents.map((a) => a.name)).toEqual(['on-host'])
  })

  it('a dropped channel is a named failure, not an empty machine', async () => {
    const r = await readShipConfig('P', { route: () => ({ kind: 'remote', remoteCwd: '/x', host: 'box', runScript: async () => ({ code: 255, stdout: '' }) }) })
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('255') })
    const thrown = await readShipConfig('P', { route: () => ({ kind: 'remote', remoteCwd: '/x', host: 'box', runScript: async () => { throw new Error('gone') } }) })
    expect(thrown).toEqual({ ok: false, reason: expect.stringContaining('gone') })
  })

  it('an unsupported route says why, and a bad id is refused', async () => {
    await expect(readShipConfig('P', { route: () => ({ kind: 'unsupported', reason: 'Not connected.' }) })).resolves.toEqual({ ok: false, reason: 'Not connected.' })
    await expect(readShipConfig(7, local(null))).resolves.toMatchObject({ ok: false })
  })
})

describe('createShipGraph', () => {
  it('writes the example into a project and never over a file', async () => {
    const cwd = testTmpDir('ship-create-')
    const file = path.join(cwd, '.claude', 'ship-graph.json')
    await expect(createShipGraph('P', 'project', local(cwd))).resolves.toEqual({ ok: true, path: file })
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pipelines[0].id).toBe('ship-change')
    fs.writeFileSync(file, 'mine')
    await expect(createShipGraph('P', 'project', local(cwd))).resolves.toMatchObject({ ok: false, reason: 'exists' })
    expect(fs.readFileSync(file, 'utf8')).toBe('mine')
  })

  it('refuses a project file on a canvas with no folder, and an unknown scope', async () => {
    await expect(createShipGraph('P', 'project', local(null))).resolves.toMatchObject({ ok: false, reason: 'unsupported' })
    await expect(createShipGraph('P', '../../etc', local('/tmp'))).resolves.toMatchObject({ ok: false, reason: 'unsupported' })
  })

  it('writes on the host for an SSH project, with the same refusal', async () => {
    const home = testTmpDir('ship-create-host-')
    const cwd = path.join(home, "pro'ject")
    fs.mkdirSync(cwd)
    const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: cwd, host: 'box', runScript: hostRunner(home) }) }
    const file = path.join(cwd, '.claude', 'ship-graph.json')
    await expect(createShipGraph('P', 'project', router)).resolves.toEqual({ ok: true, path: file })
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pipelines[0].id).toBe('ship-change')
    fs.writeFileSync(file, 'mine')
    await expect(createShipGraph('P', 'project', router)).resolves.toMatchObject({ ok: false, reason: 'exists' })
    expect(fs.readFileSync(file, 'utf8')).toBe('mine')
  })
})

describe('createShipGraph reports the path the host really used', () => {
  it('a global file under the host\'s CLAUDE_CONFIG_DIR', async () => {
    const home = testTmpDir('ship-create-cfg-')
    const dir = path.join(home, 'custom-config')
    const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: home, host: 'box', runScript: hostRunner(home, { CLAUDE_CONFIG_DIR: dir }) }) }
    const file = path.join(dir, 'ship-graph.json')
    await expect(createShipGraph('P', 'global', router)).resolves.toEqual({ ok: true, path: file })
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.existsSync(path.join(home, '.claude', 'ship-graph.json'))).toBe(false)
    await expect(createShipGraph('P', 'global', router)).resolves.toMatchObject({ ok: false, reason: 'exists', message: `${file} already exists.` })
  })

  it('a script cut off by a dropped channel runs nothing and reports nothing, at any length', async () => {
    const home = testTmpDir('ship-create-cut-')
    const cwd = path.join(home, 'proj')
    const hostCwd = path.join(home, 'where-the-shell-runs')
    fs.mkdirSync(cwd)
    fs.mkdirSync(hostCwd)
    let whole = ''
    await createShipGraph('P', 'project', { route: () => ({ kind: 'remote', remoteCwd: cwd, host: 'box', runScript: async (s) => {
      whole = s
      return { code: 0, stdout: '' }
    } }) })
    const dir = path.join(cwd, '.claude')
    const file = path.join(dir, 'ship-graph.json')
    const bodyStart = whole.indexOf('{\n  "pipelines"')
    const bodyEnd = whole.indexOf("}\n' >")
    expect(bodyStart).toBeGreaterThan(0)
    const lastLine = whole.lastIndexOf('nt_create_ship_graph\n')
    const cut = async (at: number): Promise<void> => {
      const r = await createShipGraph('P', 'project', { route: () => ({ kind: 'remote', remoteCwd: cwd, host: 'box', runScript: async (script) => {
        // sh -s on a piece of this call's script (its nonce is its own), in a neutral cwd: what a
        // dropped channel leaves.
        const out = spawnSync('sh', ['-s'], { input: script.slice(0, at), cwd: hostCwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home } })
        return { code: out.status ?? 1, stdout: out.stdout ?? '' }
      } }) })
      const label = JSON.stringify(whole.slice(Math.max(0, at - 24), at))
      expect(fs.readdirSync(hostCwd), `stray from ${label}`).toEqual([])
      if (at < lastLine + 'nt_create_ship_graph'.length) {
        expect(r.ok, `reported success from ${label}`).toBe(false)
        expect(fs.existsSync(dir), `ran part of the script from ${label}`).toBe(false)
      } else {
        expect(r.ok, label).toBe(true) // the call itself made it across
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).pipelines[0].id).toBe('ship-change')
      }
      fs.rmSync(dir, { recursive: true, force: true })
    }
    // Every byte of the script around the JSON, and a sample inside it, where every cut is the same.
    for (let at = 1; at < whole.length; at++) {
      if (at > bodyStart + 4 && at < bodyEnd - 4 && at % 40 !== 0) continue
      await cut(at)
    }
    await cut(whole.length)
  }, 60_000)

  it('exit 0 with no done marker is not a success: a shell that read nothing also exits 0', async () => {
    const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: '/p', host: 'box', runScript: async () => ({ code: 0, stdout: '' }) }) }
    await expect(createShipGraph('P', 'project', router)).resolves.toMatchObject({ ok: false, reason: 'failed' })
  })

  it('leaves no temp behind', async () => {
    const home = testTmpDir('ship-create-temp-')
    const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: home, host: 'box', runScript: hostRunner(home) }) }
    await createShipGraph('P', 'project', router)
    expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(['ship-graph.json'])
  })

  it('a failed write on the host is a failure, not a success with a path', async () => {
    const home = testTmpDir('ship-create-fail-')
    const cwd = path.join(home, 'ro')
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    fs.chmodSync(path.join(cwd, '.claude'), 0o500)
    const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: cwd, host: 'box', runScript: hostRunner(home) }) }
    await expect(createShipGraph('P', 'project', router)).resolves.toMatchObject({ ok: false, reason: 'failed' })
    fs.chmodSync(path.join(cwd, '.claude'), 0o700)
  })
})

describe('registerShipConfigHandlers', () => {
  function platform() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const casts = new Map<string, (...a: unknown[]) => void>()
    const broadcast = vi.fn()
    return {
      handlers,
      casts,
      broadcast,
      core: {
        handle: (c: string, f: (...a: unknown[]) => unknown) => handlers.set(c, f),
        on: (c: string, f: (...a: unknown[]) => void) => casts.set(c, f),
        broadcast
      } as unknown as CorePlatform
    }
  }

  /** A host whose reads answer whatever `output` says, counting them. */
  function remoteRouter(host: { script: string; reads: number }): ShipConfigRouter {
    return {
      route: () => ({
        kind: 'remote',
        remoteCwd: '/p',
        host: 'box',
        runScript: async (script) => {
          host.reads++
          const nonce = /printf '\\n(NTSC[0-9a-f]+) home/.exec(script)![1]
          return { code: 0, stdout: `\n${nonce} home /h\n${host.script ? `\n${nonce} agent global ${host.script}.md\n---\nname: ${host.script}\n---\n` : ''}\n${nonce} end\n` }
        }
      })
    }
  }

  it('pushes only on a real change, and polls until the last lease is released', async () => {
    vi.useFakeTimers()
    const p = platform()
    const host = { script: 'first', reads: 0 }
    registerShipConfigHandlers(p.core, remoteRouter(host))
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'view-1')
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'view-2') // a second viewer shares the one poll
    await vi.advanceTimersByTimeAsync(0)
    expect(host.reads).toBe(1)

    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS)
    expect(host.reads).toBe(2)
    expect(p.broadcast).not.toHaveBeenCalled() // nothing changed

    host.script = 'second'
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS)
    expect(p.broadcast).toHaveBeenCalledTimes(1)
    expect(p.broadcast).toHaveBeenCalledWith(IPC.shipConfigChanged('P'), 'P')

    p.casts.get(IPC.shipConfigUnsubscribe)!('P', 'view-1')
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS)
    expect(host.reads).toBe(4) // one viewer left
    p.casts.get(IPC.shipConfigUnsubscribe)!('P', 'view-2')
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS * 3)
    expect(host.reads).toBe(4) // none left: silence
  })

  it('a viewer that dies without a goodbye stops the poll when its lease runs out', async () => {
    vi.useFakeTimers()
    const p = platform()
    const host = { script: 'x', reads: 0 }
    registerShipConfigHandlers(p.core, remoteRouter(host))
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'crashed') // and never another word
    await vi.advanceTimersByTimeAsync(SHIP_LEASE_MS + SHIP_POLL_REMOTE_MS)
    const atExpiry = host.reads
    expect(atExpiry).toBeGreaterThan(1)
    await vi.advanceTimersByTimeAsync(SHIP_LEASE_MS * 5)
    expect(host.reads).toBe(atExpiry)
  })

  it('a renewed lease keeps polling, through the helper both transports use', async () => {
    vi.useFakeTimers()
    const p = platform()
    const host = { script: 'x', reads: 0 }
    registerShipConfigHandlers(p.core, remoteRouter(host))
    const stop = holdShipConfigLease({
      subscribe: (id) => p.casts.get(IPC.shipConfigSubscribe)!('P', id),
      unsubscribe: (id) => p.casts.get(IPC.shipConfigUnsubscribe)!('P', id)
    })
    await vi.advanceTimersByTimeAsync(SHIP_LEASE_MS * 3)
    const before = host.reads
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS * 2)
    expect(host.reads).toBe(before + 2)
    stop()
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS * 3)
    expect(host.reads).toBe(before + 2)
  })

  it('a lapsed view that renews still hears what changed while it was gone', async () => {
    vi.useFakeTimers()
    const p = platform()
    const host = { script: 'before', reads: 0 }
    registerShipConfigHandlers(p.core, remoteRouter(host))
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'hidden')
    await vi.advanceTimersByTimeAsync(SHIP_LEASE_MS * 2)
    host.script = 'after'
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'hidden')
    await vi.advanceTimersByTimeAsync(0)
    expect(p.broadcast).toHaveBeenCalledTimes(1)
    p.casts.get(IPC.shipConfigUnsubscribe)!('P', 'hidden')
  })

  it('takes up the remote pace once an SSH master connects, instead of keeping the one it started with', async () => {
    vi.useFakeTimers()
    const p = platform()
    const host = { script: 'x', reads: 0 }
    const remote = remoteRouter(host)
    let connected = false
    registerShipConfigHandlers(p.core, {
      route: (id) => (connected ? remote.route(id) : { kind: 'unsupported', reason: 'This SSH project is not connected.' })
    })
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'view')
    await vi.advanceTimersByTimeAsync(SHIP_POLL_LOCAL_MS)
    expect(host.reads).toBe(0)

    connected = true
    await vi.advanceTimersByTimeAsync(SHIP_POLL_LOCAL_MS) // the tick already scheduled at the old pace
    expect(host.reads).toBe(1)
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS - 1)
    expect(host.reads).toBe(1) // not every 5 s
    await vi.advanceTimersByTimeAsync(1)
    expect(host.reads).toBe(2)
    p.casts.get(IPC.shipConfigUnsubscribe)!('P', 'view')
  })

  it('never reads a slow host twice at once', async () => {
    vi.useFakeTimers()
    const p = platform()
    let inFlight = 0
    let most = 0
    registerShipConfigHandlers(p.core, {
      route: () => ({
        kind: 'remote',
        remoteCwd: '/p',
        host: 'box',
        runScript: async () => {
          most = Math.max(most, ++inFlight)
          await new Promise((r) => setTimeout(r, SHIP_POLL_REMOTE_MS * 3))
          inFlight--
          return { code: 0, stdout: '' }
        }
      })
    })
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'view')
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS * 10)
    expect(most).toBe(1)
    p.casts.get(IPC.shipConfigUnsubscribe)!('P', 'view')
  })

  it('closing and reopening on a slow host never reads twice at once, and a stopped read changes nothing', async () => {
    vi.useFakeTimers()
    const p = platform()
    let inFlight = 0
    let most = 0
    let answer = 'first'
    const nonceOf = (s: string): string => /printf '\\n(NTSC[0-9a-f]+) home/.exec(s)![1]
    registerShipConfigHandlers(p.core, {
      route: () => ({
        kind: 'remote',
        remoteCwd: '/p',
        host: 'box',
        runScript: async (script) => {
          most = Math.max(most, ++inFlight)
          const said = answer
          await new Promise((r) => setTimeout(r, 1000))
          inFlight--
          const n = nonceOf(script)
          return { code: 0, stdout: `\n${n} home /h\n\n${n} agent global ${said}.md\n---\nname: ${said}\n---\n\n${n} end\n` }
        }
      })
    })
    const sub = p.casts.get(IPC.shipConfigSubscribe)!
    const unsub = p.casts.get(IPC.shipConfigUnsubscribe)!
    sub('P', 'a')
    unsub('P', 'a')
    sub('P', 'b')
    unsub('P', 'b')
    answer = 'second'
    sub('P', 'c')
    await vi.advanceTimersByTimeAsync(5000)
    expect(most).toBe(1)
    // The stopped reads said `first`. Had one set the signature, the live read's `second` would push.
    expect(p.broadcast).not.toHaveBeenCalled()
    unsub('P', 'c')
  })

  it('a local project polls on the shorter interval', async () => {
    vi.useFakeTimers()
    const p = platform()
    const route = vi.fn(() => ({ kind: 'unsupported' as const, reason: 'x' }))
    registerShipConfigHandlers(p.core, { route })
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'view')
    await vi.advanceTimersByTimeAsync(0)
    const before = route.mock.calls.length
    await vi.advanceTimersByTimeAsync(SHIP_POLL_LOCAL_MS)
    expect(route.mock.calls.length).toBeGreaterThan(before)
    p.casts.get(IPC.shipConfigUnsubscribe)!('P', 'view')
  })

  it('ignores a subscribe with no project id', () => {
    const p = platform()
    registerShipConfigHandlers(p.core, local(null))
    expect(() => p.casts.get(IPC.shipConfigSubscribe)!(undefined, 'x')).not.toThrow()
    expect(() => p.casts.get(IPC.shipConfigSubscribe)!('P', undefined)).not.toThrow()
  })
})
