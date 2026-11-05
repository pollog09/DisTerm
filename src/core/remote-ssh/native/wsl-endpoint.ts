// The trusted half of a WSL project: per-distro keys, the sshd config, the host key pin, and the only
// code that may turn a `*.wsl.nodeterm.invalid` host into a transport.
//
// HOW IT CONNECTS. `wsl.exe -d <distro> --exec sh -c <launch>` runs `sshd -i` on the child's stdio and
// the native transport speaks SSH over it, so every exec, pty, SFTP session and hook tunnel is the
// ordinary SSH project path. No port is opened and no root is needed.
//
// TRUST. A project file, a relay peer and inbound canvas traffic can all carry a host name, so a name
// is worth nothing here:
//  - The distro, keys and pin are read from `<dir>/<handle>/`, machine-local files only this module
//    writes. Nothing in an `SshConnection` reaches the transport.
//  - `<handle>` is random per machine, so a file written elsewhere names nothing here.
//  - Two gates: `authorize` refuses a project the user did not create on this endpoint (the id list
//    is written only through a host-only channel), and `resolve` refuses a connection whose
//    ControlPath `authorize` did not pass.
//  - The transport is an argv, never a command line: no cmd.exe, no shell, no `%` expansion, so a
//    distro name with spaces needs no quoting and one with `%PATH%` means nothing.
//
// Windows-only behavior is reached through `WslEndpointDeps`, so every rule here runs on any CI host.

import { execFile, spawn } from 'child_process'
import { randomBytes } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import type { ParsedKey } from 'ssh2'
import { REMOTE_TMUX_PATH_DIRS, type SshServer } from '../../../shared/ssh'
import {
  WSL_HOST_SUFFIX,
  isWslHost,
  type WslDistroList,
  type WslPrepareResult,
  type WslSetupErrorCode,
  type WslWarning
} from '../../../shared/wsl-project'
import { parseWslShell, wslShellValue } from '../../../shared/terminal-profiles'
import { writeFileAtomic } from '../../fs-atomic'
import { isSafeRemoteHome } from '../../remote-safety'
import { decodeWslOutput, listWslDistros, parseWslDistroList, wslExe, type ProfileExec } from '../../terminal-profiles'
import { windowsSystemDrive } from '../../win32-powershell'
import { formatCksum, posixCksum } from '../posix-cksum'
import type { HostQuery, ResolvedHost } from './ssh-config'

/** The distro's private directory, relative to its `$HOME`. */
export const WSL_SSHD_DIR = '.nodeterm/wsl-sshd'

const PROBE_TIMEOUT_MS = 60_000
const WRITE_TIMEOUT_MS = 30_000
const LIST_TIMEOUT_MS = 10_000
/** A cold distro has to boot before sshd can print its banner. */
const CONNECT_TIMEOUT_S = 60
/** A connect re-checks the distro at most this often. Overflow connections land inside it. */
const ENSURE_TTL_MS = 30_000
/** sshd's default of 10 would spawn another wsl.exe for every 10 terminals. */
const MAX_SESSIONS = 64
const EXIT_NO_SSHD = 72
const EXIT_DRAIN_MS = 500
const KEEPALIVE_OP_TIMEOUT_MS = 15_000
/** How long a keepalive that was just started has to show up inside the distro. */
const KEEPALIVE_VERIFY_TRIES = 10
const KEEPALIVE_VERIFY_GAP_MS = 500

/**
 * What the keepalive runs. WSL stops a distro with no client attached, and tmux does not count, so a
 * `wsl.exe` running this is that client. The shell stays as the process in the distro so its command
 * line can be recognized (`WSL_KEEPALIVE_OPS`), and it ends with its `sleep` if either is stopped, so
 * it cannot spin and nothing restarts it.
 */
export const WSL_KEEPALIVE_SCRIPT =
  `trap 'kill "$p" 2>/dev/null; exit 0' TERM INT HUP; ` +
  `while :; do sleep 86400 & p=$!; wait "$p" || exit 0; done`

/** The part of `$0` every keepalive of this app shares. */
export const WSL_KEEPALIVE_MARKER_PREFIX = 'nodeterm-wsl-keepalive-'

/** `$0` of the keepalive: the prefix, then the 16-hex handle of the endpoint that started it. */
export function wslKeepaliveMarker(handle: string): string {
  return `${WSL_KEEPALIVE_MARKER_PREFIX}${handle}`
}

/**
 * Find or stop this app's keepalive in a distro, whichever endpoint record started it. A lost or
 * corrupt `endpoint.json` mints a new handle, and a keepalive under the old one must still be reused
 * and stoppable. A process counts only if THIS user owns it and its arguments after argv[0] are EXACTLY
 * `-c <script> <prefix><16 hex>`. A process that merely mentions the marker, one of another user, or
 * this script (whose own arguments are shaped differently) is never reported or stopped. argv[0] is not
 * compared because wsl.exe decides how it spells `sh`. Args: find|stop|trim, prefix, script. `trim`
 * keeps the first match.
 */
export const WSL_KEEPALIVE_OPS =
  `a=$1; m=$2; s=$3; n=$(printf '\\nx'); n=\${n%x}; want="-c$n$s$n$m"; first=1; ` +
  `for d in /proc/[0-9]*; do ` +
  `p=\${d#/proc/}; [ "$p" != "$$" ] || continue; ` +
  `[ -O "$d" ] || continue; ` +
  `c=$(tr '\\000' '\\n' < "$d/cmdline" 2>/dev/null) || continue; ` +
  `r=\${c#*$n}; h=\${r#"$want"}; [ "$h" != "$r" ] || continue; ` +
  `[ "\${#h}" = 16 ] || continue; ` +
  `case "$h" in *[!0-9a-f]*) continue ;; esac; ` +
  `case "$a" in ` +
  `find) printf 'NTWSL keepalive=%s\\n' "$p" ;; ` +
  `stop) kill "$p" 2>/dev/null; printf 'NTWSL stopped=%s\\n' "$p" ;; ` +
  `trim) if [ "$first" = 1 ]; then printf 'NTWSL keepalive=%s\\n' "$p"; else kill "$p" 2>/dev/null; printf 'NTWSL stopped=%s\\n' "$p"; fi ;; ` +
  `esac; first=0; done`

