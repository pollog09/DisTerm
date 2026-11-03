// The WSL keepalive and the review's hardening of the endpoint, through the production path. wsl.exe is
// a seam (it cannot run on CI), but the keepalive's own scripts run for real under /bin/sh below, against
// real processes this file owns and stops by PID.

import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testTmpDir } from '../../core/test-tmp'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { remoteAtomicWrite } from '../remote-atomic-write'
import { ed25519KeyPair } from '../../core/remote-ssh/native/test-keys'
import { formatCksum, posixCksum } from '../../core/remote-ssh/posix-cksum'
import {
  WHOAMI_SID_ARGS,
  WSL_KEEPALIVE_MARKER_PREFIX,
  WSL_KEEPALIVE_OPS,
  WSL_KEEPALIVE_SCRIPT,
  WSL_PROBE_SCRIPT,
  WSL_SSHD_DIR,
  WslEndpoints,
  icaclsExe,
  parseWhoamiSid,
  restrictWindowsDir,
  spawnKeepaliveProcess,
  whoamiExe,
  wslKeepaliveMarker,
  wslRunner,
  wslSshdConfig,
  type WslRun
} from '../../core/remote-ssh/native/wsl-endpoint'

const WIN_ENV = { SystemRoot: 'C:\\Windows' }
const BROWSE = 'ssh-browse-test'
const CP = '/cm/project.sock'

interface Distro {
  files: Map<string, string>
  tools: { sshd: boolean; tmux: boolean; curl: boolean }
  running: boolean
  /** Keepalive pids per marker, as the ops script would find them. */
  keepalives: Map<string, string[]>
}

function distro(): Distro {
  return { files: new Map(), tools: { sshd: true, tmux: true, curl: true }, running: true, keepalives: new Map() }
}

const ok = (out: string, code = 0) => ({ code, stdout: Buffer.from(out), stderr: Buffer.alloc(0), timedOut: false })

interface Harness {
  svc: WslEndpoints
  dir: string
  calls: { args: string[]; stdin?: string }[]
  spawned: { file: string; args: string[] }[]
  d: Distro
  failWrite: { name?: string }
  enabled: { value: boolean }
  logs: string[]
  acl: string[]
  spawnFails: { value?: string }
}

