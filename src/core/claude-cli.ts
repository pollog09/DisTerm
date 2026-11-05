// Capability probe for the LOCAL Claude CLI. Today it answers exactly one question — does this
// CLI accept `--permission-mode auto`? (Claude Code >= 2.1.71; older CLIs exit 1 on the value, see
// AUTO_PERMISSION_MODE_MIN_VERSION) — but it is shaped as a caps bag so the next version-gated
// flag lands here instead of growing another probe.
//
// Lives in core (not main) so the Server Edition boots it through the same CorePlatform seam.
// The remote (SSH) CLI is probed separately on its own host — see SshProjectManager.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { supportsAutoPermissionMode, supportsFullscreenTui } from '../shared/agents/config'
import { IPC } from '../shared/ipc'
import { posixQuote } from '../shared/ssh'
import { parseWslShell } from '../shared/terminal-profiles'
import { UNKNOWN_CLAUDE_CLI_CAPS, type ClaudeCliCaps } from '../shared/types'
import { directExecutableInvocation } from './exec-path'
import { findInLoginPath } from './pty-manager'
import { platform } from './platform'
import { wslProfileExec, wslRunner } from './remote-ssh/native/wsl-endpoint'
import { listRunningWslDistros, wslExe } from './terminal-profiles'

const execFileP = promisify(execFile)
const PROBE_TIMEOUT_MS = 5000

export { UNKNOWN_CLAUDE_CLI_CAPS, type ClaudeCliCaps }

/**
 * Pure: probe output → caps. The impure probe below is just plumbing around it.
 *
 * `--session-id` is FEATURE-detected from `--help` rather than gated on a version, because the
 * release it first appeared in is not documented anywhere this repo can verify. Guessing a floor
 * is uniquely dangerous for this flag: an unrecognised flag makes the CLI exit, so a floor set too
 * low would kill every claude launch on the machines below it. Reading the help text asks the CLI
 * in front of us what it actually accepts. Absent help output ⇒ false ⇒ no flag ⇒ today's command.
 */
export function claudeCliCapsFrom(
  versionOutput: string | null | undefined,
  helpOutput?: string | null
): ClaudeCliCaps {
  const version = versionOutput?.trim() || null
  return {
    version,
    autoPermissionMode: supportsAutoPermissionMode(version),
    fullscreenTui: supportsFullscreenTui(version),
    // Anchored on a word boundary so `--session-id-file` or prose mentioning the flag inside
    // another option's description cannot answer yes for it.
    sessionIdFlag: /(^|\s)--session-id(\s|=|$)/m.test(helpOutput ?? '')
  }
}

export async function probeClaudeCliAt(bin: string): Promise<ClaudeCliCaps> {
  try {
    const versionInvocation = directExecutableInvocation(bin, ['--version'])
    if (!versionInvocation) return UNKNOWN_CLAUDE_CLI_CAPS
    const { stdout } = await execFileP(versionInvocation.executable, versionInvocation.args, {
      ...versionInvocation.options,
      timeout: PROBE_TIMEOUT_MS
    })
    // `--help` is a second spawn, paid once per process (this whole probe is memoized). Its
    // failure must not cost us the version answer, so it degrades on its own: no help text just
    // means no minted session ids.
    const helpInvocation = directExecutableInvocation(bin, ['--help'])
    const help = helpInvocation
      ? await execFileP(helpInvocation.executable, helpInvocation.args, {
          ...helpInvocation.options,
          timeout: PROBE_TIMEOUT_MS
        })
          .then((r) => r.stdout)
          .catch(() => null)
      : null
    return claudeCliCapsFrom(stdout, help)
  } catch {
    // Missing CLI, timeout, non-zero exit — all mean "unknown", which means "omit the flag".
    return UNKNOWN_CLAUDE_CLI_CAPS
  }
}

let cached: Promise<ClaudeCliCaps> | null = null

async function probe(): Promise<ClaudeCliCaps> {
  // GUI apps don't inherit the shell PATH — resolve through the login shell like every other
  // CLI lookup in the app (pty-manager, commit-message).
  const bin = await findInLoginPath('claude')
  if (!bin) return UNKNOWN_CLAUDE_CLI_CAPS
  return probeClaudeCliAt(bin)
}

/**
 * The local Claude CLI's capabilities. Memoized for the process lifetime: `claude --version`
 * spawns a login shell + node, and the answer only changes when the user upgrades the CLI (which a
 * relaunch picks up). Never rejects.
 */
export function claudeCliCaps(): Promise<ClaudeCliCaps> {
  if (!cached) cached = probe()
  return cached
}

const WSL_VERSION_START = '__NT_WSL_V_START__'
const WSL_VERSION_END = '__NT_WSL_V_END__'
const WSL_HELP_START = '__NT_WSL_H_START__'
const WSL_HELP_END = '__NT_WSL_H_END__'
/** A first call boots the distribution, and the login shell then runs its profile. */
const WSL_PROBE_TIMEOUT_MS = 20_000

