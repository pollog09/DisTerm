// WSL projects through the real transport: NativeMux, its handshake and ssh2's own Server, with a
// scripted distro behind the `wsl.exe` seam, so every rule here runs on any CI host. The real shell
// scripts run under /bin/sh at the end (POSIX only). There is no sshd or wsl.exe in this file. What was
// measured against both is recorded in CLAUDE.md, "WSL projects".

import { spawn } from 'child_process'
import fs from 'fs'
import net, { type AddressInfo } from 'net'
import path from 'path'
import { Server, utils, type Connection } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { childArgs, exitMasterArgs, hookForwardArgs } from '../../core/remote-ssh/control-master'
import { testTmpDir } from '../../core/test-tmp'
import { remoteAtomicWrite } from '../remote-atomic-write'
import { NativeMux, channelExit } from '../../core/remote-ssh/native/native-mux'
import { runScpArgv, runSshArgv } from '../../core/remote-ssh/native/native-invoke'
import { parseSshG } from '../../core/remote-ssh/native/ssh-config'
import { parseSshArgv } from '../../core/remote-ssh/native/ssh-argv'
import { ed25519KeyPair } from '../../core/remote-ssh/native/test-keys'
import {
  WSL_PROBE_SCRIPT,
  WSL_SSHD_DIR,
  WSL_SSHD_LAUNCH,
  WslEndpoints,
  isValidDistroName,
  parseWslProbe,
  wslInstallCommand,
  wslProgram,
  wslProjectsAvailable,
  wslSshdConfig,
  type WslRun
} from '../../core/remote-ssh/native/wsl-endpoint'
import type { ProxySpawn } from '../../core/remote-ssh/native/proxy-command'
import { formatCksum, posixCksum } from '../../core/remote-ssh/posix-cksum'
import { isWslHost, type WslPrepareResult } from '../../shared/wsl-project'
import type { SshServer } from '../../shared/ssh'

const WIN_ENV = { SystemRoot: 'C:\\Windows' }

interface FakeDistro {
  files: Map<string, string>
  tools: { sshd: boolean; tmux: boolean; curl: boolean }
  pm: string
  user: string
  home: string
  instance: string
}

function fakeDistro(over: Partial<FakeDistro> = {}): FakeDistro {
  return {
    files: new Map(),
    tools: { sshd: true, tmux: true, curl: true },
    pm: 'apt-get',
    user: 'dev',
    home: '/home/dev',
    instance: 'boot:1',
    ...over
  }
}

/** Plays wsl.exe: answers the listing and the probe, and applies writes from the real write command. */
function fakeWsl(distros: Record<string, FakeDistro>, opts: { list?: Buffer } = {}) {
  const calls: { args: string[]; stdin?: string }[] = []
  const run: WslRun = async (args, o) => {
    calls.push({ args, stdin: o.stdin })
    const ok = (out: string) => ({ code: 0, stdout: Buffer.from(out), stderr: Buffer.alloc(0), timedOut: false })
    if (args[0] === '--list') {
      return { ...ok(''), stdout: opts.list ?? Buffer.from(`${Object.keys(distros).join('\r\n')}\r\n`, 'utf16le') }
    }
    expect(args[0]).toBe('-d')
    expect(args.slice(2, 5)).toEqual(['--exec', 'sh', '-c'])
    const d = distros[args[1]]
    if (!d) {
      return { code: 1, stdout: Buffer.from('There is no distribution with the supplied name.\r\n', 'utf16le'), stderr: Buffer.alloc(0), timedOut: false }
    }
    const script = args[5]
    if (script === WSL_PROBE_SCRIPT) {
      const dir = `${WSL_SSHD_DIR}/`
      const f = (n: string): string => d.files.get(dir + n) ?? ''
      const config = f('sshd_config')
      const lines: Record<string, string> = {
        user: d.user,
        home: d.home,
        sshd: d.tools.sshd ? '/usr/sbin/sshd' : '',
        tmux: d.tools.tmux ? '1' : '0',
        curl: d.tools.curl ? '1' : '0',
        pm: d.pm,
        hostkey: f('host_ed25519.pub').trim(),
        hostpriv: f('host_ed25519') ? '1' : '0',
        authorized: f('authorized_keys') ? formatCksum(posixCksum(Buffer.from(f('authorized_keys')))) : '',
        config: config ? formatCksum(posixCksum(Buffer.from(config))) : '',
        instance: d.instance
      }
      return ok(Object.entries(lines).map(([k, v]) => `NTWSL ${k}=${v}\n`).join(''))
    }
    if (script.startsWith('umask 077; mkdir') && !script.includes('mv -f')) return ok('')
    const target = /mv -f -- \S+ (\S+?);/.exec(script)?.[1]
    if (target && o.stdin !== undefined) {
      const rel = target.replace(/^~\//, '').replace(/'/g, '')
      d.files.set(rel, o.stdin)
      return ok('')
    }
    throw new Error(`unexpected script: ${script.slice(0, 80)}`)
  }
  return { run, calls }
}

function service(distros: Record<string, FakeDistro>, over: { dir?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; list?: Buffer } = {}) {
  const wsl = fakeWsl(distros, { list: over.list })
  const dir = over.dir ?? testTmpDir('nt-wsl-endpoint-')
  const svc = new WslEndpoints({
    dir,
    run: wsl.run,
    platform: over.platform ?? 'win32',
    env: over.env ?? WIN_ENV,
    atomicWrite: remoteAtomicWrite,
    generateKeyPair: () => ed25519KeyPair()
  })
  return { svc, dir, ...wsl }
}

const BROWSE = 'ssh-browse-test'

async function prepared(svc: WslEndpoints, distro = 'Ubuntu'): Promise<Extract<WslPrepareResult, { ok: true }>> {
  const r = await svc.prepare(distro, BROWSE)
  if (!r.ok) throw new Error(r.error)
  return r
}

interface Peer {
  server: Server
  port: number
  logins: number
  live: Connection[]
  offered: Buffer[]
}

const peers: Peer[] = []
const muxes: NativeMux[] = []

afterEach(async () => {
  for (const m of muxes.splice(0)) m.exitAll()
  for (const p of peers.splice(0)) {
    for (const c of p.live) c.end()
    await new Promise((r) => p.server.close(r))
  }
})

/** An SSH server standing where sshd would, with the distro's host key and authorized key. */
function startPeer(hostKeyPrivate: string, authorizedPub: string): Promise<Peer> {
  const wanted = utils.parseKey(authorizedPub)
  const accept = (Array.isArray(wanted) ? wanted[0] : wanted) as ReturnType<typeof utils.parseKey> & { getPublicSSH(): Buffer }
  const peer: Peer = { server: null as unknown as Server, port: 0, logins: 0, live: [], offered: [] }
  peer.server = new Server({ hostKeys: [hostKeyPrivate] }, (client) => {
    peer.live.push(client)
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey'])
      peer.offered.push(ctx.key.data)
      return ctx.key.data.equals(accept.getPublicSSH()) ? ctx.accept() : ctx.reject(['publickey'])
    })
    client.on('ready', () => {
      peer.logins++
      client.on('session', (a) => {
        const session = a()
        session.on('exec', (acc, _r, info) => {
          const ch = acc()
          ch.write(`ran: ${info.command}\n`)
          ch.exit(0)
          ch.end()
        })
      })
    })
    client.on('error', () => {})
  })
  peers.push(peer)
  return new Promise((r) =>
    peer.server.listen(0, '127.0.0.1', () => {
      peer.port = (peer.server.address() as AddressInfo).port
      r(peer)
    })
  )
}