/**
 * Where sshd may live. The per-user path is for a machine with no root; the rest are the system
 * ones, which a non-login shell's PATH often misses. An absolute path is required: sshd refuses to
 * re-exec from a relative one.
 */
const SSHD_CANDIDATES = '/usr/sbin/sshd /usr/local/sbin/sshd /sbin/sshd "$HOME/.local/sbin/sshd"'

const FIND_SSHD = `s=; for c in ${SSHD_CANDIDATES}; do if [ -x "$c" ]; then s=$c; break; fi; done`

/**
 * Replaces itself with `sshd -i`. Root needs the privilege separation directory; an unprivileged
 * sshd does not use one.
 */
export const WSL_SSHD_LAUNCH =
  `${FIND_SSHD}; ` +
  `[ -n "$s" ] || { echo 'sshd is not installed' >&2; exit ${EXIT_NO_SSHD}; }; ` +
  `[ "$(id -u)" != 0 ] || mkdir -p /run/sshd; ` +
  `exec "$s" -i -e -f "$HOME/${WSL_SSHD_DIR}/sshd_config"`

/**
 * Prints `NTWSL <key>=<value>` lines. The marker is what the parser keys on, because wsl.exe can mix
 * its own UTF-16 notices into stdout. The instance id changes when WSL restarts the distro: it is
 * the VM's boot id plus the start time of the distro's init.
 */
export const WSL_PROBE_SCRIPT = [
  `PATH="$PATH:/usr/sbin:/sbin:${REMOTE_TMUX_PATH_DIRS}"`,
  `${FIND_SSHD}`,
  `d="$HOME/${WSL_SSHD_DIR}"`,
  `p() { printf 'NTWSL %s=%s\\n' "$1" "$2"; }`,
  `has() { command -v "$1" >/dev/null 2>&1 && echo 1 || echo 0; }`,
  `p user "$(id -un)"`,
  `p home "$HOME"`,
  `p sshd "$s"`,
  `p tmux "$(has tmux)"`,
  `p curl "$(has curl)"`,
  `pm=; for m in apt-get dnf yum pacman zypper apk; do if command -v "$m" >/dev/null 2>&1; then pm=$m; break; fi; done`,
  `p pm "$pm"`,
  `p hostkey "$(cat "$d/host_ed25519.pub" 2>/dev/null)"`,
  `[ -s "$d/host_ed25519" ] && p hostpriv 1 || p hostpriv 0`,
  // A checksum of the whole file: a line added after our key must read as a difference.
  `p authorized "$(cksum < "$d/authorized_keys" 2>/dev/null)"`,
  `p config "$(cksum < "$d/sshd_config" 2>/dev/null)"`,
  `p instance "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null):$(cut -d' ' -f22 /proc/1/stat 2>/dev/null)"`
].join('\n')

/** What the distro told the probe. All of it is data, not truth: it is validated where it is used. */
export interface WslProbe {
  user: string
  home: string
  sshd: string
  tmux: boolean
  curl: boolean
  pm: string
  hostKey: string
  hostKeyPrivate: boolean
  authorized: string
  configSum: string
  instance: string
}

export function parseWslProbe(raw: Buffer): WslProbe | null {
  const fields = new Map<string, string>()
  // NUL-stripped latin1 keeps ASCII notices readable and passes a UTF-8 path through byte for byte.
  for (const line of raw.toString('latin1').replace(/\0/g, '').split(/\r?\n/)) {
    const m = /^NTWSL ([a-z]+)=(.*)$/.exec(line)
    if (m) fields.set(m[1], Buffer.from(m[2], 'latin1').toString('utf8'))
  }
  const user = fields.get('user')
  const home = fields.get('home')
  if (!user || !home) return null
  return {
    user,
    home,
    sshd: fields.get('sshd') ?? '',
    tmux: fields.get('tmux') === '1',
    curl: fields.get('curl') === '1',
    pm: fields.get('pm') ?? '',
    hostKey: fields.get('hostkey') ?? '',
    hostKeyPrivate: fields.get('hostpriv') === '1',
    authorized: fields.get('authorized') ?? '',
    configSum: fields.get('config') ?? '',
    instance: fields.get('instance') ?? ''
  }
}

/** The sshd config, as measured working unprivileged. `home` is the distro's own answer. */
export function wslSshdConfig(home: string): string {
  const dir = `${home}/${WSL_SSHD_DIR}`
  return [
    '# Generated by the app for a WSL project. Rewritten on connect if it differs.',
    `HostKey "${dir}/host_ed25519"`,
    `AuthorizedKeysFile "${dir}/authorized_keys"`,
    'AuthenticationMethods publickey',
    'PubkeyAuthentication yes',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'UsePAM no',
    'StrictModes no',
    'PidFile none',
    'AllowStreamLocalForwarding yes',
    'AllowTcpForwarding yes',
    'StreamLocalBindUnlink yes',
    `MaxSessions ${MAX_SESSIONS}`,
    // In-process, so it needs no path that differs between distributions.
    'Subsystem sftp internal-sftp',
    'LogLevel ERROR',
    ''
  ].join('\n')
}

/** The package to install, by the distro's own package manager. */
export function wslInstallCommand(pm: string, tool: 'sshd' | 'tmux' | 'curl'): string {
  const pkg = (name: string, sshdName: string): string => (tool === 'sshd' ? sshdName : name)
  switch (pm) {
    case 'apt-get':
      return `sudo apt install ${pkg(tool, 'openssh-server')}`
    case 'dnf':
      return `sudo dnf install ${pkg(tool, 'openssh-server')}`
    case 'yum':
      return `sudo yum install ${pkg(tool, 'openssh-server')}`
    case 'pacman':
      return `sudo pacman -S ${pkg(tool, 'openssh')}`
    case 'zypper':
      return `sudo zypper install ${pkg(tool, 'openssh')}`
    case 'apk':
      return `sudo apk add ${pkg(tool, 'openssh-server')}`
    default:
      return `install ${tool === 'sshd' ? 'the OpenSSH server' : tool} with the distribution's package manager`
  }
}

