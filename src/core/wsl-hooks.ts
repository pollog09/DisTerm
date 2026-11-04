// Status hooks for a plain WSL terminal (`wsl:<distro>`). A WSL PROJECT gets them over its ssh
// tunnel; this is the no-sshd route for a terminal opened with the WSL shell. Without it a Claude in
// such a pane reports nothing: its config is the distro's ~/.claude, not the Windows one our
// installer writes, the pane's env stops at wsl.exe, and Windows loopback is out of reach. So no
// status, no agent graph, no subagent cards.
//
// Three parts: `wslHookEnv` forwards what the hook script needs through WSLENV, the script reaches
// the hook server through curl.exe (WSL_INTEROP_CURL_SH in managed-script.ts), and `ensureWslHooks`
// installs the hook in the distro under the machine's existing consent for that agent.
//
// Claude only so far: the other agents' installers are not wired to a distro here.
import { posixQuote } from '../shared/ssh'
import { agentChoice } from '../shared/agent-integrations'
import { CLAUDE_HOOK_EVENTS } from '../shared/agents/hook-events'
import type { Settings } from '../shared/types'
import { buildManagedHookCommand, mergeManagedHook, stripManagedHook } from './agents/hooks/install-helper'
import { buildManagedScript } from './agents/hooks/managed-script'
import {
  stripRemoteSettingsFile,
  updateRemoteSettingsFileResult,
  updateRemoteTextFile,
  type SettingsRunner
} from './agents/hooks/remote-settings-file'
import { isSafeRemoteHome } from './remote-safety'
import { wslRunner } from './remote-ssh/native/wsl-endpoint'
import { wslExe } from './terminal-profiles'
import { windowsSystemDrive } from './win32-powershell'

/**
 * What a WSL pane may inherit, by name. Measured: only names listed in WSLENV cross wsl.exe, they
 * survive into the login shell, and `/p` converts a Windows path to its /mnt form.
 *
 * NOT forwarded, on purpose:
 *  - NODETERM_PERM_WAIT_SECS: an approval answer is a file core writes on Windows, which the script
 *    in the distro polls in ITS OWN ~/.nodeterm, so a held prompt could only ever time out.
 *  - NODETERM_CANVAS_CONTROL: no control shim is installed in the distro, so the grant would name a
 *    tool that is not there.
 *  - NODETERM_HOOK_SOCK: a Windows path, and this transport uses the port.
 */
const FORWARDED: ReadonlyArray<readonly [name: string, flag: string]> = [
  ['NODETERM_NODE_ID', ''],
  ['NODETERM_AGENT_ID', ''],
  ['NODETERM_HOOK_VERSION', ''],
  ['NODETERM_HOOK_ENDPOINT', '/p'],
  ['NODETERM_WSL_CURL', '/p']
]

/** The env a WSL pane adds to `hookEnv`. Empty when this session has no hook identity. A WSLENV the
 *  user already set keeps its entries, and their spelling of a name we also forward wins nothing:
 *  ours replaces it, because the script needs the converted path. */
export function wslHookEnv(
  hookEnv: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  if (!hookEnv.NODETERM_NODE_ID) return {}
  const values: Record<string, string> = {
    ...hookEnv,
    NODETERM_WSL_CURL: `${windowsSystemDrive(env as NodeJS.ProcessEnv)}:\\Windows\\System32\\curl.exe`
  }
  const ours = FORWARDED.filter(([name]) => values[name] !== undefined)
  const names = new Set(ours.map(([name]) => name))
  const kept = (env.WSLENV ?? '')
    .split(':')
    .filter((entry) => entry && !names.has(entry.split('/')[0]))
  return {
    NODETERM_WSL_CURL: values.NODETERM_WSL_CURL,
    WSLENV: [...kept, ...ours.map(([name, flag]) => `${name}${flag}`)].join(':')
  }
}

export type WslHooksOutcome = 'installed' | 'removed' | 'skipped' | 'failed'