/** Plays the wsl.exe child: records its argv, and carries its stdio to the peer. */
function proxyTo(peer: () => Peer): { spawned: { file: string; args: string[]; verbatim: boolean }[]; spawnProxy: ProxySpawn } {
  const spawned: { file: string; args: string[]; verbatim: boolean }[] = []
  return {
    spawned,
    spawnProxy: (file, args, opts) => {
      spawned.push({ file, args, verbatim: opts.verbatim })
      const script = `const s=require('net').connect(${peer().port},'127.0.0.1');process.stdin.pipe(s).pipe(process.stdout)`
      return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
    }
  }
}

function muxFor(svc: WslEndpoints, spawnProxy: ProxySpawn): NativeMux {
  const m = new NativeMux({
    defaultAgent: () => '/never/an/agent.sock',
    spawnProxy,
    platform: 'linux',
    resolveHost: (t, ctx) => svc.resolve(t, ctx)
  })
  muxes.push(m)
  return m
}

const CP = '/cm/project.sock'

function execArgv(server: SshServer, cp = CP, command = 'echo hi'): string[] {
  return childArgs(server, cp, command)
}

async function readyPeer(dir: string, distro: FakeDistro, server: SshServer): Promise<Peer> {
  const handle = /-([a-f0-9]{16})\.wsl\./.exec(server.host)?.[1] as string
  const pub = fs.readFileSync(path.join(dir, handle, 'id_ed25519.pub'), 'utf8')
  return startPeer(distro.files.get(`${WSL_SSHD_DIR}/host_ed25519`) as string, pub)
}