/** The name becomes one argv element after `-d`: the same rule `wsl:` terminal profiles enforce. */
export function isValidDistroName(distro: unknown): distro is string {
  return typeof distro === 'string' && parseWslShell(wslShellValue(distro)) === distro
}

export function wslProjectsAvailable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.NODETERM_NATIVE_SSH === '0') return false
  if (platform === 'win32') return true
  // Exercising the real transport from inside WSL, as NODETERM_NATIVE_SSH=1 does for SSH projects.
  return env.NODETERM_NATIVE_SSH === '1' && env.NODETERM_WSL_PROJECTS === '1'
}

/**
 * The wsl.exe to run. On Windows this is a fixed path that no environment value can move. Only the
 * POSIX test switch above reaches the bare name, where PATH was already the user's to set.
 */
export function wslProgram(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  return platform === 'win32' ? wslExe(env) : 'wsl.exe'
}

/** A {@link ProfileExec} on {@link wslRunner}, for a list that must not outlive its timeout. */
export const wslProfileExec: ProfileExec = async (file, args, timeoutMs) => {
  const r = await wslRunner(file)(args, { timeoutMs })
  if (r.timedOut || r.code === null) throw new Error('wsl.exe did not answer')
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
}

export interface WslRunResult {
  code: number | null
  stdout: Buffer
  stderr: Buffer
  timedOut: boolean
}

export type WslRun = (args: string[], opts: { timeoutMs: number; stdin?: string }) => Promise<WslRunResult>

/**
 * Run wsl.exe and collect its output, with `timeoutMs` as a hard limit. `close` alone is not a bound:
 * it waits for the pipes, and any process that inherited them keeps them open after the child has
 * died (measured: 26.5 s against a 10 s limit). So the timer answers by itself, and the pipes are
 * destroyed so nothing keeps this process waiting on them.
 */
export function wslRunner(program: string): WslRun {
  return (args, opts) =>
    new Promise((resolve) => {
      const out: Buffer[] = []
      const err: Buffer[] = []
      let timedOut = false
      let settled = false
      const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const finish = (code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(exitGrace)
        child.stdout.destroy()
        child.stderr.destroy()
        child.stdin.destroy()
        resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut })
      }
      let exitGrace: ReturnType<typeof setTimeout> | undefined
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
        finish(null)
      }, opts.timeoutMs)
      child.stdout.on('data', (d: Buffer) => out.push(d))
      child.stderr.on('data', (d: Buffer) => err.push(d))
      child.stdout.on('error', () => {})
      child.stderr.on('error', () => {})
      child.on('error', (e) => {
        err.push(Buffer.from(e.message))
        finish(null)
      })
      child.on('close', (code) => finish(code))
      // The exit status is known here. Give the pipes a moment to drain, then stop waiting for them.
      child.on('exit', (code) => {
        exitGrace = setTimeout(() => finish(code), EXIT_DRAIN_MS)
      })
      // A child that dies before reading stdin raises EPIPE as an event; the exit reports it.
      child.stdin.on('error', () => {})
      child.stdin.end(opts.stdin ?? '')
    })
}

/**
 * Start the keepalive so it outlives this process: detached, unreferenced, and with no pipe shared
 * with the app, so nothing here holds it open and it holds nothing of ours. An argv, with no shell.
 */
export function spawnKeepaliveProcess(file: string, args: string[]): KeepaliveChild {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return child
}

export interface KeepaliveChild {
  on(event: 'error', cb: (e: Error) => void): unknown
}

/** `icacls.exe` by a path built from a fixed table, for the same reason as `wsl.exe`. */
export function icaclsExe(env: NodeJS.ProcessEnv = process.env): string {
  return `${windowsSystemDrive(env)}:\\Windows\\System32\\icacls.exe`
}

/** `whoami.exe` by a fixed path, for the same reason. */
export function whoamiExe(env: NodeJS.ProcessEnv = process.env): string {
  return `${windowsSystemDrive(env)}:\\Windows\\System32\\whoami.exe`
}

export const WHOAMI_SID_ARGS = ['/user', '/fo', 'csv', '/nh']

/**
 * The SID out of `whoami /user /fo csv /nh`: one line, `"DOMAIN\name","S-1-…"`. Anything else is null.
 * The caller then changes nothing, because a guess here could lock the user out of their own keys.
 */
export function parseWhoamiSid(stdout: string): string | null {
  const m = /^"[^"\r\n]*","(S-1-[0-9]+(?:-[0-9]+)+)"$/.exec(stdout.trim())
  return m ? m[1] : null
}

/**
 * The directory holding a client key, for this user alone, with inherited entries removed. POSIX modes
 * do not apply on Windows, and a relocated profile can inherit broader access. By SID, never by name:
 * on a domain machine with a same-named local account, a name could grant the local account while
 * `/inheritance:r` removes the real user. `(OI)(CI)` makes files created inside inherit the entry. SYSTEM
 * and Administrators lose access to this folder. No shell: each element is one argv element.
 */
export function windowsPrivateDirArgs(dir: string, sid: string): string[] {
  return [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]
}

export type WinExec = (file: string, args: string[]) => Promise<string>

const defaultWinExec: WinExec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, windowsHide: true }, (e, stdout) => (e ? reject(e) : resolve(String(stdout))))
  })

/** Rejects, having changed nothing, when the current user's SID cannot be established. */
export async function restrictWindowsDir(dir: string, env: NodeJS.ProcessEnv, exec: WinExec = defaultWinExec): Promise<void> {
  const out = await exec(whoamiExe(env), WHOAMI_SID_ARGS)
  const sid = parseWhoamiSid(out)
  if (!sid) throw new Error('whoami did not report a SID')
  await exec(icaclsExe(env), windowsPrivateDirArgs(dir, sid))
}

