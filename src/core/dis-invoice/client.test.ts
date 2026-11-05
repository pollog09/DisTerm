import { afterEach, describe, expect, it } from 'vitest'
import { DIS_INVOICE_CONNECTOR_URL, DisInvoiceClient, connectorBaseUrl } from './client'
import { FAKE_CONNECTOR_KEY, FAKE_COLUMNS, fakeCard, startFakeConnector, type FakeConnector } from './fake-connector'
import { githubRepoOfRemote, normalizeOwnerRepo } from '../../shared/dis-invoice'

let fake: FakeConnector | undefined

afterEach(async () => {
  await fake?.close()
  fake = undefined
})

async function start(cards = [fakeCard(1)], pageSize?: number): Promise<DisInvoiceClient> {
  fake = await startFakeConnector({ seed: { cards }, pageSize })
  return new DisInvoiceClient({ baseUrl: fake.url })
}

const answering = (body: string, status = 200): DisInvoiceClient =>
  new DisInvoiceClient({
    baseUrl: 'http://127.0.0.1:1',
    fetch: (async () => new Response(body, { status })) as typeof fetch
  })

describe('DisInvoiceClient.fetchSnapshot', () => {
  it('parses columns and a full card', async () => {
    const client = await start([
      fakeCard(5, {
        titulo: 'Migrar el DNS',
        descripcion: 'Zona nueva',
        prioridad: 'ALTA',
        fecha_limite: '2026-11-30',
        columnaId: 2,
        proyecto: { id: 7, nombre: 'Exotic', github_repo: 'Distriib/Exotic-Web' }
      })
    ])
    const result = await client.fetchSnapshot(FAKE_CONNECTOR_KEY)
    expect(result).toEqual({
      ok: true,
      columns: [
        { id: 1, nombre: 'Por hacer', orden: 1, alFacturar: false, terminada: false },
        { id: 2, nombre: 'En progreso', orden: 2, alFacturar: false, terminada: false },
        { id: 3, nombre: 'Hecho', orden: 3, alFacturar: false, terminada: true },
        { id: 4, nombre: 'Facturado', orden: 4, alFacturar: true, terminada: true }
      ],
      tasks: [
        {
          id: 5,
          titulo: 'Migrar el DNS',
          descripcion: 'Zona nueva',
          prioridad: 'ALTA',
          fechaLimite: '2026-11-30',
          columnaId: 2,
          proyecto: { id: 7, nombre: 'Exotic', githubRepo: 'distriib/exotic-web' },
          cliente: { id: 4, nombre: 'Exotic Garage' }
        }
      ]
    })
  })

  it('walks every page with the connector cursor', async () => {
    const client = await start([fakeCard(1), fakeCard(2), fakeCard(3), fakeCard(4), fakeCard(5)], 2)
    const result = await client.fetchSnapshot(FAKE_CONNECTOR_KEY)
    expect(result.ok && result.tasks.map((t) => t.id)).toEqual([1, 2, 3, 4, 5])
    expect(fake!.requests.filter((r) => r.path.includes('/tasks')).map((r) => r.path)).toEqual([
      '/api/connector/tasks?estado=pendientes&limit=200',
      '/api/connector/tasks?estado=pendientes&limit=200&cursor=2',
      '/api/connector/tasks?estado=pendientes&limit=200&cursor=4'
    ])
  })

  it('yields no tasks when a later page fails', async () => {
    const client = await start([fakeCard(1), fakeCard(2), fakeCard(3)], 2)
    fake!.force({ route: 'tasks', status: 500, page: 2 })
    const result = await client.fetchSnapshot(FAKE_CONNECTOR_KEY)
    expect(result).toEqual({
      ok: false,
      reason: 'server',
      message:
        'dis-invoice answered 500. Nothing was changed. If this is a new deployment, its connector SQL migrations may not have run.'
    })
    expect('tasks' in result).toBe(false)
  })

  it('reports 401 as unauthorized without echoing the key', async () => {
    const client = await start()
    const result = await client.fetchSnapshot('disck_wrong-key')
    expect(result).toEqual({
      ok: false,
      reason: 'unauthorized',
      message: 'dis-invoice rejected the connector key. Check it in Settings.'
    })
    expect(JSON.stringify(result)).not.toContain('disck_')
  })

  it('reports an unreachable connector as network', async () => {
    fake = await startFakeConnector()
    const url = fake.url
    await fake.close()
    fake = undefined
    expect(await new DisInvoiceClient({ baseUrl: url }).fetchSnapshot(FAKE_CONNECTOR_KEY)).toEqual({
      ok: false,
      reason: 'network',
      message: 'Could not reach dis-invoice. Nothing was changed.'
    })
  })

  it.each([
    ['not JSON', 'Service Unavailable<html>'],
    ['columnas is not a list', '{"columnas":{}}'],
    ['a column without its flags', '{"columnas":[{"id":1,"nombre":"A","orden":1}]}'],
    ['a column with a string id', '{"columnas":[{"id":"1","nombre":"A","orden":1,"al_facturar":false,"terminada":false}]}']
  ])('reports a malformed columns body as contract: %s', async (_name, body) => {
    const result = await answering(body).fetchSnapshot(FAKE_CONNECTOR_KEY)
    expect(result.ok === false && result.reason).toBe('contract')
  })

  it.each([
    ['tareas is missing', { next_cursor: null }],
    ['next_cursor is a string', { tareas: [], next_cursor: '9' }],
    ['a card without a title', { tareas: [{ ...fakeCard(1), titulo: '' }], next_cursor: null }],
    ['an unknown priority', { tareas: [{ ...fakeCard(1), prioridad: 'CRITICA' }], next_cursor: null }],
    ['a malformed due date', { tareas: [{ ...fakeCard(1), fecha_limite: '30/11/2026' }], next_cursor: null }],
    ['a project with no id', { tareas: [{ ...fakeCard(1), proyecto: { nombre: 'X' } }], next_cursor: null }]
  ])('reports a malformed tasks body as contract: %s', async (_name, body) => {
    const client = new DisInvoiceClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: (async (input: string) =>
        new Response(JSON.stringify(input.includes('/columns') ? { columnas: FAKE_COLUMNS } : body))) as unknown as typeof fetch
    })
    const result = await client.fetchSnapshot(FAKE_CONNECTOR_KEY)
    expect(result.ok === false && result.reason).toBe('contract')
  })

  it('stops on a cursor that does not move forward', async () => {
    let calls = 0
    const client = new DisInvoiceClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: (async (input: string) => {
        if (input.includes('/columns')) return new Response(JSON.stringify({ columnas: FAKE_COLUMNS }))
        calls++
        return new Response(JSON.stringify({ tareas: [fakeCard(calls)], next_cursor: 4 }))
      }) as unknown as typeof fetch
    })
    const result = await client.fetchSnapshot(FAKE_CONNECTOR_KEY)
    expect(result.ok === false && result.reason).toBe('contract')
    expect(calls).toBe(2)
  })

  it('tolerates unknown fields at every level', async () => {
    const client = await start([
      { ...fakeCard(1), horas: 3, proyecto: { id: 7, nombre: 'X', github_repo: null, extra: true } } as never
    ])
    const result = await client.fetchSnapshot(FAKE_CONNECTOR_KEY)
    expect(result.ok && result.tasks[0].proyecto).toEqual({ id: 7, nombre: 'X', githubRepo: null })
  })

  it('reads a missing github_repo as null, and the connector without that field still syncs', async () => {
    const { github_repo: _absent, ...withoutRepo } = fakeCard(1).proyecto!
    const client = await start([fakeCard(1, { proyecto: withoutRepo })])
    const result = await client.fetchSnapshot(FAKE_CONNECTOR_KEY)
    expect(result.ok && result.tasks[0].proyecto).toEqual({ id: 7, nombre: 'Exotic Garage Cr', githubRepo: null })
  })

  it('accepts an empty column list, which is what a board nobody opened yet returns', async () => {
    fake = await startFakeConnector({ seed: { columns: [], cards: [fakeCard(1)] } })
    const result = await new DisInvoiceClient({ baseUrl: fake.url }).fetchSnapshot(FAKE_CONNECTOR_KEY)
    expect(result.ok && result.columns).toEqual([])
    expect(result.ok && result.tasks.map((t) => t.id)).toEqual([1])
  })

  it('never sends a write', async () => {
    const client = await start([fakeCard(1), fakeCard(2)], 1)
    await client.fetchSnapshot(FAKE_CONNECTOR_KEY)
    expect(fake!.requests.map((r) => r.method)).toEqual(['GET', 'GET', 'GET'])
    expect(fake!.writes).toEqual([])
  })
})