describe('what may host a WSL project', () => {
  it('is Windows, and a POSIX machine only when both test switches are on', () => {
    expect(wslProjectsAvailable('win32', {})).toBe(true)
    expect(wslProjectsAvailable('linux', {})).toBe(false)
    expect(wslProjectsAvailable('linux', { NODETERM_NATIVE_SSH: '1' })).toBe(false)
    expect(wslProjectsAvailable('linux', { NODETERM_WSL_PROJECTS: '1' })).toBe(false)
    expect(wslProjectsAvailable('linux', { NODETERM_NATIVE_SSH: '1', NODETERM_WSL_PROJECTS: '1' })).toBe(true)
    expect(wslProjectsAvailable('win32', { NODETERM_NATIVE_SSH: '0' })).toBe(false)
  })

  it('on Windows the program is a fixed path no environment value can move', () => {
    const hostile = { SystemRoot: 'C:\\Evil', WINDIR: 'D:\\Evil', ComSpec: 'evil.exe', PATH: 'D:\\Evil', NODETERM_WSL_PROJECTS: '1' }
    expect(wslProgram('win32', hostile)).toBe('C:\\Windows\\System32\\wsl.exe')
    expect(wslProgram('win32', { SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\wsl.exe')
  })

  it('a POSIX core with no switch lists nothing and runs nothing', async () => {
    const { svc, calls } = service({ Ubuntu: fakeDistro() }, { platform: 'linux', env: {} })
    await expect(svc.list()).resolves.toEqual({ available: false, distros: [] })
    await expect(svc.prepare('Ubuntu', BROWSE)).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(calls).toEqual([])
  })

  it('never offers docker-desktop, and listing starts no distro', async () => {
    const { svc, calls } = service({}, { list: Buffer.from('Ubuntu\r\ndocker-desktop\r\nUbuntu 24.04\r\n', 'utf16le') })
    await expect(svc.list()).resolves.toEqual({ available: true, distros: ['Ubuntu', 'Ubuntu 24.04'] })
    expect(calls.map((c) => c.args)).toEqual([['--list', '--quiet']])
  })

  it('refuses a name that would read as an option or carries a control character', () => {
    expect(isValidDistroName('Ubuntu 24.04')).toBe(true)
    expect(isValidDistroName('%PATH%&calc')).toBe(true)
    expect(isValidDistroName('-d')).toBe(false)
    expect(isValidDistroName('a\nb')).toBe(false)
    expect(isValidDistroName('')).toBe(false)
    expect(isValidDistroName(undefined)).toBe(false)
  })
})

describe('setting up a distro', () => {
  it('starts only the distro the user chose, and only one WSL lists', async () => {
    const { svc, calls } = service({ Ubuntu: fakeDistro(), 'RedHatEnterpriseLinux-9.8': fakeDistro() })
    await prepared(svc, 'Ubuntu')
    const started = calls.filter((c) => c.args[0] === '-d').map((c) => c.args[1])
    expect(new Set(started)).toEqual(new Set(['Ubuntu']))

    const quiet = service({ Ubuntu: fakeDistro() })
    await expect(quiet.svc.prepare('Debian', BROWSE)).resolves.toMatchObject({ ok: false, code: 'not-installed' })
    expect(quiet.calls.filter((c) => c.args[0] === '-d')).toEqual([])
  })

  it('writes the sshd config, and sends private keys over stdin, never on an argv', async () => {
    const d = fakeDistro()
    const { svc, calls, dir } = service({ Ubuntu: d })
    const r = await prepared(svc)
    expect(d.files.get(`${WSL_SSHD_DIR}/sshd_config`)).toBe(wslSshdConfig('/home/dev'))
    const hostKey = d.files.get(`${WSL_SSHD_DIR}/host_ed25519`) as string
    expect(hostKey).toContain('OPENSSH PRIVATE KEY')
    const handle = /-([a-f0-9]{16})\.wsl\./.exec(r.server.host)?.[1] as string
    const clientPrivate = fs.readFileSync(path.join(dir, handle, 'id_ed25519'), 'utf8')
    // The client's private key never goes to the distro at all, only its public half.
    expect(d.files.get(`${WSL_SSHD_DIR}/authorized_keys`)).toBe(fs.readFileSync(path.join(dir, handle, 'id_ed25519.pub'), 'utf8'))
    for (const c of calls) {
      expect(c.args.join(' ')).not.toContain('PRIVATE KEY')
      expect(c.stdin ?? '').not.toContain(clientPrivate.trim())
    }
    expect(r.server).toMatchObject({ user: 'dev', port: 22, label: 'WSL: Ubuntu', wslDistro: 'Ubuntu' })
    expect(isWslHost(r.server.host)).toBe(true)
    // Keys belong to the endpoint: the connection object carries none of them.
    expect(r.server.identityFile).toBeUndefined()
    expect(r.server.extraArgs).toBeUndefined()
  })

  it('every write uses the shared atomic-write command with a private mode', async () => {
    const { svc, calls } = service({ Ubuntu: fakeDistro() })
    await prepared(svc)
    const writes = calls.filter((c) => c.stdin)
    expect(writes.map((c) => /mv -f -- \S+ (\S+?);/.exec(c.args[5])?.[1])).toEqual(
      ['host_ed25519', 'host_ed25519.pub', 'authorized_keys', 'sshd_config'].map((n) => `~/'${WSL_SSHD_DIR}/${n}'`)
    )
    for (const w of writes) {
      expect(w.args[5]).toContain('umask 077')
      expect(w.args[5]).toContain('chmod 600')
    }
  })

  it.skipIf(process.platform === 'win32')('keeps local keys private: 0600 files in a 0700 directory', async () => {
    const { svc, dir } = service({ Ubuntu: fakeDistro() })
    const r = await prepared(svc)
    const handle = /-([a-f0-9]{16})\.wsl\./.exec(r.server.host)?.[1] as string
    const mode = (p: string): number => fs.statSync(p).mode & 0o777
    expect(mode(path.join(dir, handle))).toBe(0o700)
    for (const f of ['id_ed25519', 'id_ed25519.pub', 'endpoint.json']) {
      expect(mode(path.join(dir, handle, f))).toBe(0o600)
    }
  })

  it('a second setup of a healthy distro writes nothing and keeps its keys and host', async () => {
    const d = fakeDistro()
    const { svc, calls } = service({ Ubuntu: d })
    const first = await prepared(svc)
    const hostKey = d.files.get(`${WSL_SSHD_DIR}/host_ed25519`)
    const before = calls.length
    const second = await prepared(svc)
    expect(second.server.host).toBe(first.server.host)
    expect(calls.slice(before).filter((c) => c.stdin)).toEqual([])
    expect(d.files.get(`${WSL_SSHD_DIR}/host_ed25519`)).toBe(hostKey)
  })

  it('repairs a config that differs without touching the host key', async () => {
    const d = fakeDistro()
    const { svc } = service({ Ubuntu: d })
    await prepared(svc)
    const hostKey = d.files.get(`${WSL_SSHD_DIR}/host_ed25519`)
    d.files.set(`${WSL_SSHD_DIR}/sshd_config`, 'PasswordAuthentication yes\n')
    await prepared(svc)
    expect(d.files.get(`${WSL_SSHD_DIR}/sshd_config`)).toBe(wslSshdConfig('/home/dev'))
    expect(d.files.get(`${WSL_SSHD_DIR}/host_ed25519`)).toBe(hostKey)
  })

  it('names a missing sshd with the install command, and never runs it', async () => {
    const { svc, calls } = service({ Ubuntu: fakeDistro({ tools: { sshd: false, tmux: true, curl: true } }) })
    const r = await svc.prepare('Ubuntu', BROWSE)
    expect(r).toMatchObject({ ok: false, code: 'sshd-missing', install: 'sudo apt install openssh-server' })
    expect((r as { error: string }).error).toContain('sudo apt install openssh-server')
    for (const c of calls) expect(c.args.join(' ')).not.toMatch(/\b(sudo|apt|dnf|pacman|zypper|apk add)\b.*install/)
  })

  it('names missing tmux and curl, and the project still opens', async () => {
    const { svc, calls } = service({ Ubuntu: fakeDistro({ pm: 'dnf', tools: { sshd: true, tmux: false, curl: false } }) })
    const r = await prepared(svc)
    expect(r.warnings.map((w) => [w.kind, w.install])).toEqual([
      ['tmux', 'sudo dnf install tmux'],
      ['curl', 'sudo dnf install curl']
    ])
    expect(svc.warningsFor(r.server.host)).toEqual(r.warnings)
    for (const c of calls) expect(c.args.join(' ')).not.toMatch(/\bsudo\b/)
  })

  it('knows the OpenSSH package name of each package manager', () => {
    expect(wslInstallCommand('apt-get', 'sshd')).toBe('sudo apt install openssh-server')
    expect(wslInstallCommand('pacman', 'sshd')).toBe('sudo pacman -S openssh')
    expect(wslInstallCommand('zypper', 'sshd')).toBe('sudo zypper install openssh')
    expect(wslInstallCommand('apk', 'tmux')).toBe('sudo apk add tmux')
    expect(wslInstallCommand('', 'curl')).toContain('package manager')
  })

  it('bounds every wsl.exe call, and a distro that hangs is a named failure', async () => {
    const timeouts: number[] = []
    const wsl = fakeWsl({ Stuck: fakeDistro() })
    const run: WslRun = async (args, o) => {
      timeouts.push(o.timeoutMs)
      if (args[0] === '-d') return { code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: true }
      return wsl.run(args, o)
    }
    const svc = new WslEndpoints({ dir: testTmpDir('nt-wsl-'), run, platform: 'win32', env: WIN_ENV, atomicWrite: remoteAtomicWrite })
    const r = await svc.prepare('Stuck', BROWSE)
    expect(r).toMatchObject({ ok: false, code: 'distro-timeout' })
    expect((r as { error: string }).error).toContain('Stuck')
    expect(timeouts.every((t) => t > 0 && t <= 60_000)).toBe(true)
    expect(timeouts.length).toBeGreaterThan(1)
  })

  it('reads wsl.exe’s own UTF-16 error', async () => {
    const wsl = fakeWsl({ Ubuntu: fakeDistro() })
    const run: WslRun = async (args, o) =>
      args[0] === '-d'
        ? { code: 1, stdout: Buffer.from('The distribution failed to start.\r\n', 'utf16le'), stderr: Buffer.alloc(0), timedOut: false }
        : wsl.run(args, o)
    const svc = new WslEndpoints({ dir: testTmpDir('nt-wsl-'), run, platform: 'win32', env: WIN_ENV, atomicWrite: remoteAtomicWrite })
    const r = await svc.prepare('Ubuntu', BROWSE)
    expect(r).toMatchObject({ ok: false, code: 'distro-failed' })
    expect((r as { error: string }).error).toContain('The distribution failed to start.')
  })

  it('finds its answers when wsl.exe mixes a UTF-16 notice into stdout', () => {
    const notice = Buffer.from('wsl: a localhost proxy was detected\r\n', 'utf16le')
    const probe = parseWslProbe(Buffer.concat([notice, Buffer.from('NTWSL user=dév\nNTWSL home=/home/dév\nNTWSL tmux=1\n')]))
    expect(probe).toMatchObject({ user: 'dév', home: '/home/dév', tmux: true, curl: false })
    expect(parseWslProbe(notice)).toBeNull()
  })

  it('refuses a home that is not a plain path instead of writing a config from it', async () => {
    const d = fakeDistro({ home: '/home/dev"\nPermitRootLogin yes' })
    const { svc } = service({ Ubuntu: d })
    await expect(svc.prepare('Ubuntu', BROWSE)).resolves.toMatchObject({ ok: false, code: 'setup-failed' })
    expect(d.files.size).toBe(0)
  })

  it('says so when WSL restarted the distro between connections', async () => {
    const d = fakeDistro()
    const { svc } = service({ Ubuntu: d })
    await expect(prepared(svc)).resolves.toMatchObject({ warnings: [] })
    await expect(prepared(svc)).resolves.toMatchObject({ warnings: [] })
    d.instance = 'boot:2'
    const r = await prepared(svc)
    expect(r.warnings.map((w) => w.kind)).toEqual(['distro-restarted'])
    expect((await prepared(svc)).warnings).toEqual([])
  })

  it('only refreshes the distro check on a new connection every so often', async () => {
    const d = fakeDistro()
    const { svc, calls } = service({ Ubuntu: d })
    const { server } = await prepared(svc)
    await svc.authorize(BROWSE, server.host, CP)
    const before = calls.length
    await svc.resolve({ host: server.host, user: 'dev' }, { controlPath: CP })
    await svc.resolve({ host: server.host, user: 'dev' }, { controlPath: CP })
    expect(calls.length).toBe(before)
  })
})

describe('the host key pin', () => {
  it('refuses a distro whose host key changed, and adopts nothing', async () => {
    const d = fakeDistro()
    const { svc } = service({ Ubuntu: d })
    const { server } = await prepared(svc)
    const other = ed25519KeyPair()
    d.files.set(`${WSL_SSHD_DIR}/host_ed25519`, other.private)
    d.files.set(`${WSL_SSHD_DIR}/host_ed25519.pub`, other.public)
    const r = await svc.prepare('Ubuntu', BROWSE)
    expect(r).toMatchObject({ ok: false, code: 'host-key-changed' })
    // A new connection is refused the same way, and the distro's new key was not recorded.
    await svc.authorize(BROWSE, server.host, CP)
    const later = await svc.prepare('Ubuntu', BROWSE)
    expect(later).toMatchObject({ ok: false, code: 'host-key-changed' })
  })

  it('does not adopt a key already in the distro when this computer has no record of it', async () => {
    const planted = ed25519KeyPair()
    const d = fakeDistro()
    d.files.set(`${WSL_SSHD_DIR}/host_ed25519`, planted.private)
    d.files.set(`${WSL_SSHD_DIR}/host_ed25519.pub`, planted.public)
    const { svc, dir } = service({ Ubuntu: d })
    const { server } = await prepared(svc)
    expect(d.files.get(`${WSL_SSHD_DIR}/host_ed25519`)).not.toBe(planted.private)
    const handle = /-([a-f0-9]{16})\.wsl\./.exec(server.host)?.[1] as string
    const rec = JSON.parse(fs.readFileSync(path.join(dir, handle, 'endpoint.json'), 'utf8'))
    expect(rec.hostKeyPublic).not.toContain(planted.public.split(' ')[1])
    expect(rec.hostKeyPublic).toBe((d.files.get(`${WSL_SSHD_DIR}/host_ed25519.pub`) as string).trim())
  })

  it('pins a new key for a reinstalled distro, which has none to compare', async () => {
    const d = fakeDistro()
    const { svc } = service({ Ubuntu: d })
    await prepared(svc)
    const old = d.files.get(`${WSL_SSHD_DIR}/host_ed25519`)
    d.files.clear()
    await prepared(svc)
    expect(d.files.get(`${WSL_SSHD_DIR}/host_ed25519`)).not.toBe(old)
    expect(d.files.get(`${WSL_SSHD_DIR}/sshd_config`)).toBe(wslSshdConfig('/home/dev'))
  })

  it('the handshake refuses any other key, naming it, and logs nobody in', async () => {
    const d = fakeDistro()
    const { svc, dir } = service({ Ubuntu: d })
    const { server } = await prepared(svc)
    await svc.bind('p1', server.host)
    await svc.authorize('p1', server.host, CP)
    const handle = /-([a-f0-9]{16})\.wsl\./.exec(server.host)?.[1] as string
    const pub = fs.readFileSync(path.join(dir, handle, 'id_ed25519.pub'), 'utf8')
    // An impostor on the far end of the stdio, holding its own key but the right login.
    const impostor = await startPeer(ed25519KeyPair().private, pub)
    const { spawnProxy } = proxyTo(() => impostor)
    const r = await runSshArgv(muxFor(svc, spawnProxy), execArgv(server))
    expect(r.code).toBe(255)
    expect(r.stderr.toString()).toMatch(/WSL Ubuntu: the SSH host key does not match/)
    expect(impostor.logins).toBe(0)
  })
})

describe('the transport comes only from trusted local code', () => {
  async function connected(distroName = 'Ubuntu') {
    const d = fakeDistro()
    const s = service({ [distroName]: d })
    const { server } = await prepared(s.svc, distroName)
    await s.svc.bind('p1', server.host)
    await s.svc.authorize('p1', server.host, CP)
    const peer = await readyPeer(s.dir, d, server)
    const proxy = proxyTo(() => peer)
    return { ...s, d, server, peer, ...proxy, mux: muxFor(s.svc, proxy.spawnProxy) }
  }

  it('runs a command over wsl.exe: the whole path, end to end', async () => {
    const { mux, server, peer, spawned } = await connected()
    const r = await runSshArgv(mux, execArgv(server))
    expect(r.code).toBe(0)
    expect(r.stdout.toString()).toContain('ran: echo hi')
    expect(peer.logins).toBe(1)
    expect(spawned).toEqual([
      {
        file: 'C:\\Windows\\System32\\wsl.exe',
        args: ['-d', 'Ubuntu', '--exec', 'sh', '-c', WSL_SSHD_LAUNCH, 'nodeterm-wsl-sshd'],
        verbatim: false
      }
    ])
  })

  it.each(['Ubuntu 24.04', 'My "Distro"', '%PATH%&calc', "it's^|mine"])(
    'carries the distro name %s as one argv element, with no cmd.exe to reinterpret it',
    async (name) => {
      const { mux, server, spawned } = await connected(name)
      expect((await runSshArgv(mux, execArgv(server))).code).toBe(0)
      expect(spawned[0].args.slice(0, 2)).toEqual(['-d', name])
      expect(spawned[0].file).not.toMatch(/cmd\.exe/i)
      expect(spawned[0].verbatim).toBe(false)
    }
  )

  it('ignores the identity and agent the argv names: the record’s key is the only one offered', async () => {
    const { mux, server, peer, dir } = await connected()
    const stranger = path.join(dir, 'stranger')
    fs.writeFileSync(stranger, ed25519KeyPair().private, { mode: 0o600 })
    const hostile = { ...server, identityFile: stranger, identityAgentSock: '/evil/agent.sock' }
    const r = await runSshArgv(mux, execArgv(hostile))
    expect(r.code).toBe(0)
    // ssh2 asks about a key, then signs with it: one key, offered twice.
    expect(new Set(peer.offered.map((k) => k.toString('hex'))).size).toBe(1)
  })

  it('takes the distro from the record, never from the connection', async () => {
    const { mux, server, spawned } = await connected()
    const r = await runSshArgv(mux, execArgv({ ...server, wslDistro: 'Evil' }))
    expect(r.code).toBe(0)
    expect(spawned[0].args[1]).toBe('Ubuntu')
  })

  it('an ssh_config can never produce the transport', () => {
    const host = parseSshG(
      ['hostname x', 'user u', 'port 22', 'proxycommand evil', 'trustedtransport evil', 'pinnedhostkey evil'].join('\n'),
      '/h'
    )
    expect(host.proxyCommand).toBe('evil')
    expect(host.trustedTransport).toBeUndefined()
  })

  it('a wsl.exe child that dies drops the connection, so the app notices and reconnects', async () => {
    const { svc, server, d, dir } = await connected()
    const peer = await readyPeer(dir, d, server)
    let child: ReturnType<typeof spawn> | undefined
    const mux = muxFor(svc, () => {
      const script = `const s=require('net').connect(${peer.port},'127.0.0.1');process.stdin.pipe(s).pipe(process.stdout)`
      child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
      return child
    })
    expect((await runSshArgv(mux, execArgv(server))).code).toBe(0)
    expect(mux.check(CP)).toBe(true)
    child?.kill()
    await vi.waitFor(() => expect(mux.check(CP)).toBe(false), { timeout: 5000 })
  })

  describe('a request that names another host on a WSL project’s ControlPath', () => {
    const plain = { host: 'plain.example', user: 'x', port: 22 }

    it('never runs in the distro: not a command, a terminal or a file transfer', async () => {
      const { mux, server, peer } = await connected()
      expect((await runSshArgv(mux, execArgv(server))).code).toBe(0)
      const execs: string[] = []
      for (const c of peer.live) c.on('session', () => execs.push('session'))
      const r = await runSshArgv(mux, childArgs(plain, CP, 'touch /tmp/pwned'))
      expect(r.code).toBe(255)
      expect(r.stderr.toString()).toMatch(/does not serve plain\.example/)
      const pty = parseSshArgv(childArgs(plain, CP, 'sh'))
      await expect(mux.shell(pty as never, { cols: 80, rows: 24 })).rejects.toThrow(/does not serve/)
      await expect(mux.channel(pty as never)).rejects.toThrow(/does not serve/)
      const s = await runScpArgv(mux, ['-o', `ControlPath=${CP}`, '-P', '22', 'plain.example.txt', 'x@plain.example:y'])
      expect(s.code).toBe(1)
      expect(s.stderr).toMatch(/does not serve/)
      expect(execs).toEqual([])
    })

    it('cannot forward or end the connection either', async () => {
      const { mux, server } = await connected()
      expect((await runSshArgv(mux, execArgv(server))).code).toBe(0)
      const fwd = await runSshArgv(mux, hookForwardArgs(plain, CP, '/tmp/evil.sock', 1234))
      expect(fwd.code).toBe(255)
      expect(fwd.stderr.toString()).toMatch(/does not serve/)
      expect((await runSshArgv(mux, exitMasterArgs(plain, CP))).code).toBe(255)
      expect(mux.check(CP)).toBe(true)
    })

    it('an upper-case spelling of the same host is refused too', async () => {
      const { mux, server } = await connected()
      expect((await runSshArgv(mux, execArgv(server))).code).toBe(0)
      const r = await runSshArgv(mux, childArgs({ ...server, host: server.host.toUpperCase() }, CP, 'true'))
      expect(r.code).toBe(255)
    })

    it('a WSL name does not ride an ordinary connection', async () => {
      const key = ed25519KeyPair()
      const peer = await startPeer(ed25519KeyPair().private, key.public)
      const dir = testTmpDir('nt-wsl-')
      const id = path.join(dir, 'id')
      fs.writeFileSync(id, key.private, { mode: 0o600 })
      const m = new NativeMux({
        defaultAgent: () => undefined,
        connectSocket: (_h, _p, _t) =>
          new Promise((res, rej) => {
            const s = net.connect(peer.port, '127.0.0.1')
            s.once('connect', () => res(s))
            s.once('error', rej)
          }),
        resolveHost: async () => ({
          hostname: 'plain.example',
          port: 22,
          user: 'x',
          identityFiles: [id],
          identitiesOnly: true,
          userKnownHostsFiles: [path.join(dir, 'kh')],
          globalKnownHostsFiles: [],
          strictHostKeyChecking: 'accept-new'
        })
      })
      muxes.push(m)
      expect((await runSshArgv(m, childArgs({ host: 'plain.example', user: 'x' }, CP, 'true'))).code).toBe(0)
      const r = await runSshArgv(m, childArgs({ host: 'ubuntu-0123456789abcdef.wsl.nodeterm.invalid', user: 'x' }, CP, 'true'))
      expect(r.code).toBe(255)
      expect(r.stderr.toString()).toMatch(/does not serve/)
    })
  })

  describe('what wsl.exe prints before the SSH banner', () => {
    const NOTICE = Buffer.from('wsl: A localhost proxy configuration was detected.\r\n', 'utf16le').toString('hex')
    function noisy(peer: Peer, before: string): ProxySpawn {
      return () => {
        const script =
          `process.stdout.write(Buffer.from(${JSON.stringify(before)},'hex'),()=>{` +
          `const s=require('net').connect(${peer.port},'127.0.0.1');process.stdin.pipe(s).pipe(process.stdout)})`
        return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
      }
    }

    it('a UTF-16 notice on stdout does not break the handshake', async () => {
      const { svc, server, peer } = await connected()
      const r = await runSshArgv(muxFor(svc, noisy(peer, NOTICE)), execArgv(server))
      expect(r.stderr.toString()).toBe('')
      expect(r.code).toBe(0)
      expect(r.stdout.toString()).toContain('ran: echo hi')
    })

    it('neither does an ASCII notice', async () => {
      const { svc, server, peer } = await connected()
      const r = await runSshArgv(muxFor(svc, noisy(peer, Buffer.from('a notice\r\n').toString('hex'))), execArgv(server))
      expect(r.code).toBe(0)
    })

    it('wsl.exe’s own failure on stdout is the error the user reads', async () => {
      const { svc, server } = await connected()
      const text = Buffer.from('There is no distribution with the supplied name.\r\n', 'utf16le').toString('hex')
      const failing: ProxySpawn = () =>
        spawn(process.execPath, ['-e', `process.stdout.write(Buffer.from(${JSON.stringify(text)},'hex'),()=>process.exit(1))`], {
          stdio: ['pipe', 'pipe', 'pipe']
        })
      const r = await runSshArgv(muxFor(svc, failing), execArgv(server))
      expect(r.code).toBe(255)
      expect(r.stderr.toString()).toMatch(/WSL Ubuntu exited \(code 1\).*There is no distribution/)
    })
  })

  describe('wsl.exe dying under a live connection', () => {
    function holdChild(peer: Peer, kids: ReturnType<typeof spawn>[]): ProxySpawn {
      return () => {
        const script = `const s=require('net').connect(${peer.port},'127.0.0.1');process.stdin.pipe(s).pipe(process.stdout)`
        const c = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
        kids.push(c)
        return c
      }
    }

    it.each([
      ['an EPIPE from its stdin', (c: ReturnType<typeof spawn>) => void c.stdin?.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))],
      ['a reset on its stdout', (c: ReturnType<typeof spawn>) => void c.stdout?.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))],
      ['the process being killed', (c: ReturnType<typeof spawn>) => void c.kill('SIGKILL')]
    ])('%s reads as a disconnect, crashes nothing, and the next command reconnects', async (_n, die) => {
      const { svc, server, peer } = await connected()
      const kids: ReturnType<typeof spawn>[] = []
      const mux = muxFor(svc, holdChild(peer, kids))
      expect((await runSshArgv(mux, execArgv(server))).code).toBe(0)
      const open = parseSshArgv(childArgs(server, CP, 'hold'))
      const ch = await mux.channel(open as never)
      ch.resume()
      const closed = new Promise<void>((r) => ch.once('close', () => r()))
      die(kids[0])
      await vi.waitFor(() => expect(mux.check(CP)).toBe(false), { timeout: 5000 })
      await closed
      expect(channelExit(ch).code).toBeNull()
      // A write after the pipe broke must not throw either.
      expect(() => ch.write('late')).not.toThrow()
      const again = await runSshArgv(mux, execArgv(server))
      expect(again.code).toBe(0)
      expect(kids).toHaveLength(2)
    })

    it('an EPIPE before the banner is a failed connect, not a crash', async () => {
      const { svc, server } = await connected()
      const failing: ProxySpawn = () => {
        const c = spawn(process.execPath, ['-e', `process.stderr.write('boom\\n');setTimeout(()=>process.exit(1),50)`], {
          stdio: ['pipe', 'pipe', 'pipe']
        })
        setTimeout(() => c.stdin?.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), 5)
        return c
      }
      const r = await runSshArgv(muxFor(svc, failing), execArgv(server))
      expect(r.code).toBe(255)
      expect(r.stderr.toString()).toMatch(/WSL Ubuntu/)
    })
  })

  it('a project this user never created there is refused before anything starts', async () => {
    const d = fakeDistro()
    const { svc, calls } = service({ Ubuntu: d })
    const { server } = await prepared(svc)
    const before = calls.length
    await expect(svc.authorize('attached-p9-abcd', server.host, CP)).rejects.toThrow(/not set up for this project/)
    await expect(svc.authorize('some-local-project', server.host, CP)).rejects.toThrow(/not set up for this project/)
    expect(calls.length).toBe(before)
  })

  it('a ControlPath no project was authorized on gets no transport, and nothing is spawned', async () => {
    const { svc, server, spawned, spawnProxy } = await connected()
    const r = await runSshArgv(muxFor(svc, spawnProxy), execArgv(server, '/cm/hostile.sock'))
    expect(r.code).toBe(255)
    expect(r.stderr.toString()).toMatch(/not set up on this computer/)
    expect(spawned).toEqual([])
  })

  it('a ProxyJump hop, which has no ControlPath, cannot name an endpoint', async () => {
    const { svc, server } = await connected()
    await expect(svc.resolve({ host: server.host, user: 'dev' })).rejects.toThrow(/not set up on this computer/)
  })

  it('a ControlPath authorized for one endpoint does not open another', async () => {
    const d = fakeDistro()
    const { svc } = service({ Ubuntu: d, Debian: fakeDistro() })
    const u = await prepared(svc, 'Ubuntu')
    const deb = await prepared(svc, 'Debian')
    await svc.bind('p1', u.server.host)
    await svc.authorize('p1', u.server.host, CP)
    await expect(svc.resolve({ host: deb.server.host, user: 'dev' }, { controlPath: CP })).rejects.toThrow(/not set up/)
  })

  it('a name from a file means nothing here: another machine’s handle, or a path', async () => {
    const { svc, calls } = service({ Ubuntu: fakeDistro() })
    await prepared(svc)
    const before = calls.length
    for (const host of [
      'ubuntu-0123456789abcdef.wsl.nodeterm.invalid',
      '../../etc-0123456789abcdef.wsl.nodeterm.invalid',
      'ubuntu.wsl.nodeterm.invalid',
      '.wsl.nodeterm.invalid'
    ]) {
      await expect(svc.authorize('p1', host, CP)).rejects.toThrow(/not set up/)
      await expect(svc.resolve({ host, user: 'x' }, { controlPath: CP })).rejects.toThrow(/not set up/)
      await expect(svc.bind('p1', host)).resolves.toBe(false)
    }
    expect(calls.length).toBe(before)
  })

  it('a record edited to name another handle’s host is not trusted', async () => {
    const { svc, dir } = service({ Ubuntu: fakeDistro() })
    const { server } = await prepared(svc)
    await svc.bind('p1', server.host)
    const handle = /-([a-f0-9]{16})\.wsl\./.exec(server.host)?.[1] as string
    const file = path.join(dir, handle, 'endpoint.json')
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...rec, host: `evil-${'f'.repeat(16)}.wsl.nodeterm.invalid` }))
    // Bound, so only the mismatch between the file and the name it was asked for can refuse this.
    const again = new WslEndpoints({ dir, run: fakeWsl({}).run, platform: 'win32', env: WIN_ENV, atomicWrite: remoteAtomicWrite })
    await expect(again.authorize('p1', server.host, CP)).rejects.toThrow(/not set up/)
  })

  it('a distro name edited into the record to be an option is refused at the exec site', async () => {
    const { svc, dir, server } = await connected()
    const handle = /-([a-f0-9]{16})\.wsl\./.exec(server.host)?.[1] as string
    const file = path.join(dir, handle, 'endpoint.json')
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...rec, distro: '--shutdown' }))
    await expect(svc.resolve({ host: server.host, user: 'dev' }, { controlPath: CP })).rejects.toThrow(/not set up/)
  })
})

