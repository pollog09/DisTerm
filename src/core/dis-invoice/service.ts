import { promises as fs } from 'node:fs'
import path from 'node:path'
import { IPC } from '../../shared/ipc'
import type {
  DisInvoiceCloneResult,
  DisInvoiceFetchResult,
  DisInvoiceFolderFacts,
  DisInvoiceFolderResult,
  DisInvoiceLinks,
  DisInvoiceSaveResult,
  DisInvoiceStatus
} from '../../shared/dis-invoice'
import { githubRepoOfRemote } from '../../shared/dis-invoice'
import { writeFileAtomic } from '../fs-atomic'
import type { GitService } from '../git-service'
import type { CorePlatform } from '../platform'
import type { SecretStore } from '../secret-store'
import { DIS_INVOICE_CONNECTOR_URL, DisInvoiceClient, connectorBaseUrl } from './client'
import { disInvoiceBaseDir, disInvoiceFolderName, ensureDisInvoiceFolder } from './folders'

export const DIS_INVOICE_SECRET_FILE = 'dis-invoice-connector-key.json'
const LINKS_FILE = 'dis-invoice-links.json'
const MAX_KEY_LENGTH = 512

/** Keeps a run against the fake connector out of the real Documents folder. Honoured only with the
 *  loopback connector, so the base folder stays fixed for real use. */
export function disInvoiceTestDocumentsDir(env: NodeJS.ProcessEnv): string | undefined {
  return connectorBaseUrl(env) === DIS_INVOICE_CONNECTOR_URL ? undefined : env.DISTERM_DIS_INVOICE_DOCUMENTS
}

const isProyectoId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0

function parseLinks(raw: string): DisInvoiceLinks {
  const value: unknown = JSON.parse(raw)
  const links: DisInvoiceLinks = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return links
  for (const [id, entry] of Object.entries(value)) {
    if (!isProyectoId(Number(id)) || typeof entry !== 'object' || entry === null) continue
    const { projectId, folder } = entry as { projectId?: unknown; folder?: unknown }
    if (typeof folder !== 'string' || !folder) continue
    if (projectId !== null && typeof projectId !== 'string') continue
    links[Number(id)] = { projectId: projectId ?? null, folder }
  }
  return links
}

/** Machine-local: which DisTerm project and folder each dis-invoice project landed on. */
export class DisInvoiceLinkStore {
  /** FIFO, so two sync steps cannot lose each other's entry between the read and the write. */
  private chain: Promise<unknown> = Promise.resolve()
  private readonly file: string

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, LINKS_FILE)
  }

  async read(): Promise<DisInvoiceLinks> {
    try {
      return parseLinks(await fs.readFile(this.file, 'utf-8'))
    } catch {
      return {}
    }
  }

  update(change: (links: DisInvoiceLinks) => DisInvoiceLinks): Promise<DisInvoiceLinks> {
    const run = this.chain.then(async () => {
      const before = await this.read()
      const after = change(before)
      if (after !== before) {
        await fs.mkdir(path.dirname(this.file), { recursive: true })
        await writeFileAtomic(this.file, JSON.stringify(after, null, 2))
      }
      return after
    })
    this.chain = run.catch(() => {})
    return run
  }
}

type Dependencies = {
  platform: Pick<CorePlatform, 'handle' | 'userDataDir' | 'documentsDir'>
  secret: SecretStore
  git: Pick<GitService, 'clone' | 'originUrl' | 'canvasExposedToGit'>
  client?: DisInvoiceClient
}

/** Host-only (shared/host-control.ts): the key can read and write every client's cards. It enters
 *  through save-config, leaves only as a request header, and no channel returns it. */
