import type {
  DisInvoiceColumn,
  DisInvoiceFetchResult,
  DisInvoicePriority,
  DisInvoiceTask
} from '../../shared/dis-invoice'
import { normalizeOwnerRepo } from '../../shared/dis-invoice'

export const DIS_INVOICE_CONNECTOR_URL = 'https://dis-invoice.distriib.com/api/connector'

const PAGE_SIZE = 200
/** A hundred thousand open tasks is not a board. A connector that keeps paging is broken. */
const MAX_PAGES = 500
const REQUEST_TIMEOUT_MS = 30_000

/** The key goes wherever this URL points, so only a loopback address may replace the constant. */
export function connectorBaseUrl(override: string | undefined): string {
  if (!override) return DIS_INVOICE_CONNECTOR_URL
  try {
    const url = new URL(override)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    if (url.protocol === 'http:' && loopback && !url.username && !url.password) {
      return override.replace(/\/+$/, '')
    }
  } catch {
    // An unparsable override is the same as a remote one.
  }
  return DIS_INVOICE_CONNECTOR_URL
}

type Failure = Extract<DisInvoiceFetchResult, { ok: false }>

const fail = (reason: Failure['reason'], message: string): Failure => ({ ok: false, reason, message })

const CONTRACT_MESSAGE =
  'dis-invoice answered in a shape this version of DisTerm does not understand. Nothing was changed.'

function failureForStatus(status: number): Failure {
  if (status === 401) return fail('unauthorized', 'dis-invoice rejected the connector key. Check it in Settings.')
  if (status >= 500) {
    return fail(
      'server',
      `dis-invoice answered ${status}. Nothing was changed. If this is a new deployment, its connector SQL migrations may not have run.`
    )
  }
  return fail('contract', `dis-invoice refused the request (${status}). Nothing was changed.`)
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  key: string
): Promise<{ ok: true; body: unknown } | Failure> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // A redirect would resend the bearer key to wherever it points.
      redirect: 'error'
    })
  } catch {
    return fail('network', 'Could not reach dis-invoice. Nothing was changed.')
  }
  if (!response.ok) return failureForStatus(response.status)
  try {
    return { ok: true, body: await response.json() }
  } catch {
    return fail('contract', CONTRACT_MESSAGE)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0

const nameOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

const PRIORITIES: readonly DisInvoicePriority[] = ['BAJA', 'MEDIA', 'ALTA', 'URGENTE']

function parseColumn(value: unknown): DisInvoiceColumn | null {
  if (!isRecord(value) || !isId(value.id)) return null
  const nombre = nameOf(value.nombre)
  if (!nombre || !Number.isFinite(value.orden)) return null
  if (typeof value.al_facturar !== 'boolean' || typeof value.terminada !== 'boolean') return null
  return {
    id: value.id,
    nombre,
    orden: value.orden as number,
    alFacturar: value.al_facturar,
    terminada: value.terminada
  }
}

function parseTask(value: unknown): DisInvoiceTask | null {
  if (!isRecord(value) || !isId(value.id)) return null
  const titulo = nameOf(value.titulo)
  if (!titulo) return null
  if (value.descripcion !== null && typeof value.descripcion !== 'string') return null
  if (!PRIORITIES.includes(value.prioridad as DisInvoicePriority)) return null
  const fecha = value.fecha_limite
  if (fecha !== null && (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha))) return null
  if (!isRecord(value.columna) || !isId(value.columna.id)) return null
  if (!isRecord(value.cliente) || !isId(value.cliente.id)) return null
  const cliente = nameOf(value.cliente.nombre)
  if (!cliente) return null
  let proyecto: DisInvoiceTask['proyecto'] = null
  if (value.proyecto !== null) {
    if (!isRecord(value.proyecto) || !isId(value.proyecto.id)) return null
    const nombre = nameOf(value.proyecto.nombre)
    if (!nombre) return null
    // Absent until the connector ships the field, and never worth failing a sync over.
    proyecto = { id: value.proyecto.id, nombre, githubRepo: normalizeOwnerRepo(value.proyecto.github_repo) }
  }
  return {
    id: value.id,
    titulo,
    descripcion: value.descripcion,
    prioridad: value.prioridad as DisInvoicePriority,
    fechaLimite: fecha,
    columnaId: value.columna.id,
    proyecto,
    cliente: { id: value.cliente.id, nombre: cliente }
  }
}

/** Read access only, because a person decides when work is billable: this module has no way to
 *  send a write. */
export class DisInvoiceClient {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string

  constructor(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
    this.fetchImpl = options.fetch ?? fetch
    this.baseUrl = options.baseUrl ?? DIS_INVOICE_CONNECTOR_URL
  }

  async readColumns(key: string): Promise<{ ok: true; columns: DisInvoiceColumn[] } | Failure> {
    const answer = await getJson(this.fetchImpl, `${this.baseUrl}/columns`, key)
    if (!answer.ok) return answer
    if (!isRecord(answer.body) || !Array.isArray(answer.body.columnas)) return fail('contract', CONTRACT_MESSAGE)
    const columns = answer.body.columnas.map(parseColumn)
    if (columns.some((column) => column === null)) return fail('contract', CONTRACT_MESSAGE)
    return { ok: true, columns: columns as DisInvoiceColumn[] }
  }

  private async readPendingTasks(key: string): Promise<{ ok: true; tasks: DisInvoiceTask[] } | Failure> {
    const tasks: DisInvoiceTask[] = []
    let cursor: number | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = `estado=pendientes&limit=${PAGE_SIZE}${cursor === null ? '' : `&cursor=${cursor}`}`
      const answer = await getJson(this.fetchImpl, `${this.baseUrl}/tasks?${query}`, key)
      if (!answer.ok) return answer
      if (!isRecord(answer.body) || !Array.isArray(answer.body.tareas)) return fail('contract', CONTRACT_MESSAGE)
      const next: unknown = answer.body.next_cursor
      if (next !== null && !isId(next)) return fail('contract', CONTRACT_MESSAGE)
      for (const raw of answer.body.tareas) {
        const task = parseTask(raw)
        if (!task) return fail('contract', CONTRACT_MESSAGE)
        tasks.push(task)
      }
      if (next === null) return { ok: true, tasks }
      // The cursor is an id and only moves forward. One that does not would loop until MAX_PAGES.
      if (cursor !== null && next <= cursor) return fail('contract', CONTRACT_MESSAGE)
      cursor = next
    }
    return fail('contract', CONTRACT_MESSAGE)
  }

  /** The whole snapshot or nothing: a partial task list would read as tasks that were finished. */
  async fetchSnapshot(key: string): Promise<DisInvoiceFetchResult> {
    const columns = await this.readColumns(key)
    if (!columns.ok) return columns
    const tasks = await this.readPendingTasks(key)
    if (!tasks.ok) return tasks
    return { ok: true, columns: columns.columns, tasks: tasks.tasks }
  }
}