describe('who may connect, across a restart', () => {
  it('a bound project connects after the app restarts', async () => {
    const { svc, dir, calls } = service({ Ubuntu: fakeDistro() })
    const { server } = await prepared(svc)
    await svc.bind('p1', server.host)
    const again = new WslEndpoints({ dir, run: fakeWsl({ Ubuntu: fakeDistro() }).run, platform: 'win32', env: WIN_ENV, atomicWrite: remoteAtomicWrite })
    await expect(again.authorize('p1', server.host, CP)).resolves.toBeUndefined()
    expect(calls.length).toBeGreaterThan(0)
  })

  it('a folder-browse grant covers its one connection and does not survive a restart', async () => {
    const { svc, dir } = service({ Ubuntu: fakeDistro() })
    const { server } = await prepared(svc)
    await expect(svc.authorize(BROWSE, server.host, CP)).resolves.toBeUndefined()
    await expect(svc.authorize('ssh-browse-other', server.host, CP)).rejects.toThrow(/not set up/)
    const again = new WslEndpoints({ dir, run: fakeWsl({}).run, platform: 'win32', env: WIN_ENV, atomicWrite: remoteAtomicWrite })
    await expect(again.authorize(BROWSE, server.host, CP)).rejects.toThrow(/not set up/)
  })

  it('only a browse id can be granted by the prepare step', async () => {
    const { svc } = service({ Ubuntu: fakeDistro() })
    await expect(svc.prepare('Ubuntu', 'some-project')).resolves.toMatchObject({ ok: false })
    await expect(svc.prepare('Ubuntu', undefined)).resolves.toMatchObject({ ok: false })
  })

  it('a connect sent right after bind is not refused while the file is being written', async () => {
    const { svc } = service({ Ubuntu: fakeDistro() })
    const { server } = await prepared(svc)
    const binding = svc.bind('p2', server.host)
    await expect(svc.authorize('p2', server.host, CP)).resolves.toBeUndefined()
    await binding
  })
})

