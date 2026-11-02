// A terminal profile is a value of the existing machine-local `shell` / `settings.defaultShell`
// fields, so it inherits their trust boundary (`shared/node-exec.ts`): never written to a shared
// project file, never accepted from a peer. A WSL distribution is spelled `wsl:<encoded name>`;
// the trusted core turns that into argv (`core/terminal-profiles.ts`).

export type TerminalProfileKind = 'default' | 'windows' | 'wsl'

/** One row of the shell picker. `value` is what is stored in the `shell` field. */
export interface TerminalProfile {
  value: string
  label: string
  kind: TerminalProfileKind
}

const WSL_PREFIX = 'wsl:'
const WSL_SHELL = /^wsl:[A-Za-z0-9_.%-]+$/
const MAX_DISTRO_NAME = 128

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** Whether a `shell` value claims to be a WSL profile, valid or not. A malformed one is refused by
 *  name; it must not fall through to another shell. */
export function isWslShellValue(shell: unknown): shell is string {
  return typeof shell === 'string' && shell.trim().startsWith(WSL_PREFIX)
}

/** The `shell` value for a distribution. Everything outside the safe set is percent-encoded, so a
 *  name with spaces still passes `safeSessionProgram`. */
export function wslShellValue(distro: string): string {
  const encoded = encodeURIComponent(distro).replace(
    /[!'()*~]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `${WSL_PREFIX}${encoded}`
}

/**
 * The distribution named by a `shell` value, or null when it is not a valid WSL profile. The name
 * becomes one argv element after `wsl.exe -d`, so a leading `-` (an option) and control characters
 * are refused here rather than at the spawn.
 */
export function parseWslShell(shell: string | undefined | null): string | null {
  if (!shell || !WSL_SHELL.test(shell)) return null
  let distro: string
  try {
    distro = decodeURIComponent(shell.slice(WSL_PREFIX.length))
  } catch {
    return null
  }
  if (!distro || distro.length > MAX_DISTRO_NAME) return null
  if (distro.startsWith('-') || CONTROL.test(distro)) return null
  return distro
}
