import { beforeEach, describe, expect, it } from 'vitest'
import type { CanvasNodeState, Project, ProjectKanban } from '@shared/types'
import type { DisInvoiceApi, DisInvoiceColumn, DisInvoiceFetchResult, DisInvoiceLinks, DisInvoiceTask } from '@shared/dis-invoice'
import { useProjects } from '../state/projects'
import { createStickyNode, flowToNodeStates, nodeStatesToFlow } from '../state/workspace'
import {
  disInvoiceStickyFactory,
  mergeUpsertsIntoFlow,
  runDisInvoiceSync,
  summarizeDisInvoiceSync,
  type DisInvoiceSyncDeps
} from './disInvoiceSync'

const COLUMNS: DisInvoiceColumn[] = [
  { id: 1, nombre: 'Por hacer', orden: 1, alFacturar: false, terminada: false },
  { id: 2, nombre: 'En progreso', orden: 2, alFacturar: false, terminada: false },
  { id: 3, nombre: 'Hecho', orden: 3, alFacturar: false, terminada: true },
  { id: 4, nombre: 'Facturado', orden: 4, alFacturar: true, terminada: true }
]

const task = (id: number, proyectoId: number | null = 7, over: Partial<DisInvoiceTask> = {}): DisInvoiceTask => ({
  id,
  titulo: `Tarea ${id}`,
  descripcion: null,
  prioridad: 'MEDIA',
  fechaLimite: null,
  columnaId: 1,
  proyecto: proyectoId === null ? null : { id: proyectoId, nombre: `P${proyectoId}`, githubRepo: null },
  cliente: { id: 4, nombre: 'Exotic Garage' },
  ...over
})

function harness(result: DisInvoiceFetchResult, links: DisInvoiceLinks, projects: Project[]) {
  const log: string[] = []
  const nodes = new Map(projects.map((p) => [p.id, p.nodes]))
  const boards = new Map<string, ProjectKanban | undefined>(projects.map((p) => [p.id, p.kanban]))
  const disInvoice: DisInvoiceApi = {
    status: async () => ({ hasKey: true, storage: 'encrypted' }),
    saveConfig: async () => ({ ok: true }),
    clearKey: async () => {},
    fetch: async () => {
      log.push('fetch')
      return result
    },
    links: async () => links,
    saveLink: async (id, projectId) => {
      log.push(`saveLink ${id} ${projectId}`)
      return true
    },
    ensureFolder: async (id) => ({ ok: true, folder: `/docs/${id}`, created: true, empty: true, isRepo: false }),
    clone: async (id) => ({ ok: true, folder: `/docs/${id}` }),
    inspectFolder: async () => ({ originRepo: null, canvasExposed: false })
  }
  const deps: DisInvoiceSyncDeps = {
    disInvoice,
    projects: () => projects,
    nodesOf: (id) => nodes.get(id) ?? [],
    boardOf: (id) => boards.get(id),
    stickyFactory: disInvoiceStickyFactory,
    applyNodes: (id, upserts) => {
      log.push(`nodes ${id} ${upserts.map((n) => n.id).join(',')}`)
      const merged = new Map((nodes.get(id) ?? []).map((n) => [n.id, n]))
      for (const upsert of upserts) merged.set(upsert.id, upsert)
      nodes.set(id, [...merged.values()])
    },
    applyBoard: (id, board) => {
      log.push(`board ${id}`)
      boards.set(id, board)
    },
    persist: async () => {
      log.push('persist')
    },
    gateNewProject: async () => {
      log.push('gate')
      return true
    },
    addProject: async () => {
      throw new Error('this test adds no project')
    }
  }
  return { deps, log, nodes, boards }
}

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  name: id,
  color: '#111',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  cwd: `/work/${id}`,
  storeInAppData: true,
  ...over
})

const ok = (tasks: DisInvoiceTask[], columns = COLUMNS): DisInvoiceFetchResult => ({ ok: true, columns, tasks })