function harness(over: { dir?: string; d?: Distro; opFails?: boolean; neverAppears?: boolean; slowOps?: boolean; runningFails?: { value: boolean } } = {}): Harness {
  const d = over.d ?? distro()
  const dir = over.dir ?? testTmpDir('nt-wsl-ka-')
  const calls: Harness['calls'] = []
  const spawned: Harness['spawned'] = []
  const failWrite: Harness['failWrite'] = {}
  const enabled = { value: true }
  const logs: string[] = []
  const acl: string[] = []
  const spawnFails: Harness['spawnFails'] = {}
  let nextPid = 100
  const run: WslRun = async (args, o) => {
    calls.push({ args, stdin: o.stdin })
    if (args[0] === '--list') {
      if (args[1] === '--running' && over.runningFails?.value) return ok('', 1)
      const names = args[1] === '--running' ? (d.running ? ['Ubuntu'] : []) : ['Ubuntu', 'Other']
      return { ...ok(''), stdout: Buffer.from(`${names.join('\r\n')}\r\n`, 'utf16le') }
    }
    // Any `-d` call boots a stopped distro, exactly as the real one does.
    d.running = true
    const script = args[5]
    if (script === WSL_PROBE_SCRIPT) {
      const f = (n: string): string => d.files.get(`${WSL_SSHD_DIR}/${n}`) ?? ''
      const sum = (s: string): string => (s ? formatCksum(posixCksum(Buffer.from(s))) : '')
      const lines: Record<string, string> = {
        user: 'dev',
        home: '/home/dev',
        sshd: d.tools.sshd ? '/usr/sbin/sshd' : '',
        tmux: '1',
        curl: '1',
        pm: 'apt-get',
        hostkey: f('host_ed25519.pub').trim(),
        hostpriv: f('host_ed25519') ? '1' : '0',
        authorized: sum(f('authorized_keys')),
        config: sum(f('sshd_config')),
        instance: 'boot:1'
      }
      return ok(Object.entries(lines).map(([k, v]) => `NTWSL ${k}=${v}\n`).join(''))
    }
    if (script === WSL_KEEPALIVE_OPS) {
      if (over.opFails) return ok('', 1)
      const op = args[7]
      expect(args[8]).toBe(WSL_KEEPALIVE_MARKER_PREFIX)
      const pids = [...d.keepalives.values()].flat()
      // Answers from what it saw when asked. A real wsl.exe round trip takes a while, and that gap is
      // what lets two unserialized connects both find none.
      if (over.slowOps) await new Promise((r) => setTimeout(r, 20))
      if (op === 'stop') {
        d.keepalives.clear()
        return ok(pids.map((p) => `NTWSL stopped=${p}\n`).join(''))
      }
      if (op === 'trim') {
        let kept = false
        for (const [m, list] of [...d.keepalives]) {
          if (kept || !list.length) d.keepalives.delete(m)
          else {
            d.keepalives.set(m, list.slice(0, 1))
            kept = true
          }
        }
        return ok(pids.slice(0, 1).map((p) => `NTWSL keepalive=${p}\n`).join(''))
      }
      return ok(pids.map((p) => `NTWSL keepalive=${p}\n`).join(''))
    }
    if (script.startsWith('umask 077; mkdir') && !script.includes('mv -f')) return ok('')
    const target = /mv -f -- \S+ (\S+?);/.exec(script)?.[1]
    if (target && o.stdin !== undefined) {
      const rel = target.replace(/^~\//, '').replace(/'/g, '')
      if (failWrite.name && rel.endsWith(`/${failWrite.name}`)) return ok('', 1)
      d.files.set(rel, o.stdin)
      return ok('')
    }
    throw new Error(`unexpected script: ${script.slice(0, 80)}`)
  }
  const svc = new WslEndpoints({
    dir,
    run,
    platform: 'win32',
    env: WIN_ENV,
    atomicWrite: remoteAtomicWrite,
    generateKeyPair: () => ed25519KeyPair(),
    keepaliveEnabled: () => enabled.value,
    delay: async () => {},
    log: (l) => logs.push(l),
    restrictDir: async (x) => {
      acl.push(x)
    },
    spawnKeepalive: (file, args) => {
      spawned.push({ file, args })
      const handlers: ((e: Error) => void)[] = []
      if (spawnFails.value) queueMicrotask(() => handlers.forEach((h) => h(new Error(spawnFails.value))))
      else if (!over.neverAppears) {
        const marker = args[args.length - 1]
        d.keepalives.set(marker, [...(d.keepalives.get(marker) ?? []), String(nextPid++)])
      }
      return { on: (_ev, cb) => handlers.push(cb) }
    }
  })
  return { svc, dir, calls, spawned, d, failWrite, enabled, logs, acl, spawnFails }
}

async function ready(h: Harness): Promise<{ host: string; handle: string; marker: string }> {
  const r = await h.svc.prepare('Ubuntu', BROWSE)
  if (!r.ok) throw new Error(r.error)
  const host = r.server.host
  const handle = /-([a-f0-9]{16})\.wsl\./.exec(host)?.[1] as string
  return { host, handle, marker: wslKeepaliveMarker(handle) }
}

const keepaliveOps = (h: Harness): string[][] => h.calls.filter((c) => c.args[5] === WSL_KEEPALIVE_OPS).map((c) => c.args)
const dCalls = (h: Harness): number => h.calls.filter((c) => c.args[0] === '-d').length

describe('the keepalive: when it starts', () => {
  it('the setting is on by default', () => {
    expect(DEFAULT_SETTINGS.wslKeepDistroRunning).toBe(true)
  })

  it('starts one for a bound project, by argv, with the exact command the docs give', async () => {
    const h = harness()
    const { host, marker } = await ready(h)
    await h.svc.bind('p1', host)
    await h.svc.connected('p1', host)
    expect(h.spawned).toEqual([
      {
        file: 'C:\\Windows\\System32\\wsl.exe',
        args: ['-d', 'Ubuntu', '--exec', 'sh', '-c', WSL_KEEPALIVE_SCRIPT, marker]
      }
    ])
    expect(h.svc.warningsFor(host)).toEqual([])
  })

  it('never for a listing, a setup or a folder browse', async () => {
    const h = harness()
    await h.svc.list()
    const { host } = await ready(h)
    await h.svc.connected(BROWSE, host)
    await h.svc.connected('attached-p9-abcd', host)
    expect(h.spawned).toEqual([])
    expect(keepaliveOps(h)).toEqual([])
  })

  it('reuses one that survived the last run, so restarts do not pile them up', async () => {
    const h = harness()
    const { host, marker } = await ready(h)
    await h.svc.bind('p1', host)
    await h.svc.connected('p1', host)
    // A new app run, against the same machine-local records and the same running distro.
    const next = harness({ dir: h.dir, d: h.d })
    await next.svc.connected('p1', host)
    await next.svc.connected('p1', host)
    expect(next.spawned).toEqual([])
    expect(h.d.keepalives.get(marker)).toHaveLength(1)
  })

  it('leaves exactly one when it finds several', async () => {
    const h = harness()
    const { host, marker } = await ready(h)
    await h.svc.bind('p1', host)
    h.d.keepalives.set(marker, ['7', '8', '9'])
    await h.svc.connected('p1', host)
    expect(h.d.keepalives.get(marker)).toEqual(['7'])
    expect(h.spawned).toEqual([])
  })

  it('two connects at once start one', async () => {
    const h = harness({ slowOps: true })
    const { host, marker } = await ready(h)
    await h.svc.bind('p1', host)
    await h.svc.bind('p2', host)
    await Promise.all([h.svc.connected('p1', host), h.svc.connected('p2', host)])
    expect(h.spawned).toHaveLength(1)
    expect(h.d.keepalives.get(marker)).toHaveLength(1)
  })

  it('with the setting off, starts nothing and stops one left by an earlier run', async () => {
    const h = harness()
    const { host, marker } = await ready(h)
    await h.svc.bind('p1', host)
    h.enabled.value = false
    h.d.keepalives.set(marker, ['7'])
    await h.svc.connected('p1', host)
    expect(h.spawned).toEqual([])
    expect(h.d.keepalives.has(marker)).toBe(false)
  })
})

describe('the keepalive: when it cannot start', () => {
  it.each([
    ['wsl.exe fails to start it', { spawn: 'spawn UNKNOWN' }, /spawn UNKNOWN/],
    ['it never appears in the distro', { neverAppears: true }, /did not appear/],
    ['the check itself fails', { opFails: true }, /did not answer/]
  ])('%s: a named warning, and the connect is not failed', async (_n, cfg, why) => {
    const h = harness({ neverAppears: (cfg as { neverAppears?: boolean }).neverAppears, opFails: (cfg as { opFails?: boolean }).opFails })
    const { host } = await ready(h)
    await h.svc.bind('p1', host)
    h.spawnFails.value = (cfg as { spawn?: string }).spawn
    await expect(h.svc.connected('p1', host)).resolves.toBeUndefined()
    const w = h.svc.warningsFor(host).find((x) => x.kind === 'keepalive')
    expect(w?.message).toMatch(/"Ubuntu"/)
    expect(w?.message).toMatch(why)
    expect(w?.message).toMatch(/project still works/)
  })

  it('a warning clears once a later attempt works', async () => {
    const h = harness()
    const { host } = await ready(h)
    await h.svc.bind('p1', host)
    h.spawnFails.value = 'nope'
    await h.svc.connected('p1', host)
    expect(h.svc.warningsFor(host)).toHaveLength(1)
    h.spawnFails.value = undefined
    await h.svc.connected('p1', host)
    expect(h.svc.warningsFor(host)).toEqual([])
  })
})

describe('the keepalive: stopping', () => {
  it('turning the setting off stops it, and does not boot a stopped distro', async () => {
    const h = harness()
    const { host, marker } = await ready(h)
    await h.svc.bind('p1', host)
    await h.svc.connected('p1', host)
    h.enabled.value = false
    await h.svc.keepaliveSettingChanged()
    expect(h.d.keepalives.has(marker)).toBe(false)

    const stopped = harness()
    const s = await ready(stopped)
    stopped.d.running = false
    stopped.enabled.value = false
    const before = dCalls(stopped)
    await stopped.svc.keepaliveSettingChanged()
    expect(dCalls(stopped)).toBe(before)
    expect(stopped.d.running).toBe(false)
    expect(s.host).toBeTruthy()
  })

  it('turning it back on starts one only for what is open', async () => {
    const h = harness()
    const { host } = await ready(h)
    await h.svc.bind('p1', host)
    h.enabled.value = false
    await h.svc.connected('p1', host)
    expect(h.spawned).toEqual([])
    h.enabled.value = true
    await h.svc.keepaliveSettingChanged()
    expect(h.spawned).toHaveLength(1)

    const idle = harness()
    await ready(idle)
    await idle.svc.keepaliveSettingChanged()
    expect(idle.spawned).toEqual([])
  })

  it('the last project deleted stops it; an earlier one leaves it running', async () => {
    const h = harness()
    const { host, marker } = await ready(h)
    await h.svc.bind('p1', host)
    await h.svc.bind('p2', host)
    await h.svc.connected('p1', host)
    await h.svc.unbind('p1', host)
    expect(h.d.keepalives.get(marker)).toHaveLength(1)
    await h.svc.unbind('p2', host)
    expect(h.d.keepalives.has(marker)).toBe(false)
  })

  it('deleting the last project of a stopped distro does not boot it', async () => {
    const h = harness()
    const { host } = await ready(h)
    await h.svc.bind('p1', host)
    h.d.running = false
    const before = dCalls(h)
    await h.svc.unbind('p1', host)
    expect(dCalls(h)).toBe(before)
    expect(h.d.running).toBe(false)
  })

  it('turning it off then on while the project is closed and its distro stopped boots nothing', async () => {
    const h = harness()
    const { host } = await ready(h)
    await h.svc.bind('p1', host)
    await h.svc.connected('p1', host)
    h.svc.disconnected('p1', host)
    h.d.running = false
    h.d.keepalives.clear()
    const before = dCalls(h)
    h.enabled.value = false
    await h.svc.keepaliveSettingChanged()
    h.enabled.value = true
    await h.svc.keepaliveSettingChanged()
    expect(dCalls(h)).toBe(before)
    expect(h.d.running).toBe(false)
    expect(h.spawned).toHaveLength(1)
  })

  it('a setting change boots nothing even with a project open, if its distro is stopped', async () => {
    const h = harness()
    const { host } = await ready(h)
    await h.svc.bind('p1', host)
    h.enabled.value = false
    await h.svc.connected('p1', host)
    h.d.running = false
    const before = dCalls(h)
    h.enabled.value = true
    await h.svc.keepaliveSettingChanged()
    expect(dCalls(h)).toBe(before)
    expect(h.d.running).toBe(false)
    expect(h.spawned).toEqual([])
  })

  it('a closed project’s distro, still running, does not get a new one when the setting comes on', async () => {
    const h = harness()
    const { host } = await ready(h)
    await h.svc.bind('p1', host)
    h.enabled.value = false
    await h.svc.connected('p1', host)
    h.svc.disconnected('p1', host)
    h.enabled.value = true
    await h.svc.keepaliveSettingChanged()
    expect(h.spawned).toEqual([])
  })

  it('an unbound project no longer connects, and `wsl --shutdown` is not fought: nothing runs until a connect', async () => {
    const h = harness()
    const { host, marker } = await ready(h)
    await h.svc.bind('p1', host)
    await h.svc.connected('p1', host)
    // The user runs `wsl --shutdown`: the distro and the keepalive are gone. The service has no timer
    // or watcher of its own, so nothing it owns starts the distro again.
    h.d.running = false
    h.d.keepalives.delete(marker)
    const before = h.calls.length
    await new Promise((r) => setTimeout(r, 30))
    expect(h.calls.length).toBe(before)
    expect(h.d.running).toBe(false)
    await h.svc.unbind('p1', host)
    await expect(h.svc.authorize('p1', host, CP)).rejects.toThrow(/not set up/)
  })

  it('refuses nonsense from the channel', async () => {
    const h = harness()
    await expect(h.svc.unbind(undefined, 'x')).resolves.toBe(false)
    await expect(h.svc.unbind('p', 'h.example.com')).resolves.toBe(false)
    expect(h.calls).toEqual([])
  })
})

describe('whose process counts', () => {
  // A TEXT pin, and weaker than the behavior tests below: proving this needs a matching process owned
  // by another user, which a test without root cannot create. They do prove `-O` passes for our own.
  it('the ops script requires this user to own the process', () => {
    expect(WSL_KEEPALIVE_OPS).toContain('[ -O "$d" ] || continue')
  })
})

describe('a keepalive under a handle the records no longer know', () => {
  it('a corrupt record: the new one reuses the old keepalive instead of starting a second', async () => {
    const h = harness()
    const old = await ready(h)
    await h.svc.bind('p1', old.host)
    await h.svc.connected('p1', old.host)
    expect(h.spawned).toHaveLength(1)
    fs.writeFileSync(path.join(h.dir, old.handle, 'endpoint.json'), '{ not json')
    const next = await ready(h)
    expect(next.handle).not.toBe(old.handle)
    await h.svc.bind('p2', next.host)
    await h.svc.connected('p2', next.host)
    expect(h.spawned).toHaveLength(1)
    expect([...h.d.keepalives.values()].flat()).toHaveLength(1)
  })

  it('a lost record: turning the setting off still stops it, and only looks in running distros', async () => {
    const h = harness()
    const { host, handle } = await ready(h)
    await h.svc.bind('p1', host)
    await h.svc.connected('p1', host)
    fs.rmSync(path.join(h.dir, handle), { recursive: true })
    h.enabled.value = false
    h.calls.length = 0
    await h.svc.keepaliveSettingChanged()
    expect([...h.d.keepalives.values()].flat()).toEqual([])
    const started = h.calls.filter((c) => c.args[0] === '-d').map((c) => c.args[1])
    expect(started).toEqual(['Ubuntu'])
    expect(h.calls[0].args).toEqual(['--list', '--running', '--quiet'])
  })

  it('WSL not answering about what is running: a setting change touches nothing', async () => {
    const runningFails = { value: false }
    const h = harness({ runningFails })
    const { host } = await ready(h)
    await h.svc.bind('p1', host)
    await h.svc.connected('p1', host)
    runningFails.value = true
    const before = dCalls(h)
    h.enabled.value = false
    await h.svc.keepaliveSettingChanged()
    h.enabled.value = true
    await h.svc.keepaliveSettingChanged()
    expect(dCalls(h)).toBe(before)
  })

  it('two valid records on one distro share one keepalive, which lasts until the last project goes', async () => {
    const h = harness()
    const first = await ready(h)
    await h.svc.bind('p1', first.host)
    await h.svc.connected('p1', first.host)
    // A second record for the same distro, as a restored backup would leave.
    const handle2 = 'abcdefabcdefabcd'
    const host2 = first.host.replace(first.handle, handle2)
    fs.cpSync(path.join(h.dir, first.handle), path.join(h.dir, handle2), { recursive: true })
    const rec = JSON.parse(fs.readFileSync(path.join(h.dir, handle2, 'endpoint.json'), 'utf8'))
    fs.writeFileSync(path.join(h.dir, handle2, 'endpoint.json'), JSON.stringify({ ...rec, host: host2, projects: [] }))
    await h.svc.bind('p2', host2)
    await h.svc.connected('p2', host2)
    expect(h.spawned).toHaveLength(1)
    await h.svc.unbind('p1', first.host)
    expect([...h.d.keepalives.values()].flat()).toHaveLength(1)
    await h.svc.unbind('p2', host2)
    expect([...h.d.keepalives.values()].flat()).toEqual([])
  })
})

describe('starting the keepalive process', () => {
  it('shares no pipe with the app, and is detached', () => {
    const child = spawnKeepaliveProcess(process.execPath, ['-e', 'setTimeout(()=>{},50)']) as ChildProcess
    expect(child.pid).toBeGreaterThan(0)
    expect(child.stdin).toBeNull()
    expect(child.stdout).toBeNull()
    expect(child.stderr).toBeNull()
    expect(child.spawnargs[0]).toBe(process.execPath)
  })
})

// The real scripts, against real processes. A real distro is the measurement this file cannot make.
describe.skipIf(process.platform === 'win32')('the keepalive scripts under a real /bin/sh', () => {
  const own: ChildProcess[] = []
  afterEach(() => {
    for (const c of own.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  })
  const MARKER = wslKeepaliveMarker('0123456789abcdef')

  function start(args: string[]): ChildProcess {
    const c = spawn('/bin/sh', args, { stdio: 'ignore' })
    own.push(c)
    return c
  }
  const alive = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null

  async function op(name: 'find' | 'stop' | 'trim'): Promise<string> {
    const r = await wslRunner('/bin/sh')(['-c', WSL_KEEPALIVE_OPS, 'nodeterm-wsl-keepalive-op', name, WSL_KEEPALIVE_MARKER_PREFIX, WSL_KEEPALIVE_SCRIPT], {
      timeoutMs: 10_000
    })
    expect(r.code).toBe(0)
    return r.stdout.toString()
  }
  async function appears(c: ChildProcess): Promise<void> {
    await vi.waitFor(async () => expect(await op('find')).toContain(`keepalive=${c.pid}\n`), { timeout: 5000 })
  }

  it('finds the keepalive and stops it, with its sleep', async () => {
    const k = start(['-c', WSL_KEEPALIVE_SCRIPT, MARKER])
    await appears(k)
    expect(await op('stop')).toBe(`NTWSL stopped=${k.pid}\n`)
    await vi.waitFor(() => expect(alive(k)).toBe(false), { timeout: 5000 })
    expect(await op('find')).toBe('')
  })

  it('is not fooled: a process that only mentions the marker or the script is neither found nor stopped', async () => {
    const k = start(['-c', WSL_KEEPALIVE_SCRIPT, MARKER])
    await appears(k)
    const decoys = [
      // The right marker on another script.
      start(['-c', 'sleep 30', MARKER]),
      // Marker and script, in the wrong places.
      start(['-c', `sleep 30 # ${WSL_KEEPALIVE_SCRIPT}`, MARKER]),
      start(['-c', 'sleep 30', 'x', WSL_KEEPALIVE_SCRIPT, MARKER]),
      // One extra argument after a true copy.
      start(['-c', WSL_KEEPALIVE_SCRIPT, MARKER, 'extra']),
      // The prefix without a real handle: too short, too long, not hex, or none.
      start(['-c', WSL_KEEPALIVE_SCRIPT, wslKeepaliveMarker('0123')]),
      start(['-c', WSL_KEEPALIVE_SCRIPT, wslKeepaliveMarker('0123456789abcdef0')]),
      start(['-c', WSL_KEEPALIVE_SCRIPT, wslKeepaliveMarker('0123456789ABCDEF')]),
      start(['-c', WSL_KEEPALIVE_SCRIPT, wslKeepaliveMarker('zzzzzzzzzzzzzzzz')]),
      start(['-c', WSL_KEEPALIVE_SCRIPT, WSL_KEEPALIVE_MARKER_PREFIX]),
      // The right prefix on another script.
      start(['-c', 'sleep 30', wslKeepaliveMarker('fedcba9876543210')])
    ]
    await new Promise((r) => setTimeout(r, 150))
    expect(await op('find')).toBe(`NTWSL keepalive=${k.pid}\n`)
    await op('stop')
    await vi.waitFor(() => expect(alive(k)).toBe(false), { timeout: 5000 })
    for (const d of decoys) expect(alive(d)).toBe(true)
  })

  it('finds and stops a keepalive under any handle, which a lost record leaves behind', async () => {
    const other = start(['-c', WSL_KEEPALIVE_SCRIPT, wslKeepaliveMarker('fedcba9876543210')])
    await appears(other)
    await op('stop')
    await vi.waitFor(() => expect(alive(other)).toBe(false), { timeout: 5000 })
  })

  it('trim keeps one and stops the rest, across handles', async () => {
    const third = start(['-c', WSL_KEEPALIVE_SCRIPT, wslKeepaliveMarker('fedcba9876543210')])
    await appears(third)
    await op('trim')
    await op('stop')
  })

  it('trim keeps one and stops the rest', async () => {
    const a = start(['-c', WSL_KEEPALIVE_SCRIPT, MARKER])
    const b = start(['-c', WSL_KEEPALIVE_SCRIPT, MARKER])
    await appears(a)
    await appears(b)
    await op('trim')
    await vi.waitFor(() => expect([a, b].filter(alive)).toHaveLength(1), { timeout: 5000 })
    await op('stop')
  })

  it('ends if its sleep is killed, rather than spinning or restarting', async () => {
    const k = start(['-c', WSL_KEEPALIVE_SCRIPT, MARKER])
    await appears(k)
    const kids = await wslRunner('/bin/sh')(['-c', `cat /proc/${k.pid}/task/${k.pid}/children`], { timeoutMs: 5000 })
    const sleepPid = Number(kids.stdout.toString().trim().split(/\s+/)[0])
    expect(sleepPid).toBeGreaterThan(0)
    process.kill(sleepPid, 'SIGKILL')
    await vi.waitFor(() => expect(alive(k)).toBe(false), { timeout: 5000 })
  })
})

describe('wslRunner: the timeout is a hard limit', () => {
  it('answers on time even when another process still holds the pipe', async () => {
    // A child that leaves a grandchild holding stdout, then ignores SIGTERM. Both end by themselves.
    const script =
      `require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:'inherit',detached:true}).unref();` +
      `process.on('SIGTERM',()=>{});setTimeout(()=>{},4000)`
    const t0 = Date.now()
    const r = await wslRunner(process.execPath)(['-e', script], { timeoutMs: 400 })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.timedOut).toBe(true)
    expect(r.code).toBeNull()
  })

  it('a child that exits while another process holds the pipe reports its own exit, without waiting', async () => {
    const script =
      `process.stdout.write('NTWSL user=x\\n');` +
      `require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:'inherit',detached:true}).unref();` +
      `process.exit(0)`
    const t0 = Date.now()
    const r = await wslRunner(process.execPath)(['-e', script], { timeoutMs: 3500 })
    expect(Date.now() - t0).toBeLessThan(2500)
    expect(r).toMatchObject({ code: 0, timedOut: false })
    expect(r.stdout.toString()).toContain('NTWSL user=x')
  })

  it('reports a program that cannot start, and passes stdin through', async () => {
    const missing = await wslRunner(path.join(testTmpDir('nt-wsl-'), 'no-such-program'))([], { timeoutMs: 2000 })
    expect(missing.code).toBeNull()
    expect(missing.stderr.toString()).toContain('ENOENT')
    const echo = await wslRunner(process.execPath)(['-e', 'process.stdin.pipe(process.stdout)'], { timeoutMs: 5000, stdin: 'body' })
    expect(echo.stdout.toString()).toBe('body')
  })
})

describe('local records and keys recover by themselves', () => {
  it('a corrupt record for the distro is skipped, not fatal', async () => {
    const h = harness()
    const { handle, host } = await ready(h)
    const file = path.join(h.dir, handle, 'endpoint.json')
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...rec, host: 'garbage' }))
    const again = await h.svc.prepare('Ubuntu', BROWSE)
    expect(again.ok).toBe(true)
    expect((again as { server: { host: string } }).server.host).not.toBe(host)
  })

  it('a lost public key is rebuilt from the private key, keeping the login', async () => {
    const h = harness()
    const { handle } = await ready(h)
    const authorized = h.d.files.get(`${WSL_SSHD_DIR}/authorized_keys`)
    fs.rmSync(path.join(h.dir, handle, 'id_ed25519.pub'))
    expect((await h.svc.prepare('Ubuntu', BROWSE)).ok).toBe(true)
    expect(fs.readFileSync(path.join(h.dir, handle, 'id_ed25519.pub'), 'utf8').trim()).toBe(authorized?.trim())
    expect(h.d.files.get(`${WSL_SSHD_DIR}/authorized_keys`)).toBe(authorized)
  })

  it('a lost private key gets a new pair, and the distro is told, on the setup path', async () => {
    const h = harness()
    const { handle } = await ready(h)
    const authorized = h.d.files.get(`${WSL_SSHD_DIR}/authorized_keys`)
    fs.rmSync(path.join(h.dir, handle, 'id_ed25519'))
    expect((await h.svc.prepare('Ubuntu', BROWSE)).ok).toBe(true)
    expect(fs.existsSync(path.join(h.dir, handle, 'id_ed25519'))).toBe(true)
    expect(h.d.files.get(`${WSL_SSHD_DIR}/authorized_keys`)).not.toBe(authorized)
    expect(h.d.files.get(`${WSL_SSHD_DIR}/authorized_keys`)?.trim()).toBe(fs.readFileSync(path.join(h.dir, handle, 'id_ed25519.pub'), 'utf8').trim())
  })

  it('a private key lost between checks heals on the connect path too, inside the 30 s window', async () => {
    const h = harness()
    const { handle, host } = await ready(h)
    await h.svc.bind('p1', host)
    await h.svc.authorize('p1', host, CP)
    const authorized = h.d.files.get(`${WSL_SSHD_DIR}/authorized_keys`)
    fs.rmSync(path.join(h.dir, handle, 'id_ed25519'))
    await h.svc.resolve({ host, user: 'dev' }, { controlPath: CP })
    expect(fs.existsSync(path.join(h.dir, handle, 'id_ed25519'))).toBe(true)
    expect(h.d.files.get(`${WSL_SSHD_DIR}/authorized_keys`)).not.toBe(authorized)
  })
})