/**
 * `claude --version` and `--help` inside a distribution, in one call. Through the user's login shell
 * from the passwd database, as a WSL terminal runs: `wsl.exe --exec` has no `$SHELL` to rely on. The
 * values are delimited because a profile prints whatever it likes (see claude-version-probe.ts). A
 * login shell that cannot read this body (fish, nushell) falls through to `sh`.
 */
export function wslClaudeProbeCommand(): string {
  const emit =
    `PATH="$HOME/.local/bin:$HOME/.claude/local:$PATH"; ` +
    `v=$(claude --version 2>/dev/null) && [ -n "$v" ] && ` +
    `printf '${WSL_VERSION_START}%s${WSL_VERSION_END}' "$v" && ` +
    `printf '${WSL_HELP_START}%s${WSL_HELP_END}' "$(claude --help 2>/dev/null)"`
  const body = posixQuote(emit)
  return (
    `s=$(getent passwd "$(id -u)" | cut -d: -f7); [ -x "$s" ] || s=/bin/sh; ` +
    `"$s" -lc ${body} 2>/dev/null || sh -c ${body} 2>/dev/null`
  )
}

function between(text: string, start: string, end: string): string | null {
  const from = text.indexOf(start)
  if (from < 0) return null
  const to = text.indexOf(end, from + start.length)
  return to < 0 ? null : text.slice(from + start.length, to)
}

/** Pure: probe output → caps. No version between the markers is the unknown, never a modern CLI. */
export function parseWslClaudeProbe(stdout: string | null | undefined): ClaudeCliCaps {
  const version = stdout ? between(stdout, WSL_VERSION_START, WSL_VERSION_END) : null
  if (!version?.trim()) return UNKNOWN_CLAUDE_CLI_CAPS
  return claudeCliCapsFrom(version, between(stdout!, WSL_HELP_START, WSL_HELP_END))
}

export interface WslClaudeProbeDeps {
  run(distro: string, command: string): Promise<string | null>
  running(): Promise<string[] | null>
}

const defaultWslProbeDeps: WslClaudeProbeDeps = {
  run: async (distro, command) => {
    const r = await wslRunner(wslExe())(['-d', distro, '--exec', 'sh', '-c', command], {
      timeoutMs: WSL_PROBE_TIMEOUT_MS
    })
    return r.timedOut ? null : r.stdout.toString('utf8')
  },
  running: () => listRunningWslDistros(wslProfileExec)
}

const wslCaps = new Map<string, ClaudeCliCaps>()
/** One probe per question at a time: a cold restore of N nodes asks N times during a distro's boot. */
const wslProbes = new Map<string, Promise<ClaudeCliCaps>>()

/**
 * The Claude CLI inside a distribution. Refuses off Windows and for a value that is not a valid
 * profile, since the name becomes an argv element. A found CLI is memoized for the run like the local
 * one; a miss is not, because the distribution may simply not have been up. Never rejects.
 */
export async function wslClaudeCliCaps(
  shell: unknown,
  opts: { ifRunning?: boolean } = {},
  deps: WslClaudeProbeDeps = defaultWslProbeDeps,
  runtimePlatform: NodeJS.Platform | string = process.platform
): Promise<ClaudeCliCaps> {
  const distro = typeof shell === 'string' ? parseWslShell(shell) : null
  if (!distro || runtimePlatform !== 'win32') return UNKNOWN_CLAUDE_CLI_CAPS
  const known = wslCaps.get(distro)
  if (known) return known
  // Apart for each mode: one that must not boot the distribution cannot answer one that may.
  const key = `${distro}\0${opts.ifRunning === true}`
  const pending = wslProbes.get(key)
  if (pending) return pending
  const probe = (async (): Promise<ClaudeCliCaps> => {
    try {
      if (opts.ifRunning) {
        const running = await deps.running()
        if (!running?.some((d) => d.toLowerCase() === distro.toLowerCase())) return UNKNOWN_CLAUDE_CLI_CAPS
      }
      const caps = parseWslClaudeProbe(await deps.run(distro, wslClaudeProbeCommand()))
      if (caps.version) wslCaps.set(distro, caps)
      return caps
    } catch {
      return UNKNOWN_CLAUDE_CLI_CAPS
    } finally {
      wslProbes.delete(key)
    }
  })()
  wslProbes.set(key, probe)
  return probe
}

/** Test seam: the memo is per app run. */
export function resetWslClaudeCliCapsForTest(): void {
  wslCaps.clear()
  wslProbes.clear()
}

/** Wire the probe onto the platform's RPC surface (Electron ipcMain / server WS-RPC alike). */
export function registerClaudeCliIpc(): void {
  platform().handle(IPC.claudeCliCaps, () => claudeCliCaps())
  platform().handle(IPC.claudeWslCliCaps, (shell: unknown, opts?: { ifRunning?: boolean }) =>
    wslClaudeCliCaps(shell, { ifRunning: opts?.ifRunning === true })
  )
}
