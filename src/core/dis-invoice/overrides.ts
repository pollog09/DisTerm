import path from 'node:path'
import { DIS_INVOICE_CONNECTOR_URL, connectorBaseUrl } from './client'

export const DIS_INVOICE_URL_ENV = 'DISTERM_DIS_INVOICE_URL'
export const DIS_INVOICE_DOCUMENTS_ENV = 'DISTERM_DIS_INVOICE_DOCUMENTS'

export interface DisInvoiceOverrides {
  url?: string
  documentsDir?: string
}

const loopbackUrl = (env: NodeJS.ProcessEnv): string | null => {
  const url = connectorBaseUrl(env[DIS_INVOICE_URL_ENV])
  return url === DIS_INVOICE_CONNECTOR_URL ? null : url
}

/**
 * A development build's overrides. A packaged one takes none: the key goes wherever the URL points,
 * and any local process can listen on a loopback port. The Server Edition reports itself packaged on
 * every run, so its only way in is `disInvoiceProofOverrides`, from its proof entry point.
 */
export function disInvoiceDevOverrides(env: NodeJS.ProcessEnv, isPackaged: boolean): DisInvoiceOverrides {
  const url = isPackaged ? null : loopbackUrl(env)
  return url ? { url, documentsDir: env[DIS_INVOICE_DOCUMENTS_ENV] } : {}
}

/** The proof entry point runs only sandboxed: with neither override it would be a real server using
 *  the production connector and the real Documents folder. */
export function disInvoiceProofOverrides(
  env: NodeJS.ProcessEnv
): { ok: true; overrides: Required<DisInvoiceOverrides> } | { ok: false; message: string } {
  const url = loopbackUrl(env)
  if (!url) return { ok: false, message: `${DIS_INVOICE_URL_ENV} must be a loopback http:// URL, such as the fake connector's.` }
  const documentsDir = env[DIS_INVOICE_DOCUMENTS_ENV]
  if (!documentsDir || !path.isAbsolute(documentsDir)) {
    return { ok: false, message: `${DIS_INVOICE_DOCUMENTS_ENV} must be an absolute path to a scratch folder.` }
  }
  return { ok: true, overrides: { url, documentsDir } }
}