describe('connectorBaseUrl', () => {
  it.each([
    [undefined, DIS_INVOICE_CONNECTOR_URL],
    ['http://127.0.0.1:8799/api/connector/', 'http://127.0.0.1:8799/api/connector'],
    ['http://localhost:8799/api/connector', 'http://localhost:8799/api/connector'],
    ['https://127.0.0.1:8799/api/connector', DIS_INVOICE_CONNECTOR_URL],
    ['http://evil.example/api/connector', DIS_INVOICE_CONNECTOR_URL],
    ['http://127.0.0.1.evil.example/api/connector', DIS_INVOICE_CONNECTOR_URL],
    ['http://user:pass@127.0.0.1:8799/', DIS_INVOICE_CONNECTOR_URL],
    ['not a url', DIS_INVOICE_CONNECTOR_URL]
  ])('%s -> %s', (override, expected) => {
    expect(connectorBaseUrl(override)).toBe(expected)
  })
})

describe('repository slugs', () => {
  it.each([
    ['Distriib/Exotic-Web', 'distriib/exotic-web'],
    ['owner/repo.git', 'owner/repo'],
    ['owner/..', null],
    ['-flag/repo', null],
    ['owner/repo/extra', null],
    ['owner', null],
    ['', null],
    [null, null],
    [7, null]
  ])('normalizeOwnerRepo(%j) -> %j', (value, expected) => {
    expect(normalizeOwnerRepo(value)).toBe(expected)
  })

  it.each([
    ['https://github.com/Owner/Repo.git', 'owner/repo'],
    ['https://token@github.com/owner/repo', 'owner/repo'],
    ['git@github.com:owner/repo.git', 'owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'owner/repo'],
    ['https://gitlab.com/owner/repo.git', null],
    ['git@gitlab.com:owner/repo.git', null],
    ['https://github.com.evil.example/owner/repo', null],
    ['https://github.com/owner/repo/extra', null],
    ['', null],
    [null, null]
  ])('githubRepoOfRemote(%j) -> %j', (url, expected) => {
    expect(githubRepoOfRemote(url)).toBe(expected)
  })
})
