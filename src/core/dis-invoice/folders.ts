import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { localChildName, uniqueChildName } from '../download-name'
import type { DisInvoiceFolderResult } from '../../shared/dis-invoice'

const MAX_NAME_LENGTH = 80

export function disInvoiceBaseDir(documentsDir: string | undefined): string {
  return path.join(documentsDir ?? path.join(os.homedir(), 'Documents'), 'Distriib')
}

/**
 * The folder for a dis-invoice project, safe on every platform because a canvas and its folder can
 * outlive the machine they were named on. `taken` holds the names other projects already own, and is
 * compared case-insensitively for the same reason. A name with nothing usable in it is `proyecto-<id>`.
 */
export function disInvoiceFolderName(nombre: string, proyectoId: number, taken: Set<string>): string {
  const withoutTrailingDots = nombre.trim().replace(/[. ]+$/, '')
  const safe = withoutTrailingDots ? localChildName(withoutTrailingDots, 'win32') : null
  const clamped = safe?.slice(0, MAX_NAME_LENGTH).replace(/[. ]+$/, '')
  return uniqueChildName(clamped || `proyecto-${proyectoId}`, taken, 'win32')
}

export async function readDisInvoiceFolder(folder: string, { create }: { create: boolean }): Promise<DisInvoiceFolderResult> {
  try {
    if (create) await fs.mkdir(folder, { recursive: true })
    const entries = await fs.readdir(folder)
    return { ok: true, folder, empty: entries.length === 0, isRepo: entries.includes('.git') }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error'
    return { ok: false, message: `Could not ${create ? 'create' : 'read'} ${folder} (${code}).` }
  }
}