describe('the record under concurrent work', () => {
  it('a project bound during a slow distro check is still bound afterwards', async () => {
    const d = fakeDistro()
    const wsl = fakeWsl({ Ubuntu: d })
    let release: () => void = () => {}
    let holding = false
    const run: WslRun = async (args, o) => {
      if (holding && args[5] === WSL_PROBE_SCRIPT) await new Promise<void>((r) => (release = r))
      return wsl.run(args, o)
    }
    const dir = testTmpDir('nt-wsl-')
    const svc = new WslEndpoints({ dir, run, platform: 'win32', env: WIN_ENV, atomicWrite: remoteAtomicWrite })
    const { server } = await prepared(svc)
    d.instance = 'boot:2'
    holding = true
    const check = svc.prepare('Ubuntu', BROWSE)
    await vi.waitFor(() => expect(wsl.calls.length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 30))
    await svc.bind('p-created-meanwhile', server.host)
    release()
    await check
    const again = new WslEndpoints({ dir, run: wsl.run, platform: 'win32', env: WIN_ENV, atomicWrite: remoteAtomicWrite })
    await expect(again.authorize('p-created-meanwhile', server.host, CP)).resolves.toBeUndefined()
  })

  it('every project bound at once survives', async () => {
    const { svc, dir } = service({ Ubuntu: fakeDistro() })
    const { server } = await prepared(svc)
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => svc.bind(id, server.host)))
    const again = new WslEndpoints({ dir, run: fakeWsl({}).run, platform: 'win32', env: WIN_ENV, atomicWrite: remoteAtomicWrite })
    for (const id of ['a', 'b', 'c', 'd']) await expect(again.authorize(id, server.host, CP)).resolves.toBeUndefined()
  })
})