export interface WslEndpointDeps {
  /** Machine-local storage for keys and records. */
  dir: string
  /** Builds a remote write: the same temp, byte count and rename as every other remote write. */
  atomicWrite: (
    path: string,
    body: string,
    options: { restrictPermissions: boolean; mode: '600' | '644' }
  ) => { command: string; stdin: string }
  run?: WslRun
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  generateKeyPair?: () => { private: string; public: string }
  now?: () => number
  log?: (line: string) => void
  /** Windows: make a key directory private (default: a fixed-path `icacls`). */
  restrictDir?: (dir: string) => Promise<void>
  /** `settings.wslKeepDistroRunning`, read each time it matters. Absent = off. */
  keepaliveEnabled?: () => boolean
  /** How the keepalive is started (default `spawnKeepaliveProcess`). */
  spawnKeepalive?: (file: string, args: string[]) => KeepaliveChild
  /** The gap between checks that a new keepalive is up. */
  delay?: (ms: number) => Promise<void>
}

interface WslRecord {
  v: 1
  host: string
  distro: string
  user: string
  hostKeyPublic: string
  /**
   * A key this code generated and is writing to the distro. Recorded before the write, so a run that
   * stops partway does not leave a key the pin would refuse as changed: finding this key in the
   * distro completes the move. Only this code ever sets it.
   */
  pendingHostKey?: string
  instance?: string
  /** Project ids the user created on this endpoint. Written only through `bind`. */
  projects: string[]
}

const HANDLE = /^[a-f0-9]{16}$/
const SAFE_LABEL = /[^a-z0-9]+/g

class WslSetupError extends Error {
  constructor(
    readonly code: WslSetupErrorCode,
    message: string,
    readonly install?: string
  ) {
    super(message)
    this.name = 'WslSetupError'
  }
}

/** The handle out of a host name, or null. Hex only, so it cannot walk out of `dir`. */
function handleOf(host: string): string | null {
  if (!isWslHost(host)) return null
  const label = host.slice(0, -WSL_HOST_SUFFIX.length)
  const handle = label.slice(label.lastIndexOf('-') + 1)
  return HANDLE.test(handle) ? handle : null
}