export function registerDisInvoice({ platform, secret, git, client: injected }: Dependencies): void {
  const client = injected ?? new DisInvoiceClient()
  const links = new DisInvoiceLinkStore(platform.userDataDir)
  const baseDir = disInvoiceBaseDir(disInvoiceTestDocumentsDir(process.env) ?? platform.documentsDir)
  /** From the last good fetch. Folder and clone calls name a project by id, so a caller can never
   *  supply the path to create or the URL to clone. */
  let snapshot = new Map<number, { nombre: string; githubRepo: string | null }>()

  const fetchSnapshot = async (): Promise<DisInvoiceFetchResult> => {
    const key = await secret.readForHost()
    if (!key) return { ok: false, reason: 'no-key', message: 'Add a dis-invoice connector key in Settings.' }
    const result = await client.fetchSnapshot(key)
    if (result.ok) {
      snapshot = new Map()
      for (const task of result.tasks) {
        if (task.proyecto) snapshot.set(task.proyecto.id, task.proyecto)
      }
    }
    return result
  }

  const reserveFolder = async (proyectoId: number, nombre: string): Promise<string> => {
    const updated = await links.update((current) => {
      if (current[proyectoId]) return current
      const taken = new Set(Object.values(current).map((link) => path.basename(link.folder).toLowerCase()))
      const folder = path.join(baseDir, disInvoiceFolderName(nombre, proyectoId, taken))
      return { ...current, [proyectoId]: { projectId: null, folder } }
    })
    return updated[proyectoId].folder
  }

  platform.handle(IPC.disInvoiceStatus, async (): Promise<DisInvoiceStatus> => ({
    hasKey: (await secret.readForHost()) !== null,
    storage: secret.availability
  }))

  platform.handle(IPC.disInvoiceSaveConfig, async (raw: unknown): Promise<DisInvoiceSaveResult> => {
    const key = typeof raw === 'string' ? raw.trim() : ''
    if (!key || key.length > MAX_KEY_LENGTH || /[\s\0]/.test(key)) {
      return { ok: false, reason: 'invalid', message: 'That does not look like a connector key.' }
    }
    const check = await client.readColumns(key)
    if (!check.ok) return { ok: false, reason: check.reason === 'no-key' ? 'invalid' : check.reason, message: check.message }
    try {
      await secret.save(key)
    } catch {
      return { ok: false, reason: 'storage', message: 'The key was accepted, but it could not be stored on this machine.' }
    }
    return { ok: true }
  })

  platform.handle(IPC.disInvoiceClearKey, async () => {
    snapshot = new Map()
    await secret.clear()
  })

  platform.handle(IPC.disInvoiceFetch, fetchSnapshot)

  platform.handle(IPC.disInvoiceLinks, () => links.read())

  platform.handle(IPC.disInvoiceSaveLink, async (proyectoId: unknown, projectId: unknown, folder: unknown) => {
    if (!isProyectoId(proyectoId) || typeof projectId !== 'string' || !projectId) return false
    if (typeof folder !== 'string' || !folder) return false
    await links.update((current) => {
      const existing = current[proyectoId]
      if (existing?.projectId === projectId && existing.folder === folder) return current
      return { ...current, [proyectoId]: { projectId, folder } }
    })
    return true
  })

  platform.handle(IPC.disInvoiceEnsureFolder, async (proyectoId: unknown): Promise<DisInvoiceFolderResult> => {
    const proyecto = isProyectoId(proyectoId) ? snapshot.get(proyectoId) : undefined
    if (!proyecto) return { ok: false, message: 'That project is not in the last sync.' }
    return ensureDisInvoiceFolder(await reserveFolder(proyectoId as number, proyecto.nombre))
  })

  platform.handle(IPC.disInvoiceClone, async (proyectoId: unknown): Promise<DisInvoiceCloneResult> => {
    const proyecto = isProyectoId(proyectoId) ? snapshot.get(proyectoId) : undefined
    if (!proyecto?.githubRepo) return { ok: false, message: 'That project has no repository to clone.' }
    const folder = await reserveFolder(proyectoId as number, proyecto.nombre)
    // ensure-folder may have made it. rmdir only succeeds on an empty one, and clone claims it again.
    await fs.rmdir(folder).catch(() => undefined)
    const result = await git.clone(path.dirname(folder), proyecto.githubRepo, { dirName: path.basename(folder) })
    return result.ok ? { ok: true, folder } : { ok: false, message: result.message }
  })

  platform.handle(IPC.disInvoiceInspectFolder, async (cwd: unknown): Promise<DisInvoiceFolderFacts> => {
    if (typeof cwd !== 'string' || !cwd) return { originRepo: null, canvasExposed: false }
    const [origin, canvasExposed] = await Promise.all([git.originUrl(cwd), git.canvasExposedToGit(cwd)])
    return { originRepo: githubRepoOfRemote(origin), canvasExposed }
  })
}