describe('failures on the connect path', () => {
  it('a later connect names sshd having been removed, as the connection’s own error', async () => {
    let t = 1000
    const d = fakeDistro()
    const wsl = fakeWsl({ Ubuntu: d })
    const svc = new WslEndpoints({ dir: testTmpDir('nt-wsl-'), run: wsl.run, platform: 'win32', env: WIN_ENV, atomicWrite: remoteAtomicWrite, now: () => t })
    const { server } = await prepared(svc)
    await svc.bind('p1', server.host)
    await svc.authorize('p1', server.host, CP)
    d.tools.sshd = false
    t += 60_000
    const spawned = proxyTo(() => {
      throw new Error('nothing may be spawned')
    })
    const r = await runSshArgv(muxFor(svc, spawned.spawnProxy), execArgv(server))
    expect(r.code).toBe(255)
    expect(r.stderr.toString()).toContain('sudo apt install openssh-server')
    expect(spawned.spawned).toEqual([])
  })

  it('a POSIX core without the switch refuses at the first gate', async () => {
    const { svc } = service({}, { platform: 'linux', env: {} })
    await expect(svc.authorize('p1', 'ubuntu-0123456789abcdef.wsl.nodeterm.invalid', CP)).rejects.toThrow(/only available on Windows/)
  })
})

