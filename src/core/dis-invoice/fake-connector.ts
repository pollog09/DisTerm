import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const FAKE_CONNECTOR_KEY = `disck_${'f'.repeat(43)}`

export interface FakeColumn {
  id: number
  nombre: string
  orden: number
  al_facturar: boolean
  terminada: boolean
}

export interface FakeCard {
  id: number
  titulo: string
  descripcion: string | null
  prioridad: 'BAJA' | 'MEDIA' | 'ALTA' | 'URGENTE'
  fecha_limite: string | null
  columna: { id: number; nombre: string }
  proyecto: { id: number; nombre: string; github_repo?: string | null } | null
  cliente: { id: number; nombre: string }
  facturada: boolean
  createdAt: string
  updatedAt: string
}

export interface FakeForce {
  status: number
  route: 'tasks' | 'columns'
  /** 1-based page of `/tasks` to fail. Absent = every request to the route. */
  page?: number
}

export interface FakeSeed {
  columns?: FakeColumn[]
  cards?: FakeCard[]
}

export const FAKE_COLUMNS: FakeColumn[] = [
  { id: 1, nombre: 'Por hacer', orden: 1, al_facturar: false, terminada: false },
  { id: 2, nombre: 'En progreso', orden: 2, al_facturar: false, terminada: false },
  { id: 3, nombre: 'Hecho', orden: 3, al_facturar: false, terminada: true },
  { id: 4, nombre: 'Facturado', orden: 4, al_facturar: true, terminada: true }
]

const STAMP = '2026-11-05T14:00:00.000Z'

export function fakeCard(
  id: number,
  fields: Partial<FakeCard> & { columnaId?: number } = {}
): FakeCard {
  const { columnaId, ...rest } = fields
  const column = FAKE_COLUMNS.find((c) => c.id === (columnaId ?? 1)) ?? FAKE_COLUMNS[0]
  return {
    id,
    titulo: `Tarea ${id}`,
    descripcion: null,
    prioridad: 'MEDIA',
    fecha_limite: null,
    columna: { id: column.id, nombre: column.nombre },
    proyecto: { id: 7, nombre: 'Exotic Garage Cr', github_repo: null },
    cliente: { id: 4, nombre: 'Exotic Garage' },
    facturada: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...rest
  }
}

export const FAKE_DEMO_SEED: Required<FakeSeed> = {
  columns: FAKE_COLUMNS,
  cards: [
    fakeCard(101, {
      titulo: 'Migrar el DNS',
      descripcion: 'Mover la zona a Cloudflare.\nConservar los registros MX.',
      prioridad: 'ALTA',
      fecha_limite: '2026-11-30'
    }),
    fakeCard(102, { titulo: 'Revisar los certificados', columnaId: 2, prioridad: 'URGENTE' }),
    fakeCard(103, {
      titulo: 'Rediseñar la portada',
      proyecto: { id: 8, nombre: 'Café Central', github_repo: null },
      cliente: { id: 5, nombre: 'Café Central' }
    }),
    fakeCard(104, { titulo: 'Sin proyecto todavía', proyecto: null })
  ]
}

export interface FakeConnector {
  url: string
  port: number
  requests: Array<{ method: string; path: string }>
  /** Writes the client attempted. It has no write method, so this stays empty. */
  writes: string[]
  seed(seed: FakeSeed): void
  force(force: FakeForce | null): void
  finish(id: number): boolean
  close(): Promise<void>
}

const json = (res: http.ServerResponse, status: number, body: unknown, bearerChallenge = false): void => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  if (bearerChallenge) res.setHeader('WWW-Authenticate', 'Bearer')
  res.end(JSON.stringify(body))
}

const parseForce = (value: unknown): FakeForce | null | undefined => {
  if (value === null) return null
  if (typeof value !== 'object') return undefined
  const { status, route, page } = value as Record<string, unknown>
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return undefined
  if (route !== 'tasks' && route !== 'columns') return undefined
  if (page === undefined) return { status, route }
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return undefined
  return { status, route, page }
}

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => resolve(body))
  })

