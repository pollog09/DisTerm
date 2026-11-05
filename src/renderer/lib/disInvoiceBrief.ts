import { disInvoiceBrief, type DisInvoiceApi } from '@shared/dis-invoice'
import { isWslShellValue } from '@shared/terminal-profiles'
import { writePromptFile, type PromptSpillIo } from './promptSpill'

export type DisInvoiceBriefFile = { ok: true; path: string } | { ok: false; notice: string }

export interface DisInvoiceBriefRequest {
  text: string
  taskId: number
  /** An SSH project's pane runs on the host, which cannot read a file on this machine. */
  ssh: boolean
  /** The shell the new pane will have, read the way the spawn resolves it. */
  paneShell: string | undefined
}

/**
 * The prompt file for an agent started on a task, as that agent's pane will read it. There is no
 * inline fallback, since that would type client text into the pane, so anything short of a path the
 * pane can read refuses the start.
 */
export async function disInvoiceBriefFile(
  { text, taskId, ssh, paneShell }: DisInvoiceBriefRequest,
  io: PromptSpillIo & Pick<DisInvoiceApi, 'briefPathInWsl'>
): Promise<DisInvoiceBriefFile> {
  if (ssh) return { ok: false, notice: 'An agent on an SSH project cannot read the brief, because it stays on this machine.' }
  const path = await writePromptFile(disInvoiceBrief(text, taskId), io)
  if (!path) return { ok: false, notice: 'Could not write the task brief, so no agent was started.' }
  if (!isWslShellValue(paneShell)) return { ok: true, path }
  const inWsl = await io.briefPathInWsl(paneShell, path)
  return inWsl.ok
    ? { ok: true, path: inWsl.path }
    : { ok: false, notice: `This agent would start in WSL, where it cannot read the task brief, so it was not started. ${inWsl.message}` }
}