describe('the keys ssh2 can generate', () => {
  it('never pins a key that cannot be read back', async () => {
    const bad = { private: '-----BEGIN OPENSSH PRIVATE KEY-----\nbroken\n-----END OPENSSH PRIVATE KEY-----\n', public: 'ssh-ed25519 broken' }
    const generateKeyPair = vi.fn(() => (generateKeyPair.mock.calls.length <= 2 ? bad : ed25519KeyPair()))
    const wsl = fakeWsl({ Ubuntu: fakeDistro() })
    const svc = new WslEndpoints({ dir: testTmpDir('nt-wsl-'), run: wsl.run, platform: 'win32', env: WIN_ENV, atomicWrite: remoteAtomicWrite, generateKeyPair })
    const r = await svc.prepare('Ubuntu', BROWSE)
    expect(r.ok).toBe(true)
    expect(generateKeyPair.mock.calls.length).toBeGreaterThan(2)
  })
})

// The scripts themselves, run as the distro would run them. A real sshd is the live run's job.
describe.skipIf(process.platform === 'win32')('the scripts under a real /bin/sh', () => {
  function shellRun(home: string, extraEnv: NodeJS.ProcessEnv = {}): WslRun {
    return (args, o) =>
      new Promise((resolve) => {
        if (args[0] === '--list') {
          return resolve({ code: 0, stdout: Buffer.from('Ubuntu\r\n', 'utf16le'), stderr: Buffer.alloc(0), timedOut: false })
        }
        const script = args.slice(args.indexOf('-c') + 1)
        const child = spawn('/bin/sh', ['-c', ...script], {
          env: { PATH: process.env.PATH, HOME: home, ...extraEnv },
          stdio: ['pipe', 'pipe', 'pipe']
        })
        const out: Buffer[] = []
        const err: Buffer[] = []
        child.stdout.on('data', (d: Buffer) => out.push(d))
        child.stderr.on('data', (d: Buffer) => err.push(d))
        child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut: false }))
        child.stdin.on('error', () => {})
        child.stdin.end(o.stdin ?? '')
      })
  }

  function realService(home: string) {
    return new WslEndpoints({ dir: testTmpDir('nt-wsl-'), run: shellRun(home), platform: 'win32', env: WIN_ENV, atomicWrite: remoteAtomicWrite })
  }

  it('provisions private files that match the probe, and writes nothing the second time', async () => {
    const home = path.join(testTmpDir('nt-wsl-home-'), 'dir with space')
    fs.mkdirSync(home)
    // A per-user sshd, so this runs whether or not the machine has one.
    fs.mkdirSync(path.join(home, '.local', 'sbin'), { recursive: true })
    fs.writeFileSync(path.join(home, '.local', 'sbin', 'sshd'), '#!/bin/sh\n', { mode: 0o755 })
    const svc = realService(home)
    const r = await svc.prepare('Ubuntu', BROWSE)
    expect(r.ok).toBe(true)
    const d = path.join(home, WSL_SSHD_DIR)
    expect(fs.statSync(d).mode & 0o777).toBe(0o700)
    for (const n of ['host_ed25519', 'authorized_keys', 'sshd_config']) expect(fs.statSync(path.join(d, n)).mode & 0o777).toBe(0o600)
    const stamp = fs.statSync(path.join(d, 'sshd_config')).mtimeMs
    const keys = fs.readFileSync(path.join(d, 'authorized_keys'), 'utf8')
    const keysStamp = fs.statSync(path.join(d, 'authorized_keys')).mtimeMs
    await svc.prepare('Ubuntu', BROWSE)
    expect(fs.statSync(path.join(d, 'sshd_config')).mtimeMs).toBe(stamp)
    expect(fs.statSync(path.join(d, 'authorized_keys')).mtimeMs).toBe(keysStamp)
    // The real probe and a real planted line: the whole file is compared, not its first line.
    fs.appendFileSync(path.join(d, 'authorized_keys'), `${ed25519KeyPair().public}\n`)
    await svc.prepare('Ubuntu', BROWSE)
    expect(fs.readFileSync(path.join(d, 'authorized_keys'), 'utf8')).toBe(keys)
  })

  it('the probe reports what it finds, parsed by the real parser', async () => {
    const home = testTmpDir('nt-wsl-home-')
    const r = await shellRun(home)(['-d', 'Ubuntu', '--exec', 'sh', '-c', WSL_PROBE_SCRIPT], { timeoutMs: 10_000 })
    const probe = parseWslProbe(r.stdout)
    expect(probe?.home).toBe(home)
    expect(probe?.user).toBeTruthy()
    expect(probe?.hostKey).toBe('')
    expect(probe?.instance).toMatch(/:/)
  })

  it('finds a per-user sshd and launches it with the config, and names a missing one', async () => {
    const home = testTmpDir('nt-wsl-home-')
    const none = await shellRun(home)(['-d', 'U', '--exec', 'sh', '-c', WSL_SSHD_LAUNCH.replace(/\/usr\/sbin\/sshd \/usr\/local\/sbin\/sshd \/sbin\/sshd /, ''), 'name'], { timeoutMs: 10_000 })
    expect(none.code).toBe(72)
    expect(none.stderr.toString()).toContain('sshd is not installed')
    const bin = path.join(home, '.local', 'sbin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'sshd'), '#!/bin/sh\necho "$0 $*"\n', { mode: 0o755 })
    const found = await shellRun(home)(['-d', 'U', '--exec', 'sh', '-c', WSL_SSHD_LAUNCH.replace(/\/usr\/sbin\/sshd \/usr\/local\/sbin\/sshd \/sbin\/sshd /, ''), 'name'], { timeoutMs: 10_000 })
    expect(found.stdout.toString().trim()).toBe(`${bin}/sshd -i -e -f ${home}/${WSL_SSHD_DIR}/sshd_config`)
  })
})

describe('the argv builders', () => {
  it('produce an argv the strict parser reads back for a WSL host', () => {
    const server = { host: 'ubuntu-0123456789abcdef.wsl.nodeterm.invalid', user: 'dev', port: 22 }
    const p = parseSshArgv(childArgs(server, CP, 'true'))
    expect(p).toMatchObject({ kind: 'exec', target: { host: server.host, user: 'dev' } })
  })
})