const TASK_PARAMS = new Set(['proyecto', 'cliente', 'columna', 'prioridad', 'estado', 'limit', 'cursor'])

export async function startFakeConnector(
  options: { port?: number; key?: string; seed?: FakeSeed; pageSize?: number } = {}
): Promise<FakeConnector> {
  const key = options.key ?? FAKE_CONNECTOR_KEY
  let columns: FakeColumn[] = options.seed?.columns ?? FAKE_COLUMNS
  let cards: FakeCard[] = options.seed?.cards ?? []
  let forced: FakeForce | null = null
  const requests: FakeConnector['requests'] = []
  const writes: string[] = []

  const finish = (id: number): boolean => {
    const before = cards.length
    cards = cards.filter((card) => card.id !== id)
    return cards.length < before
  }

  const seed = (next: FakeSeed): void => {
    if (next.columns) columns = next.columns
    if (next.cards) cards = next.cards
  }

  const control = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
    const body = await readBody(req)
    const parsed: unknown = body ? JSON.parse(body) : null
    if (url.pathname === '/__control/seed') {
      seed((parsed as FakeSeed | null) ?? FAKE_DEMO_SEED)
      return json(res, 200, { columns: columns.length, cards: cards.length })
    }
    if (url.pathname === '/__control/force') {
      const next = parseForce(parsed)
      if (next === undefined) return json(res, 400, { error: 'force needs {status: 100-599, route: tasks|columns, page?: n} or null' })
      forced = next
      return json(res, 200, { forced })
    }
    const finished = url.pathname.match(/^\/__control\/finish\/(\d+)$/)
    if (finished) return json(res, 200, { finished: finish(Number(finished[1])), cards: cards.length })
    if (url.pathname === '/__control/state') return json(res, 200, { columns, cards, forced, writes, requests })
    return json(res, 404, { error: 'unknown control route' })
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/__control/')) {
      void control(req, res, url).catch(() => json(res, 400, { error: 'bad control request' }))
      return
    }
    requests.push({ method: req.method ?? '', path: `${url.pathname}${url.search}` })
    if (req.headers.authorization !== `Bearer ${key}`) {
      return json(res, 401, { error: 'Clave no válida.' }, true)
    }
    if (req.method !== 'GET') {
      writes.push(`${req.method} ${url.pathname}`)
      return json(res, 405, { error: 'Solo lectura en el fake.' })
    }
    if (url.pathname === '/api/connector/columns') {
      if (forced?.route === 'columns') return json(res, forced.status, { error: 'Forzado.' })
      return json(res, 200, { columnas: columns })
    }
    if (url.pathname === '/api/connector/tasks') {
      for (const name of new Set(url.searchParams.keys())) {
        if (!TASK_PARAMS.has(name)) return json(res, 400, { error: `Parámetro desconocido: ${name}.` })
      }
      const limit = Number(url.searchParams.get('limit') ?? 50)
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return json(res, 400, { error: 'limit tiene que ser un entero entre 1 y 200.' })
      }
      const pageSize = Math.min(limit, options.pageSize ?? limit)
      const cursor = Number(url.searchParams.get('cursor') ?? 0)
      const pending = [...cards].sort((a, b) => a.id - b.id).filter((card) => card.id > cursor)
      const page = pending.slice(0, pageSize)
      const pageNumber = cards.filter((card) => card.id <= cursor).length / pageSize + 1
      if (forced?.route === 'tasks' && (forced.page === undefined || forced.page === pageNumber)) {
        return json(res, forced.status, { error: 'Forzado.' })
      }
      return json(res, 200, {
        tareas: page,
        next_cursor: pending.length > pageSize ? page[page.length - 1].id : null
      })
    }
    return json(res, 404, { error: 'No existe.' })
  })

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/api/connector`,
    port,
    requests,
    writes,
    seed,
    force: (force) => {
      forced = force
    },
    finish,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