export class WslEndpoints {
  private readonly run: WslRun
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  /** Read only here, at the call site, so the import stays type-only at module scope. */
  private ssh2Utils(): typeof import('ssh2').utils {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('ssh2') as typeof import('ssh2')).utils
  }
  /** `ssh-browse-*` connections the folder step may use. In memory: they end with the dialog. */
  private readonly browseGrants = new Map<string, string>()
  /** ControlPath → the one host `authorize` passed it for. */
  private readonly authorized = new Map<string, string>()
  /** Project ids per host, known at once so a connect in the same tick as `bind` is not refused. */
  private readonly boundNow = new Map<string, Set<string>>()
  private readonly ensured = new Map<string, { at: number; warnings: WslWarning[] }>()
  private readonly ensuring = new Map<string, Promise<WslWarning[]>>()
  private readonly warnings = new Map<string, WslWarning[]>()
  private readonly writes = new Map<string, Promise<unknown>>()
  /** Key directories already made private this run. */
  private readonly restricted = new Set<string>()
  /** Bound projects with a connection up, per host: what turning the setting on applies to. */
  private readonly openProjects = new Map<string, Set<string>>()
  private readonly keepaliveWarnings = new Map<string, WslWarning>()
  private readonly keepaliveWork = new Map<string, Promise<void>>()

  constructor(private readonly deps: WslEndpointDeps) {
    this.platform = deps.platform ?? process.platform
    this.env = deps.env ?? process.env
    this.run = deps.run ?? wslRunner(wslProgram(this.platform, this.env))
  }

  available(): boolean {
    return wslProjectsAvailable(this.platform, this.env)
  }

  async list(): Promise<WslDistroList> {
    if (!this.available()) return { available: false, distros: [] }
    const distros = await listWslDistros(async (_file, args, timeoutMs) => {
      const r = await this.run(args, { timeoutMs: Math.min(timeoutMs, LIST_TIMEOUT_MS) })
      if (r.timedOut || r.code === null) throw new Error('wsl.exe did not answer')
      return { code: r.code, stdout: r.stdout, stderr: r.stderr }
    })
    return { available: true, distros: distros.filter(isValidDistroName) }
  }

  /**
   * The new-project flow's step for a distro the user just picked. Starts that distro, and no other.
   * `browseId` is the only connection this grants: the project itself comes through `bind`.
   */
  async prepare(distro: unknown, browseId: unknown): Promise<WslPrepareResult> {
    try {
      if (!this.available()) {
        throw new WslSetupError('unavailable', 'WSL projects are only available on Windows.')
      }
      if (!isValidDistroName(distro)) {
        throw new WslSetupError('invalid-distro', 'That is not a valid WSL distribution name.')
      }
      if (typeof browseId !== 'string' || !browseId.startsWith('ssh-browse-')) {
        throw new WslSetupError('invalid-distro', 'A WSL project cannot be prepared for that connection.')
      }
      // The caller's name is not enough: only a distro WSL itself lists may be started.
      const { distros } = await this.list()
      if (!distros.includes(distro)) {
        throw new WslSetupError('not-installed', `WSL has no distribution named "${distro}".`)
      }
      const record = await this.recordForDistro(distro)
      const warnings = await this.ensure(record.host, { force: true })
      const current = await this.read(record.host)
      if (!current) throw new WslSetupError('setup-failed', `The setup record for "${distro}" could not be read.`)
      this.browseGrants.set(browseId, current.host)
      const server: SshServer = {
        id: `wsl-${handleOf(current.host)}`,
        label: `WSL: ${distro}`,
        host: current.host,
        user: current.user,
        port: 22,
        wslDistro: distro
      }
      return { ok: true, server, warnings }
    } catch (e) {
      if (e instanceof WslSetupError) {
        return { ok: false, code: e.code, error: e.message, ...(e.install ? { install: e.install } : {}) }
      }
      return { ok: false, code: 'setup-failed', error: (e as Error).message }
    }
  }

  /**
   * Durable: this is the rule a restarted app connects by. Only the local UI's create step reaches
   * it (a host-only channel). The in-memory half is set before the first await, so a connect sent
   * right after this call is not refused while the file is being written.
   */
  async bind(projectId: unknown, host: unknown): Promise<boolean> {
    if (typeof projectId !== 'string' || !projectId || !isWslHost(host)) return false
    const known = this.boundNow.get(host) ?? new Set<string>()
    known.add(projectId)
    this.boundNow.set(host, known)
    const saved = await this.mutate(host, (record) => {
      if (!record.projects.includes(projectId)) record.projects.push(projectId)
    })
    if (!saved) known.delete(projectId)
    return saved
  }

  /**
   * First gate, before anything starts: this project was created on this endpoint by the user. An
   * attachment id, a project of another host or a name out of a file all stop here.
   */
  async authorize(projectId: string, host: string, controlPath: string): Promise<void> {
    if (!this.available()) {
      throw new Error('WSL projects are only available on Windows.')
    }
    const refused = (): Error =>
      new Error('This WSL connection was not set up for this project on this computer. Nothing was started.')
    const record = await this.read(host)
    if (!record) throw refused()
    const browse = this.browseGrants.get(projectId) === host
    if (!browse && !record.projects.includes(projectId) && !this.boundNow.get(host)?.has(projectId)) {
      throw refused()
    }
    this.authorized.set(controlPath, host)
  }

  /**
   * Second gate, and the only source of a WSL transport. Reached from `NativeMux.connect`. Everything
   * the connection needs comes from the record, not from the target that asked.
   */
  async resolve(target: HostQuery, ctx: { controlPath?: string } = {}): Promise<ResolvedHost> {
    const refused = new Error('This WSL connection was not set up on this computer. Nothing was started.')
    if (!ctx.controlPath || this.authorized.get(ctx.controlPath) !== target.host) throw refused
    const record = await this.read(target.host)
    if (!record || !isValidDistroName(record.distro)) throw refused
    // A key file lost since the last check would otherwise read as a bare "Permission denied".
    await this.ensure(record.host, { force: !(await this.clientKeyReadable(record.host)) })
    const fresh = (await this.read(record.host)) ?? record
    const parsed = this.ssh2Utils().parseKey(fresh.hostKeyPublic)
    const key = (Array.isArray(parsed) ? parsed[0] : parsed) as ParsedKey | Error
    if (key instanceof Error) throw refused
    const handle = handleOf(record.host) as string
    return {
      hostname: record.host,
      port: 22,
      user: fresh.user,
      identityFiles: [path.join(this.deps.dir, handle, 'id_ed25519')],
      identitiesOnly: true,
      identityAgent: 'none',
      userKnownHostsFiles: [],
      globalKnownHostsFiles: [],
      strictHostKeyChecking: 'yes',
      connectTimeout: CONNECT_TIMEOUT_S,
      trustedTransport: {
        argv: {
          file: wslProgram(this.platform, this.env),
          args: ['-d', record.distro, '--exec', 'sh', '-c', WSL_SSHD_LAUNCH, 'nodeterm-wsl-sshd']
        },
        pinnedHostKey: key.getPublicSSH(),
        label: `WSL ${record.distro}`
      }
    }
  }

  /** What the last check of this endpoint found missing. Empty for anything else. */
  warningsFor(host: string): WslWarning[] {
    const keepalive = this.keepaliveWarnings.get(host)
    return [...(this.warnings.get(host) ?? []), ...(keepalive ? [keepalive] : [])]
  }

  /**
   * A project connected. Only a project the user created on this endpoint counts: a folder browse, a
   * `wsl:` terminal profile or a listing never gets here. With the setting on, this keeps the distro
   * running after the app quits; with it off, it stops one left by an earlier run, since off means
   * nothing outlives the app. Never throws: a failure is a named warning, and the project still works.
   */
  async connected(projectId: string, host: string): Promise<void> {
    const record = await this.read(host)
    if (!record || !this.isBound(record, projectId)) return
    const open = this.openProjects.get(host) ?? new Set<string>()
    open.add(projectId)
    this.openProjects.set(host, open)
    await this.applyKeepalive(record)
  }

  /** A project's connection ended on purpose (its tab closed, or it was deleted). */
  disconnected(projectId: string, host: string): void {
    this.openProjects.get(host)?.delete(projectId)
  }

  /**
   * The setting changed. This never starts a distro, in either direction: only distros WSL reports as
   * already running are touched. Turning it on applies to the ones with an open project. Turning it off
   * looks in every running distro, because a keepalive must be stoppable even when the record that
   * started it was lost, and then nothing here knows which distro it was in.
   */
  async keepaliveSettingChanged(): Promise<void> {
    const running = await this.runningDistros()
    const records = await this.allRecords()
    if (this.deps.keepaliveEnabled?.() === true) {
      if (!running) return
      await Promise.all(
        records
          .filter((r) => this.openProjects.get(r.host)?.size && running.includes(r.distro))
          .map((r) => this.applyKeepalive(r))
      )
      return
    }
    for (const r of records) this.keepaliveWarnings.delete(r.host)
    await Promise.all((running ?? []).map((distro) => this.queueKeepalive(distro, () => this.keepaliveOp(distro, 'stop').then(() => {}))))
  }

  /**
   * The user deleted a project. The distro's last project takes the keepalive with it, counting every
   * valid record on that distro, because there is one keepalive per distro. A closed tab does not come
   * here: closing says "not now", and its agents are meant to keep running.
   */
  async unbind(projectId: unknown, host: unknown): Promise<boolean> {
    if (typeof projectId !== 'string' || !isWslHost(host)) return false
    this.boundNow.get(host)?.delete(projectId)
    this.openProjects.get(host)?.delete(projectId)
    const saved = await this.mutate(host, (record) => {
      record.projects = record.projects.filter((p) => p !== projectId)
    })
    const record = await this.read(host)
    if (saved && record && !(await this.distroHasProjects(record.distro))) {
      this.keepaliveWarnings.delete(host)
      const running = await this.runningDistros()
      if (running?.includes(record.distro)) {
        await this.queueKeepalive(record.distro, () => this.keepaliveOp(record.distro, 'stop').then(() => {}))
      }
    }
    return saved
  }

  private async distroHasProjects(distro: string): Promise<boolean> {
    return (await this.allRecords()).some((r) => r.distro === distro && (r.projects.length > 0 || (this.boundNow.get(r.host)?.size ?? 0) > 0))
  }

  /** `--list --running` starts nothing. Null: WSL did not answer, so nothing is known to be running. */
  private async runningDistros(): Promise<string[] | null> {
    const list = await this.run(['--list', '--running', '--quiet'], { timeoutMs: LIST_TIMEOUT_MS })
    return list.code === 0 && !list.timedOut ? parseWslDistroList(list.stdout).filter(isValidDistroName) : null
  }

  private isBound(record: WslRecord, projectId: string): boolean {
    return record.projects.includes(projectId) || this.boundNow.get(record.host)?.has(projectId) === true
  }

  /** One at a time per distro, so two connects cannot both find none and both start one. */
  private queueKeepalive(distro: string, work: () => Promise<void>): Promise<void> {
    const next = (this.keepaliveWork.get(distro) ?? Promise.resolve())
      .then(work)
      .catch((e: Error) => this.deps.log?.(`[wsl] keepalive: ${e.message}`))
    this.keepaliveWork.set(distro, next)
    return next
  }

  private applyKeepalive(record: WslRecord): Promise<void> {
    return this.queueKeepalive(record.distro, () =>
      this.deps.keepaliveEnabled?.() === true ? this.startKeepalive(record) : this.stopKeepalive(record)
    )
  }

  private keepaliveOp(distro: string, op: 'find' | 'stop' | 'trim'): Promise<WslRunResult> {
    return this.run(
      ['-d', distro, '--exec', 'sh', '-c', WSL_KEEPALIVE_OPS, 'nodeterm-wsl-keepalive-op', op, WSL_KEEPALIVE_MARKER_PREFIX, WSL_KEEPALIVE_SCRIPT],
      { timeoutMs: KEEPALIVE_OP_TIMEOUT_MS }
    )
  }

  private async startKeepalive(record: WslRecord): Promise<void> {
    const fail = (why: string): void => {
      this.keepaliveWarnings.set(record.host, {
        kind: 'keepalive',
        message: `Could not keep "${record.distro}" running after the app quits (${why}). The project still works, but WSL may stop the distribution when the app closes, and its terminals with it.`
      })
    }
    this.keepaliveWarnings.delete(record.host)
    // `trim`, not `find`: it reports the one to reuse and removes any extra, so there is exactly one.
    const found = await this.keepaliveOp(record.distro, 'trim')
    if (found.code !== 0 || found.timedOut) return fail('wsl.exe did not answer')
    if (keepalivePids(found.stdout).length) return
    let failure: string | undefined
    try {
      const child = (this.deps.spawnKeepalive ?? spawnKeepaliveProcess)(wslProgram(this.platform, this.env), wslKeepaliveArgs(record))
      child.on('error', (e) => {
        failure = e.message
      })
    } catch (e) {
      return fail((e as Error).message)
    }
    const delay = this.deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    for (let i = 0; i < KEEPALIVE_VERIFY_TRIES; i++) {
      await delay(KEEPALIVE_VERIFY_GAP_MS)
      if (failure) return fail(failure)
      const check = await this.keepaliveOp(record.distro, 'find')
      if (check.code === 0 && keepalivePids(check.stdout).length) return
    }
    fail('it did not appear in the distribution')
  }

  private async stopKeepalive(record: WslRecord): Promise<void> {
    this.keepaliveWarnings.delete(record.host)
    await this.keepaliveOp(record.distro, 'stop')
  }

  private async allRecords(): Promise<WslRecord[]> {
    const out: WslRecord[] = []
    for (const handle of await this.handles()) {
      const r = await this.readHandle(handle)
      if (r) out.push(r)
    }
    return out
  }

  private async clientKeyReadable(host: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.deps.dir, handleOf(host) as string, 'id_ed25519'))
      return true
    } catch {
      return false
    }
  }

  /** Windows: this user only, before any key lands in the directory. Once per run per directory. */
  private async restrict(dir: string): Promise<void> {
    if (this.platform !== 'win32' || this.restricted.has(dir)) return
    this.restricted.add(dir)
    try {
      await (this.deps.restrictDir ?? ((d: string) => restrictWindowsDir(d, this.env)))(dir)
    } catch (e) {
      // Named, not fatal: the directory still has the profile's own access rules.
      this.deps.log?.(`[wsl] left ${dir} unchanged, on the access rules of your profile folder: ${(e as Error).message}`)
    }
  }

  /**
   * The client key this endpoint logs in with. The private key is the source of truth: the public
   * half is derived from it, and a lost or unreadable private key gets a new pair, which the caller
   * then writes to `authorized_keys`. Nothing else depends on the old one.
   */
  private async clientPublicKey(handle: string): Promise<string> {
    const dir = path.join(this.deps.dir, handle)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await this.restrict(dir)
    const utils = this.ssh2Utils()
    const file = path.join(dir, 'id_ed25519')
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    const parsed = text ? utils.parseKey(text) : new Error('missing')
    const key = (Array.isArray(parsed) ? parsed[0] : parsed) as ParsedKey | Error
    let pub: string
    if (key instanceof Error) {
      const pair = this.keyPair()
      await writeFileAtomic(file, ensureNewline(pair.private), { mode: 0o600 })
      // Always the same spelling, or an unchanged key would read as a changed `authorized_keys`.
      pub = pair.public.trim().split(/\s+/).slice(0, 2).join(' ')
      this.deps.log?.(`[wsl] the client key in ${dir} could not be read; generated a new one`)
    } else {
      pub = `${key.type} ${key.getPublicSSH().toString('base64')}`
    }
    const pubFile = path.join(dir, 'id_ed25519.pub')
    const onDisk = (await fs.readFile(pubFile, 'utf8').catch(() => '')).trim()
    if (!sameKey(onDisk, pub)) await writeFileAtomic(pubFile, `${pub}\n`, { mode: 0o600 })
    return pub
  }

  /** Bring the distro's private directory in line, and report what is missing. Never installs. */
  private ensure(host: string, opts: { force?: boolean } = {}): Promise<WslWarning[]> {
    const now = (this.deps.now ?? Date.now)()
    const hit = this.ensured.get(host)
    if (!opts.force && hit && now - hit.at < ENSURE_TTL_MS) return Promise.resolve(hit.warnings)
    const running = this.ensuring.get(host)
    if (running) return running
    const work = this.ensureNow(host).then((warnings) => {
      this.ensured.set(host, { at: (this.deps.now ?? Date.now)(), warnings })
      this.warnings.set(host, warnings)
      return warnings
    })
    this.ensuring.set(host, work)
    const clear = (): void => {
      if (this.ensuring.get(host) === work) this.ensuring.delete(host)
    }
    work.then(clear, clear)
    return work
  }

  private async ensureNow(host: string): Promise<WslWarning[]> {
    const record = await this.read(host)
    if (!record || !isValidDistroName(record.distro)) {
      throw new WslSetupError('setup-failed', 'The setup record for this WSL connection could not be read.')
    }
    const { distro } = record
    const probe = await this.probe(distro)
    if (!isSafeRemoteHome(probe.home)) {
      throw new WslSetupError('setup-failed', `"${distro}" reported a home directory that is not a plain path.`)
    }
    if (!probe.sshd) {
      const install = wslInstallCommand(probe.pm, 'sshd')
      throw new WslSetupError(
        'sshd-missing',
        `sshd is not installed in "${distro}", and a WSL project needs it to connect. Run this in the distribution, then try again: ${install}`,
        install
      )
    }
    await this.syncDistro(record, probe)
    const warnings: WslWarning[] = []
    if (!probe.tmux) {
      const install = wslInstallCommand(probe.pm, 'tmux')
      warnings.push({
        kind: 'tmux',
        install,
        message: `tmux is not installed in "${distro}", so terminals in this project cannot start. Run this in the distribution: ${install}`
      })
    }
    if (!probe.curl) {
      const install = wslInstallCommand(probe.pm, 'curl')
      warnings.push({
        kind: 'curl',
        install,
        message: `curl is not installed in "${distro}", so agents there cannot report status. Run this in the distribution: ${install}`
      })
    }
    if (record.instance && probe.instance && record.instance !== probe.instance) {
      warnings.push({
        kind: 'distro-restarted',
        message: `WSL restarted "${distro}" since this project last connected. Terminals that were running there have ended, and new ones start fresh.`
      })
    }
    if (record.user !== probe.user || record.instance !== probe.instance) {
      await this.mutate(record.host, (r) => {
        r.user = probe.user
        r.instance = probe.instance
      })
    }
    return warnings
  }

  private async probe(distro: string): Promise<WslProbe> {
    const r = await this.run(['-d', distro, '--exec', 'sh', '-c', WSL_PROBE_SCRIPT], { timeoutMs: PROBE_TIMEOUT_MS })
    if (r.timedOut) {
      throw new WslSetupError(
        'distro-timeout',
        `WSL did not answer for "${distro}" within ${PROBE_TIMEOUT_MS / 1000} seconds, so it may be stuck starting. Running \`wsl --terminate "${distro}"\` stops it, and this project tries again the next time it reconnects.`
      )
    }
    const probe = r.code === 0 ? parseWslProbe(r.stdout) : null
    if (!probe) {
      const why = decodeWslOutput(r.stderr).trim() || decodeWslOutput(r.stdout).trim() || `exit ${r.code}`
      throw new WslSetupError('distro-failed', `WSL could not start "${distro}": ${why.split(/\r?\n/)[0]}`)
    }
    return probe
  }

  private async syncDistro(record: WslRecord, probe: WslProbe): Promise<void> {
    const handle = handleOf(record.host) as string
    const clientPub = await this.clientPublicKey(handle)
    const config = wslSshdConfig(probe.home)
    const writes: { name: string; body: string }[] = []
    const present = probe.hostKeyPrivate && probe.hostKey.length > 0
    let newPin: string | undefined
    // An earlier run generated this key and stopped before moving the pin: finish the move.
    if (present && record.pendingHostKey && sameKey(probe.hostKey, record.pendingHostKey)) {
      const pin = record.pendingHostKey
      record.hostKeyPublic = pin
      record.pendingHostKey = undefined
      await this.mutate(record.host, (r) => {
        r.hostKeyPublic = pin
        delete r.pendingHostKey
      })
    }
    if (present && record.hostKeyPublic && !sameKey(probe.hostKey, record.hostKeyPublic)) {
      // The one thing the pin exists to catch: never adopt a different key silently.
      throw new WslSetupError(
        'host-key-changed',
        `The SSH host key in "${record.distro}" does not match the one this computer recorded, so the connection was refused. If you did not expect this, check the distribution. To start over, delete ~/${WSL_SSHD_DIR} in it and connect again.`
      )
    }
    if (!present || !record.hostKeyPublic) {
      // Nothing to compare: a first connect, a reinstalled distro, or local records that were lost. A
      // key already sitting in the distro is not adopted, because this code did not generate it.
      const hostKey = this.keyPair()
      if (record.hostKeyPublic) {
        this.deps.log?.(`[wsl] ${record.distro}: no host key in the distribution; generated and pinned a new one`)
      }
      writes.push({ name: 'host_ed25519', body: ensureNewline(hostKey.private) })
      writes.push({ name: 'host_ed25519.pub', body: `${hostKey.public.trim()}\n` })
      newPin = hostKey.public.trim()
    }
    const authorized = `${clientPub}\n`
    if (probe.authorized.trim().replace(/\s+/g, ' ') !== formatCksum(posixCksum(Buffer.from(authorized)))) {
      writes.push({ name: 'authorized_keys', body: authorized })
    }
    // Last, because a probe that sees no config rewrites it: a half-finished run repairs itself.
    if (probe.configSum.trim().replace(/\s+/g, ' ') !== formatCksum(posixCksum(Buffer.from(config)))) {
      writes.push({ name: 'sshd_config', body: config })
    }
    if (!writes.length) return
    if (newPin) {
      const pending = newPin
      await this.mutate(record.host, (r) => {
        r.pendingHostKey = pending
      })
    }
    const dir = `~/${WSL_SSHD_DIR}`
    const mk = await this.run(['-d', record.distro, '--exec', 'sh', '-c', `umask 077; mkdir -p ${dir} && chmod 700 ${dir}`], {
      timeoutMs: WRITE_TIMEOUT_MS
    })
    if (mk.code !== 0) {
      throw new WslSetupError('setup-failed', `Could not create ~/${WSL_SSHD_DIR} in "${record.distro}".`)
    }
    for (const w of writes) {
      const { command, stdin } = this.deps.atomicWrite(`${dir}/${w.name}`, w.body, { restrictPermissions: true, mode: '600' })
      // The body goes over stdin: a private key must never be on an argv.
      const r = await this.run(['-d', record.distro, '--exec', 'sh', '-c', command], { timeoutMs: WRITE_TIMEOUT_MS, stdin })
      if (r.code !== 0) {
        throw new WslSetupError('setup-failed', `Could not write ~/${WSL_SSHD_DIR}/${w.name} in "${record.distro}" (exit ${r.code}).`)
      }
    }
    // The pin moves only after the distro holds the key it names.
    if (newPin) {
      const pin = newPin
      await this.mutate(record.host, (r) => {
        r.hostKeyPublic = pin
        delete r.pendingHostKey
      })
    }
  }

  /**
   * ssh2 1.17 drops leading zero bytes from an Ed25519 public key, so about 1 key in 300 cannot be
   * read back (measured in native/test-keys.ts). Such a key must never become a pin or a login.
   */
  private keyPair(): { private: string; public: string } {
    const utils = this.ssh2Utils()
    for (let attempt = 0; attempt < 10; attempt++) {
      const pair = this.deps.generateKeyPair ? this.deps.generateKeyPair() : utils.generateKeyPairSync('ed25519')
      if (!(utils.parseKey(pair.private) instanceof Error) && !(utils.parseKey(pair.public) instanceof Error)) return pair
    }
    throw new WslSetupError('setup-failed', 'Could not generate a usable SSH key.')
  }

  private async recordForDistro(distro: string): Promise<WslRecord> {
    for (const handle of await this.handles()) {
      const r = await this.readHandle(handle)
      if (r?.distro === distro) return r
    }
    const handle = randomBytes(8).toString('hex')
    const slug = distro.toLowerCase().replace(SAFE_LABEL, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'distro'
    const host = `${slug}-${handle}${WSL_HOST_SUFFIX}`
    await this.clientPublicKey(handle)
    const record: WslRecord = { v: 1, host, distro, user: '', hostKeyPublic: '', projects: [] }
    await this.write(record)
    return record
  }

  private async handles(): Promise<string[]> {
    try {
      return (await fs.readdir(this.deps.dir)).filter((n) => HANDLE.test(n))
    } catch {
      return []
    }
  }

  private read(host: string): Promise<WslRecord | null> {
    const handle = handleOf(host)
    if (!handle) return Promise.resolve(null)
    return this.readHandle(handle).then((r) => (r?.host === host ? r : null))
  }

  private async readHandle(handle: string): Promise<WslRecord | null> {
    try {
      const r = JSON.parse(await fs.readFile(path.join(this.deps.dir, handle, 'endpoint.json'), 'utf8')) as WslRecord
      // A record that does not name its own directory is corrupt: skipped, so setup can start over.
      return r &&
        r.v === 1 &&
        typeof r.host === 'string' &&
        handleOf(r.host) === handle &&
        isValidDistroName(r.distro) &&
        typeof r.hostKeyPublic === 'string' &&
        Array.isArray(r.projects)
        ? r
        : null
    } catch {
      return null
    }
  }

  /**
   * Read, change and write one record, one at a time per host. The checks above run for seconds, so
   * a copy held across them would overwrite a project bound in the meantime, and that project would
   * then be refused after the next restart.
   */
  private mutate(host: string, change: (r: WslRecord) => void): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const record = await this.read(host)
      if (!record) return false
      change(record)
      await this.write(record)
      return true
    }
    const next = (this.writes.get(host) ?? Promise.resolve()).then(run, run)
    this.writes.set(host, next.catch(() => false))
    return next
  }

  private async write(record: WslRecord): Promise<void> {
    const handle = handleOf(record.host) as string
    await fs.mkdir(path.join(this.deps.dir, handle), { recursive: true, mode: 0o700 })
    await writeFileAtomic(path.join(this.deps.dir, handle, 'endpoint.json'), JSON.stringify(record, null, 2), { mode: 0o600 })
  }
}

/** The keepalive's argv, after the program. `$0` is the marker `WSL_KEEPALIVE_OPS` looks for. */
function wslKeepaliveArgs(record: WslRecord): string[] {
  return ['-d', record.distro, '--exec', 'sh', '-c', WSL_KEEPALIVE_SCRIPT, wslKeepaliveMarker(handleOf(record.host) as string)]
}

function keepalivePids(stdout: Buffer): string[] {
  return [...stdout.toString('latin1').replace(/\0/g, '').matchAll(/^NTWSL keepalive=(\d+)\r?$/gm)].map((m) => m[1])
}

function ensureNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`
}

/** Compare the key itself: the comment after it is not part of the identity. */
function sameKey(a: string, b: string): boolean {
  const body = (s: string): string => s.trim().split(/\s+/).slice(0, 2).join(' ')
  return body(a) === body(b)
}

let service: WslEndpoints | null = null

/** Main installs the service here; until it does, a WSL host resolves to nothing. */
export function setWslEndpoints(s: WslEndpoints | null): void {
  service = s
}

export function wslEndpoints(): WslEndpoints | null {
  return service
}
