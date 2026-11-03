// How a LOCAL git command runs, including for a repository inside a WSL distribution.
//
// A Windows core reaches a WSL project through its UNC path (`\\wsl.localhost\Ubuntu\home\me\repo`).
// Git for Windows must not be the git that reads it. MEASURED on Windows 11, git 2.49 against a
// repository in Ubuntu (git 2.43):
//   - it refuses the folder outright ("detected dubious ownership"), because a Linux uid is not the
//     Windows user;
//   - with that check waived it lists every executable file as changed (`mode change 100755 =>
//     100644`), and staging those strips the exec bits from the repository;
//   - `git status` takes 3.9 s over the 9P share, against 0.35 s through this path.
// So git runs inside the distribution, as the same user and with the same credentials as the
// project's own WSL terminals. Waiving the check with `safe.directory` would keep the other two.
//
// Paths cross the boundary in both directions: a UNC argument becomes a Linux path going in, and the
// two commands that print absolute paths have them mapped back. Elsewhere the command is unchanged.

import type { ExecFileOptions } from 'child_process'
import { wslExe } from './terminal-profiles'

export interface WslRepoRef {
  distro: string
  /** The path inside the distribution. */
  linuxPath: string
  /** `//wsl.localhost/Ubuntu`, spelled with forward slashes as Git for Windows prints its paths. */
  windowsRoot: string
}

const WSL_UNC = /^[\\/]{2}(wsl\.localhost|wsl\$)[\\/]([^\\/]+)([\\/].*)?$/i
const SAFE_DISTRO = /^[A-Za-z0-9][\w.-]*$/

/** The distribution holding `cwd`, or null for every path that is not a WSL path on a Windows core. */
export function wslRepoRef(
  cwd: string,
  platform: NodeJS.Platform | string = process.platform
): WslRepoRef | null {
  if (platform !== 'win32') return null
  const m = WSL_UNC.exec(cwd)
  if (!m || !SAFE_DISTRO.test(m[2]!)) return null
  return {
    distro: m[2]!,
    linuxPath: (m[3] ?? '/').replace(/\\/g, '/'),
    windowsRoot: `//${m[1]}/${m[2]}`
  }
}

/** A UNC path in the same distribution goes in as its Linux path. Anything else passes unchanged. */
function argForDistro(arg: string, ref: WslRepoRef): string {
  const m = WSL_UNC.exec(arg)
  if (!m || m[2]!.toLowerCase() !== ref.distro.toLowerCase()) return arg
  return (m[3] ?? '/').replace(/\\/g, '/')
}

/** Maps the absolute paths git prints back to paths this Windows process can open. */
function outputForWindows(args: string[], out: string, ref: WslRepoRef): string {
  if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
    return out.startsWith('/') ? `${ref.windowsRoot}${out}` : out
  }
  if (args[0] === 'worktree' && args[1] === 'list') {
    return out.replace(/^worktree (\/.*)$/gm, (_, p: string) => `worktree ${ref.windowsRoot}${p}`)
  }
  return out
}

/** wsl.exe forwards only the variables WSLENV names. A push with no credentials must still fail fast. */
function envForDistro(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const forwarded = env.WSLENV ? `${env.WSLENV}:GIT_TERMINAL_PROMPT` : 'GIT_TERMINAL_PROMPT'
  return { ...env, WSLENV: forwarded }
}

export interface LocalGitCommand {
  file: string
  args: string[]
  options: ExecFileOptions
  /** Apply to stdout before reading paths from it. */
  mapOutput: (stdout: string) => string
}

/** The one place that decides how a local `git <args>` in `cwd` is spawned. */
export function localGitCommand(
  cwd: string,
  args: string[],
  options: ExecFileOptions = {},
  platform: NodeJS.Platform | string = process.platform
): LocalGitCommand {
  const ref = wslRepoRef(cwd, platform)
  if (!ref) {
    return { file: 'git', args, options: { ...options, cwd }, mapOutput: (stdout) => stdout }
  }
  return {
    file: wslExe(),
    args: [
      '-d',
      ref.distro,
      '--exec',
      'git',
      '-C',
      ref.linuxPath,
      ...args.map((arg) => argForDistro(arg, ref))
    ],
    options: {
      ...options,
      env: envForDistro(options.env ?? process.env),
      windowsHide: true
    },
    mapOutput: (stdout) => outputForWindows(args, stdout, ref)
  }
}

/**
 * Why a failed `rev-parse --is-inside-work-tree` is not "this folder has no repository", or null
 * when it is. Git's own `fatal:` answers mean no repository, except a refused folder. Anything else
 * means git never got to answer: not installed, distribution not running, SSH down.
 */
export function gitReadFailure(err: string): string | null {
  const text = err.trim()
  if (!text) return null
  if (/safe\.directory/i.test(text)) return text
  return /^fatal:/i.test(text) ? null : text
}