describe('authorized_keys is compared whole', () => {
  it('a key planted after ours is removed, not hidden behind the first line', async () => {
    const h = harness()
    await ready(h)
    const ours = h.d.files.get(`${WSL_SSHD_DIR}/authorized_keys`) as string
    h.d.files.set(`${WSL_SSHD_DIR}/authorized_keys`, `${ours}${ed25519KeyPair().public}\n`)
    await h.svc.prepare('Ubuntu', BROWSE)
    expect(h.d.files.get(`${WSL_SSHD_DIR}/authorized_keys`)).toBe(ours)
  })
})

describe('moving the pin survives a run that stops partway', () => {
  it('a reinstalled distro whose setup failed after the key landed recovers on the next connect', async () => {
    const h = harness()
    await ready(h)
    h.d.files.clear()
    h.failWrite.name = 'sshd_config'
    const failed = await h.svc.prepare('Ubuntu', BROWSE)
    expect(failed).toMatchObject({ ok: false, code: 'setup-failed' })
    expect(h.d.files.get(`${WSL_SSHD_DIR}/host_ed25519`)).toBeTruthy()
    h.failWrite.name = undefined
    const next = await h.svc.prepare('Ubuntu', BROWSE)
    expect(next.ok).toBe(true)
    expect(h.d.files.get(`${WSL_SSHD_DIR}/sshd_config`)).toBe(wslSshdConfig('/home/dev'))
  })

  it('a key this code did not generate is still refused during that recovery', async () => {
    const h = harness()
    await ready(h)
    h.d.files.clear()
    h.failWrite.name = 'sshd_config'
    await h.svc.prepare('Ubuntu', BROWSE)
    h.failWrite.name = undefined
    const planted = ed25519KeyPair()
    h.d.files.set(`${WSL_SSHD_DIR}/host_ed25519`, planted.private)
    h.d.files.set(`${WSL_SSHD_DIR}/host_ed25519.pub`, planted.public)
    await expect(h.svc.prepare('Ubuntu', BROWSE)).resolves.toMatchObject({ ok: false, code: 'host-key-changed' })
  })
})