/**
 * Bring one distro to this machine's answer for claude: enabled installs, declined removes what we
 * wrote (the user's own hooks survive), never asked touches nothing. `~/.claude` must already exist:
 * a distro that has never run Claude is not given a config directory for it, and the next terminal
 * opened after Claude's first run installs.
 */
export async function ensureWslHooks(settings: Settings, run: SettingsRunner): Promise<WslHooksOutcome> {
  const choice = agentChoice(settings, 'claude')
  if (choice !== 'enabled' && choice !== 'declined') return 'skipped'
  const homeRead = await run('printf %s "$HOME"')
  const home = homeRead.stdout.trim()
  if (homeRead.code !== 0 || !isSafeRemoteHome(home)) return 'failed'
  const scriptPath = `${home}/.nodeterm/agent-hooks/claude.sh`
  const config = `${home}/.claude/settings.json`
  if (choice === 'declined') {
    const stripped = await stripRemoteSettingsFile(config, run, (cfg) => stripManagedHook(cfg, 'claude.sh', CLAUDE_HOOK_EVENTS))
    if (stripped === 'failed') return 'failed'
    await run(`rm -f -- ${posixQuote(scriptPath)}`)
    return 'removed'
  }
  const hasClaude = await run(`[ -d ${posixQuote(`${home}/.claude`)} ]`)
  if (hasClaude.code !== 0) return 'skipped'
  // The same bytes a WSL project's connect writes (no codex identity root in a distro).
  const body = buildManagedScript('claude', null)
  const wrote = await updateRemoteTextFile(scriptPath, run, (before) => (before === body ? null : body))
  if (wrote === 'failed') return 'failed'
  const merged = await updateRemoteSettingsFileResult(config, run, (cfg) =>
    mergeManagedHook(cfg, buildManagedHookCommand(scriptPath), CLAUDE_HOOK_EVENTS)
  )
  return merged === 'failed' ? 'failed' : 'installed'
}

/** One wsl.exe call; a stuck distro must not hold a terminal open. */
const WSL_HOOK_CALL_TIMEOUT_MS = 15_000
/** How long a new terminal waits. Claude reads its hooks when it starts, so waiting is what makes
 *  an agent launched into this pane report from its first event, but the terminal matters more:
 *  past this it opens anyway and the install finishes behind it. */
const WSL_HOOK_WAIT_MS = 4_000

function distroRunner(distro: string): SettingsRunner {
  const wsl = wslRunner(wslExe())
  return async (command, stdin) => {
    const r = await wsl(['-d', distro, '--exec', 'sh', '-c', command], { timeoutMs: WSL_HOOK_CALL_TIMEOUT_MS, stdin })
    return { code: r.code ?? 1, stdout: r.stdout.toString('utf8') }
  }
}

/** Settled per distro AND answer, so a later consent change still reaches a distro this run. */
const settled = new Set<string>()
const inFlight = new Map<string, Promise<void>>()

/** Never throws and never fails a spawn: a pane with no hook is only a pane with no status. A failed
 *  or skipped outcome is retried by the next terminal opened on that distro. */
export async function ensureWslHooksBounded(
  distro: string,
  settings: Settings,
  makeRunner: (distro: string) => SettingsRunner = distroRunner,
  waitMs: number = WSL_HOOK_WAIT_MS
): Promise<void> {
  const key = `${distro}\0${agentChoice(settings, 'claude') ?? ''}`
  if (settled.has(key)) return
  let work = inFlight.get(key)
  if (!work) {
    work = ensureWslHooks(settings, makeRunner(distro))
      .then((outcome) => {
        if (outcome === 'installed' || outcome === 'removed') settled.add(key)
        if (outcome === 'failed') console.warn(`[wsl-hooks] could not update the Claude hook in ${distro}`)
      })
      .catch((err: unknown) => console.warn(`[wsl-hooks] could not update the Claude hook in ${distro}`, err))
      .finally(() => inFlight.delete(key))
    inFlight.set(key, work)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))])
  clearTimeout(timer)
}

/** Test seam: the memo is per app run. */
export function resetWslHooksForTest(): void {
  settled.clear()
  inFlight.clear()
}