describe('runDisInvoiceSync over linked projects', () => {
  it('writes each project’s nodes before its board, then persists exactly once, last', async () => {
    const { deps, log } = harness(
      ok([task(1, 7), task(2, 8)]),
      { 7: { projectId: 'a', folder: '/work/a' }, 8: { projectId: 'b', folder: '/work/b' } },
      [project('a'), project('b')]
    )
    const report = await runDisInvoiceSync(deps)
    expect(log).toEqual(['fetch', 'nodes a sticky-dis-7-1', 'board a', 'nodes b sticky-dis-8-2', 'board b', 'persist'])
    expect(report.projects.map((p) => [p.projectId, p.reconcile.created])).toEqual([
      ['a', [1]],
      ['b', [2]]
    ])
  })

  it('applies every project with no await between them', async () => {
    const { deps } = harness(
      ok([task(1, 7), task(2, 8)]),
      { 7: { projectId: 'a', folder: '/work/a' }, 8: { projectId: 'b', folder: '/work/b' } },
      [project('a'), project('b')]
    )
    const events: string[] = []
    const applyNodes = deps.applyNodes
    deps.applyNodes = (id, upserts) => {
      events.push(`apply ${id}`)
      void Promise.resolve().then(() => events.push('microtask ran'))
      applyNodes(id, upserts)
    }
    await runDisInvoiceSync(deps)
    expect(events.slice(0, 2)).toEqual(['apply a', 'apply b'])
  })

  it.each([
    [{ ok: false, reason: 'unauthorized', message: 'nope' } as DisInvoiceFetchResult, { reason: 'unauthorized', message: 'nope' }],
    [{ ok: false, reason: 'server', message: 'page 2' } as DisInvoiceFetchResult, { reason: 'server', message: 'page 2' }],
    [{ ok: false, reason: 'no-key', message: 'add one' } as DisInvoiceFetchResult, { reason: 'no-key', message: 'add one' }]
  ])('a failed fetch changes nothing and is reported', async (result, failure) => {
    const { deps, log } = harness(result, { 7: { projectId: 'a', folder: '/work/a' } }, [project('a')])
    const report = await runDisInvoiceSync(deps)
    expect(report.failure).toEqual(failure)
    expect(log).toEqual(['fetch'])
    expect(summarizeDisInvoiceSync(report)).toEqual([{ tone: 'error', text: failure.message }])
  })

  it('no columns changes nothing, and says so', async () => {
    const { deps, log } = harness(ok([task(1)], []), { 7: { projectId: 'a', folder: '/work/a' } }, [project('a')])
    const report = await runDisInvoiceSync(deps)
    expect(log).toEqual(['fetch'])
    expect(summarizeDisInvoiceSync(report)).toEqual([
      { tone: 'warn', text: 'dis-invoice has no columns yet. Open its board once, then sync again. Nothing was changed.' }
    ])
  })

  it('a second sync writes nothing and does not persist', async () => {
    const { deps, log } = harness(ok([task(1)]), { 7: { projectId: 'a', folder: '/work/a' } }, [project('a')])
    await runDisInvoiceSync(deps)
    log.length = 0
    const second = await runDisInvoiceSync(deps)
    expect(log).toEqual(['fetch'])
    expect(summarizeDisInvoiceSync(second)).toEqual([{ tone: 'ok', text: 'Already up to date across 1 project.' }])
  })

  it('finishes the stickies of a linked project with nothing pending any more', async () => {
    const { deps, boards, nodes } = harness(ok([task(1)]), { 7: { projectId: 'a', folder: '/work/a' } }, [project('a')])
    await runDisInvoiceSync(deps)
    const report = await (async () => {
      deps.disInvoice.fetch = async () => ok([])
      return runDisInvoiceSync(deps)
    })()
    expect(report.projects[0].reconcile.finished).toEqual([1])
    expect(boards.get('a')?.assignments).toEqual([expect.objectContaining({ nodeId: 'sticky-dis-7-1', columnId: 'dis-invoice:3' })])
    expect(nodes.get('a')?.[0].disInvoiceRef?.finished).toBe(true)
  })

  it('counts tasks without a project and syncs the rest', async () => {
    const { deps } = harness(ok([task(1), task(2, null), task(3, null)]), { 7: { projectId: 'a', folder: '/work/a' } }, [project('a')])
    const report = await runDisInvoiceSync(deps)
    expect(report.withoutProject).toBe(2)
    expect(report.projects[0].reconcile.created).toEqual([1])
    expect(summarizeDisInvoiceSync(report)[1]).toEqual({
      tone: 'warn',
      text: '2 tasks skipped because they have no project in dis-invoice. Assign one and sync again.'
    })
  })

  it('skips a relay tab and reports it', async () => {
    const { deps, log } = harness(ok([task(1)]), { 7: { projectId: 'a', folder: '/work/a' } }, [project('a', { remote: {} as never })])
    const report = await runDisInvoiceSync(deps)
    expect(report.skippedRemote).toEqual(['P7'])
    expect(log).toEqual(['fetch'])
  })

  it('writes into a closed linked project without reopening it', async () => {
    const closed = project('a', { closed: true })
    const { deps, log } = harness(ok([task(1)]), { 7: { projectId: 'a', folder: '/work/a' } }, [closed])
    await runDisInvoiceSync(deps)
    expect(log).toEqual(['fetch', 'nodes a sticky-dis-7-1', 'board a', 'persist'])
    expect(closed.closed).toBe(true)
  })

  it('reports client text git can see in a folder-backed project', async () => {
    const { deps } = harness(ok([task(1)]), { 7: { projectId: 'a', folder: '/work/a' } }, [project('a', { storeInAppData: undefined })])
    deps.disInvoice.inspectFolder = async () => ({ originRepo: null, canvasExposed: true })
    const report = await runDisInvoiceSync(deps)
    expect(report.projects[0].canvasExposed).toBe(true)
    expect(summarizeDisInvoiceSync(report)[1].text).toBe(
      "P7: client task text is in .nodeterm/project.json and git can see it. Ignore .nodeterm/ or store this project's canvas in app data before you commit."
    )
  })
})

