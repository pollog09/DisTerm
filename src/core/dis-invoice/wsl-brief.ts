import type { DisInvoiceWslPathResult } from '../../shared/dis-invoice'
import { parseWslShell } from '../../shared/terminal-profiles'
import { wslExe, wslLinuxPath, type ProfileExec } from '../terminal-profiles'

const READ_CHECK_TIMEOUT_MS = 30_000

/**
 * A brief saved on this machine, as a pane in the `shell` distribution reads it. The typed line is
 * `"$(cat <path>)"`, and a `cat` that fails starts the agent on an empty prompt with no word, so the
 * file is read-checked in there too: automount can be off, or the folder out of its reach.
 */
export async function readableBriefPathInWsl(shell: unknown, file: string, exec: ProfileExec): Promise<DisInvoiceWslPathResult> {
  const distro = typeof shell === 'string' ? parseWslShell(shell) : null
  if (!distro) return { ok: false, message: 'That is not a WSL distribution.' }
  try {
    const path = await wslLinuxPath(distro, file, exec)
    const read = await exec(wslExe(), ['-d', distro, '--exec', 'test', '-r', path], READ_CHECK_TIMEOUT_MS)
    return read.code === 0 ? { ok: true, path } : { ok: false, message: `${distro} cannot read ${path}.` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