describe('a stuck distro’s advice', () => {
  it('names this distro only, and does not suggest stopping all of WSL', async () => {
    const dir = testTmpDir('nt-wsl-')
    const run: WslRun = async (args) =>
      args[0] === '--list'
        ? { ...ok(''), stdout: Buffer.from('My Distro\r\n', 'utf16le') }
        : { code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: true }
    const svc = new WslEndpoints({ dir, run, platform: 'win32', env: WIN_ENV, atomicWrite: remoteAtomicWrite, restrictDir: async () => {} })
    const r = (await svc.prepare('My Distro', BROWSE)) as { error: string }
    expect(r.error).toContain('wsl --terminate "My Distro"')
    expect(r.error).not.toContain('--shutdown')
  })
})

describe('Windows key directory access', () => {
  it('is restricted before any key lands in it, once per run', async () => {
    const h = harness()
    const { handle } = await ready(h)
    expect(h.acl).toEqual([path.join(h.dir, handle)])
    await h.svc.prepare('Ubuntu', BROWSE)
    expect(h.acl).toHaveLength(1)
  })

  it('a failed restriction is named in the log and does not stop setup', async () => {
    const logs: string[] = []
    const h = harness()
    const svc = new WslEndpoints({
      dir: testTmpDir('nt-wsl-'),
      run: async (args, o) => (args[0] === '--list' ? { ...ok(''), stdout: Buffer.from('Ubuntu\r\n', 'utf16le') } : harnessRun(h, args, o)),
      platform: 'win32',
      env: WIN_ENV,
      atomicWrite: remoteAtomicWrite,
      restrictDir: async () => {
        throw new Error('Access is denied.')
      },
      log: (l) => logs.push(l)
    })
    expect((await svc.prepare('Ubuntu', BROWSE)).ok).toBe(true)
    expect(logs.join('\n')).toMatch(/left .* unchanged.*Access is denied/)
  })

  it('fixed paths and one argv element per argument, whatever the environment says', () => {
    const hostile = { SystemRoot: 'C:\\Evil', PATH: 'D:\\Evil' }
    expect(icaclsExe(hostile)).toBe('C:\\Windows\\System32\\icacls.exe')
    expect(whoamiExe(hostile)).toBe('C:\\Windows\\System32\\whoami.exe')
    expect(WHOAMI_SID_ARGS).toEqual(['/user', '/fo', 'csv', '/nh'])
  })

  it('grants by the current user’s SID, read from whoami, never by name', async () => {
    const calls: [string, string[]][] = []
    const exec = async (file: string, args: string[]): Promise<string> => {
      calls.push([file, args])
      return file.endsWith('whoami.exe') ? '"CORP\\alice","S-1-5-21-111-222-333-1001"\r\n' : 'processed 1 file\r\n'
    }
    await restrictWindowsDir('C:\\Users\\A B\\x', WIN_ENV, exec)
    expect(calls).toEqual([
      ['C:\\Windows\\System32\\whoami.exe', ['/user', '/fo', 'csv', '/nh']],
      ['C:\\Windows\\System32\\icacls.exe', ['C:\\Users\\A B\\x', '/inheritance:r', '/grant:r', '*S-1-5-21-111-222-333-1001:(OI)(CI)F']]
    ])
  })

  it.each([
    ['empty', ''],
    ['no SID', '"CORP\\alice","alice"'],
    ['not csv', 'CORP\\alice S-1-5-21-1-2'],
    ['two lines', '"a","S-1-5-21-1"\r\n"b","S-1-5-21-2"'],
    ['a SID with something after it', '"a","S-1-5-21-1:(F) x"'],
    ['an option in place of a SID', '"a","/grant:r"']
  ])('%s from whoami: icacls never runs, so the directory is untouched', async (_n, out) => {
    expect(parseWhoamiSid(out)).toBeNull()
    const ran: string[] = []
    const exec = async (file: string): Promise<string> => {
      ran.push(file)
      return out
    }
    await expect(restrictWindowsDir('C:\\x', WIN_ENV, exec)).rejects.toThrow(/did not report a SID/)
    expect(ran).toEqual(['C:\\Windows\\System32\\whoami.exe'])
  })

  it('whoami failing to run leaves the directory untouched too', async () => {
    const ran: string[] = []
    const exec = async (file: string): Promise<string> => {
      ran.push(file)
      throw new Error('ENOENT')
    }
    await expect(restrictWindowsDir('C:\\x', WIN_ENV, exec)).rejects.toThrow('ENOENT')
    expect(ran).toHaveLength(1)
  })

  it('POSIX never runs it', async () => {
    const restrictDir = vi.fn(async () => {})
    const svc = new WslEndpoints({
      dir: testTmpDir('nt-wsl-'),
      run: async (args, o) =>
        args[0] === '--list' ? { ...ok(''), stdout: Buffer.from('Ubuntu\r\n', 'utf16le') } : harnessRun(harness(), args, o),
      platform: 'linux',
      env: { NODETERM_NATIVE_SSH: '1', NODETERM_WSL_PROJECTS: '1' },
      atomicWrite: remoteAtomicWrite,
      restrictDir
    })
    // All the way through setup, so the step is reached and declined rather than never reached.
    expect((await svc.prepare('Ubuntu', BROWSE)).ok).toBe(true)
    expect(restrictDir).not.toHaveBeenCalled()
  })
})

/** The harness's distro behind another service's `run`, for tests that vary only the seams. */
function harnessRun(h: Harness, args: string[], o: { timeoutMs: number; stdin?: string }): ReturnType<WslRun> {
  const script = args[5]
  if (script === WSL_PROBE_SCRIPT) {
    return Promise.resolve(ok(`NTWSL user=dev\nNTWSL home=/home/dev\nNTWSL sshd=/usr/sbin/sshd\nNTWSL tmux=1\nNTWSL curl=1\nNTWSL instance=b:1\n`))
  }
  void h
  void o
  return Promise.resolve(ok(''))
}