describe('disInvoiceStickyFactory', () => {
  const REF = { taskId: 1, columnaId: 1, textHash: 'abc' }

  it('builds a persisted sticky with the deterministic id, text and reference', () => {
    const state = disInvoiceStickyFactory([])({ id: 'sticky-dis-7-1', text: 'Tarea', ref: REF, index: 0 })
    expect(state).toMatchObject({ id: 'sticky-dis-7-1', kind: 'sticky', text: 'Tarea', disInvoiceRef: REF, position: { x: 32, y: 32 } })
  })

  it('wraps a grid below everything that is not a mirror', () => {
    const other = { id: 'term', kind: 'terminal', position: { x: 0, y: 100 }, size: { width: 10, height: 50 } } as CanvasNodeState
    const mirror = { id: 'old', kind: 'sticky', position: { x: 0, y: 9000 }, size: { width: 10, height: 50 }, disInvoiceRef: REF } as CanvasNodeState
    const make = disInvoiceStickyFactory([other, mirror])
    const first = make({ id: 'a', text: 'a', ref: REF, index: 0 })
    const fifth = make({ id: 'b', text: 'b', ref: REF, index: 4 })
    expect(first.position).toEqual({ x: 32, y: 182 })
    expect(fifth.position.x).toBe(32)
    expect(fifth.position.y).toBe(182 + first.size.height + 32)
  })
})

describe('mergeUpsertsIntoFlow', () => {
  it('keeps live-only state on an existing node and adds new ones', () => {
    const live = { ...createStickyNode(0), id: 'sticky-1', selected: true, measured: { width: 300, height: 200 } }
    live.data = { ...live.data, text: 'old', title: 'mine' }
    const [saved] = flowToNodeStates([live])
    const ref = { taskId: 1, columnaId: 1, textHash: 'abc' }
    const fresh = disInvoiceStickyFactory([])({ id: 'sticky-dis-7-2', text: 'new card', ref, index: 0 })
    const { next, added } = mergeUpsertsIntoFlow([live], [{ ...saved, text: 'upstream', disInvoiceRef: ref }, fresh])
    expect(next.map((n) => n.id)).toEqual(['sticky-1', 'sticky-dis-7-2'])
    expect(next[0].selected).toBe(true)
    expect(next[0].measured).toEqual({ width: 300, height: 200 })
    expect(next[0].data).toMatchObject({ text: 'upstream', title: 'mine', disInvoiceRef: ref })
    expect(added.map((n) => n.id)).toEqual(['sticky-dis-7-2'])
    expect(added[0].data.text).toBe('new card')
  })
})

describe('open questions, answered against the real store', () => {
  const sticky = (id: string): CanvasNodeState => ({
    id,
    kind: 'sticky',
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 },
    title: 'Note',
    color: '#fff',
    group: null,
    text: id
  })

  beforeEach(() => {
    useProjects.setState({
      projects: [project('open', { nodes: [] }), project('shut', { nodes: [sticky('old')], closed: true, closedAt: 1 })],
      activeProjectId: 'open'
    })
  })

  it('a closed project accepts applyOwnNodeMutations, stays closed, and is saved with its new node', () => {
    const accepted = useProjects.getState().applyOwnNodeMutations('shut', [{ op: 'upsert', node: sticky('new') }])
    const shut = useProjects.getState().getProject('shut')!
    expect(accepted).toBe(true)
    expect(shut.closed).toBe(true)
    expect(shut.nodes.map((n) => n.id)).toEqual(['old', 'new'])
    expect(useProjects.getState().toWorkspace().projects.find((p) => p.id === 'shut')?.nodes.map((n) => n.id)).toEqual(['old', 'new'])
    expect(useProjects.getState().activeProjectId).toBe('open')
  })

  it('a store write to the project React Flow holds does not survive the next commit, so that case must write live', () => {
    const inLoad = nodeStatesToFlow([sticky('loaded')])
    useProjects.getState().applyOwnNodeMutations('open', [{ op: 'upsert', node: sticky('from-sync') }])
    expect(useProjects.getState().getProject('open')!.nodes.map((n) => n.id)).toEqual(['from-sync'])
    // What `persist()` does while the load's settle timer still has loadingRef set.
    useProjects.getState().commitCanvas('open', flowToNodeStates(inLoad), { x: 0, y: 0, zoom: 1 })
    expect(useProjects.getState().getProject('open')!.nodes.map((n) => n.id)).toEqual(['loaded'])
  })
})
