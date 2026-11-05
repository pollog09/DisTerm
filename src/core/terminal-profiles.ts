// The Windows terminal profile catalog and the trusted WSL launch plan. See
// docs/windows-session-host.md, "Windows profile resolution". Every subprocess goes through an
// injected exec, so the parsing and failure rules are testable on any CI host.

import { execFile } from 'child_process'
import { wslShellValue, type TerminalProfile } from '../shared/terminal-profiles'
import { windowsSystemDrive } from './win32-powershell'

export interface ExecResult {
  code: number
  stdout: Buffer
  stderr: Buffer
}

export type ProfileExec = (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>

export interface WslLaunchPlan {
  file: string
  args: string[]
}

const WSL_LIST_TIMEOUT_MS = 10_000
const WSL_TRANSLATE_TIMEOUT_MS = 30_000

/** Docker Desktop's own distributions have no user shell. */
const NON_SHELL_DISTROS = new Set(['docker-desktop', 'docker-desktop-data'])

/**
 * `wsl.exe --cd <missing>` prints an error, then runs the command anyway and exits 0 (measured), so
 * it cannot keep a terminal out of the wrong directory. This changes directory itself and stops on
 * failure, then replaces itself with the user's login shell from the passwd database.
 */
export const WSL_CWD_GUARD =
  'cd -- "${1:-$HOME}" || exit 71; ' +
  's=$(getent passwd "$(id -u)" | cut -d: -f7); ' +
  '[ -x "$s" ] || s=/bin/sh; ' +
  'exec "$s" -l'

/** An absolute path built from a fixed table, for the same reason as `powershellExe`. */
export function wslExe(env: NodeJS.ProcessEnv = process.env): string {
  return `${windowsSystemDrive(env)}:\\Windows\\System32\\wsl.exe`
}

/** `wsl.exe` writes UTF-16LE from its own commands unless `WSL_UTF8=1` is set. */
export function decodeWslOutput(raw: Buffer): string {
  const text = raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf8')
  return text.replace(/^﻿/, '')
}

export function parseWslDistroList(raw: Buffer): string[] {
  return decodeWslOutput(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => name && !NON_SHELL_DISTROS.has(name.toLowerCase()))
}

const defaultExec: ProfileExec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'buffer', timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') {
          reject(err)
          return
        }
        resolve({ code: err ? (err.code as unknown as number) : 0, stdout, stderr })
      }
    )
  })

/** Distributions with a usable shell. No WSL installed is an empty list, not an error. */
export async function listWslDistros(exec: ProfileExec = defaultExec): Promise<string[]> {
  try {
    const result = await exec(wslExe(), ['--list', '--quiet'], WSL_LIST_TIMEOUT_MS)
    return result.code === 0 ? parseWslDistroList(result.stdout) : []
  } catch {
    return []
  }
}

/** Distributions running now. `--running` starts nothing. Null: WSL did not answer, so nothing is
 *  known to be running. */
export async function listRunningWslDistros(exec: ProfileExec = defaultExec): Promise<string[] | null> {
  try {
    const result = await exec(wslExe(), ['--list', '--running', '--quiet'], WSL_LIST_TIMEOUT_MS)
    return result.code === 0 ? parseWslDistroList(result.stdout) : null
  } catch {
    return null
  }
}

/** The picker's rows. Empty on a non-Windows core, where the shell stays a free-text setting. */
export async function listTerminalProfiles(
  platform: NodeJS.Platform | string,
  exec: ProfileExec = defaultExec
): Promise<TerminalProfile[]> {
  if (platform !== 'win32') return []
  const distros = await listWslDistros(exec)
  return [
    { value: '', label: 'System default', kind: 'default' },
    { value: 'pwsh', label: 'PowerShell 7', kind: 'windows' },
    { value: 'powershell', label: 'Windows PowerShell', kind: 'windows' },
    { value: 'cmd', label: 'Command Prompt', kind: 'windows' },
    ...distros.map(
      (name): TerminalProfile => ({ value: wslShellValue(name), label: `WSL: ${name}`, kind: 'wsl' })
    )
  ]
}

async function translateCwd(distro: string, cwd: string, exec: ProfileExec): Promise<string> {
  if (cwd.startsWith('/')) return cwd
  const result = await exec(
    wslExe(),
    ['-d', distro, '--exec', 'wslpath', '-a', '-u', cwd],
    WSL_TRANSLATE_TIMEOUT_MS
  )
  const linuxPath = decodeWslOutput(result.stdout).trim()
  if (result.code !== 0 || !linuxPath.startsWith('/')) {
    const reason = decodeWslOutput(result.stderr).trim() || linuxPath || `exit ${result.code}`
    throw new Error(`WSL could not open "${cwd}" in ${distro}: ${reason}`)
  }
  return linuxPath
}

/**
 * The argv for one WSL terminal. Throws with the real reason when the directory cannot be
 * translated: an explicitly chosen profile never becomes a different shell or directory.
 */
export async function resolveWslLaunch(
  distro: string,
  cwd: string | undefined,
  exec: ProfileExec = defaultExec
): Promise<WslLaunchPlan> {
  const linuxCwd = cwd ? await translateCwd(distro, cwd, exec) : undefined
  return {
    file: wslExe(),
    args: [
      '-d',
      distro,
      '--exec',
      'sh',
      '-c',
      WSL_CWD_GUARD,
      'nodeterm-wsl',
      ...(linuxCwd ? [linuxCwd] : [])
    ]
  }
}
