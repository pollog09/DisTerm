import { describe, expect, it } from 'vitest'
import type { CanvasNodeState, ProjectKanban } from './types'
import type { DisInvoiceColumn, DisInvoiceRef, DisInvoiceTask } from './dis-invoice'
import {
  disInvoiceTextHash,
  reconcileProject,
  renderDisInvoiceTask,
  type DisInvoiceSnapshot,
  type NewDisInvoiceSticky
} from './dis-invoice-reconcile'

const COLUMNS: DisInvoiceColumn[] = [
  { id: 2, nombre: 'En progreso', orden: 2, alFacturar: false, terminada: false },
  { id: 1, nombre: 'Por hacer', orden: 1, alFacturar: false, terminada: false },
  { id: 4, nombre: 'Facturado', orden: 4, alFacturar: true, terminada: true },
  { id: 3, nombre: 'Hecho', orden: 3, alFacturar: false, terminada: true },
  { id: 5, nombre: 'Archivado', orden: 5, alFacturar: false, terminada: true }
]

const task = (id: number, over: Partial<DisInvoiceTask> = {}): DisInvoiceTask => ({
  id,
  titulo: `Tarea ${id}`,
  descripcion: null,
  prioridad: 'MEDIA',
  fechaLimite: null,
  columnaId: 1,
  proyecto: { id: 7, nombre: 'Exotic', githubRepo: null },
  cliente: { id: 4, nombre: 'Exotic Garage' },
  ...over
})

const sticky = (id: string, text: string, ref?: unknown): CanvasNodeState =>
  ({
    id,
    kind: 'sticky',
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 },
    title: 'Note',
    color: '#ffd60a',
    group: null,
    text,
    ...(ref ? { disInvoiceRef: ref } : {})
  }) as CanvasNodeState

const newSticky: NewDisInvoiceSticky = ({ id, text, ref }) => sticky(id, text, ref)

const snapshot = (tasks: DisInvoiceTask[], columns = COLUMNS): DisInvoiceSnapshot => ({ columns, tasks })

function mirrorOf(t: DisInvoiceTask, ref: Partial<DisInvoiceRef> = {}, id = `sticky-dis-7-${t.id}`): CanvasNodeState {
  const text = renderDisInvoiceTask(t)
  return sticky(id, text, { taskId: t.id, columnaId: t.columnaId, textHash: disInvoiceTextHash(text), ...ref })
}

const seededBoard = (assignments: ProjectKanban['assignments'] = [], meta: ProjectKanban['meta'] = undefined): ProjectKanban => ({
  columns: [
    { id: 'dis-invoice:1', title: 'Por hacer', color: '#000', category: 'unstarted' },
    { id: 'dis-invoice:2', title: 'En progreso', color: '#000', category: 'started' },
    { id: 'dis-invoice:3', title: 'Hecho', color: '#000', category: 'done' },
    { id: 'dis-invoice:5', title: 'Archivado', color: '#000', category: 'done' }
  ],
  assignments,
  ...(meta ? { meta } : {})
})

const columnOf = (board: ProjectKanban | undefined, nodeId: string): string | undefined =>
  board?.assignments.find((a) => a.nodeId === nodeId)?.columnId

function applied(nodes: CanvasNodeState[], upserts: CanvasNodeState[]): CanvasNodeState[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const upsert of upserts) byId.set(upsert.id, upsert)
  return [...byId.values()]
}

function runTwice(
  nodes: CanvasNodeState[],
  board: ProjectKanban | undefined,
  snap: DisInvoiceSnapshot,
  proyectoId = 7
): ReturnType<typeof reconcileProject> & { nodes: CanvasNodeState[] } {
  const first = reconcileProject(nodes, board, snap, proyectoId, newSticky)
  const after = applied(nodes, first.upserts)
  const second = reconcileProject(after, first.board, snap, proyectoId, newSticky)
  expect(second.upserts).toEqual([])
  expect(second.board).toBe(first.board)
  expect(second.report.created).toEqual([])
  expect(second.report.moved).toEqual([])
  expect(second.report.textUpdated).toEqual([])
  expect(second.report.metaUpdated).toEqual([])
  expect(second.report.finished).toEqual([])
  return { ...first, nodes: after }
}

describe('renderDisInvoiceTask', () => {
  it('starts with the title and frames the client', () => {
    expect(renderDisInvoiceTask(task(1, { titulo: 'Migrar el DNS', descripcion: 'Mover la zona.\nConservar MX.' }))).toBe(
      'Migrar el DNS\n\nClient: Exotic Garage\n\nMover la zona.\nConservar MX.'
    )
    expect(renderDisInvoiceTask(task(1, { titulo: 'A\nB  \r\n C', descripcion: '   ' }))).toBe('A B C\n\nClient: Exotic Garage')
  })

  it('hashes the rendered text to a stable value', () => {
    expect(disInvoiceTextHash('Migrar el DNS')).toBe('a1eb43e1')
  })
})

describe('column seeding', () => {
  it('a fresh board has only the mirrored columns, in order, with categories', () => {
    const { board, report } = runTwice([], undefined, snapshot([task(1)]))
    expect(board?.columns.map(({ id, title, category }) => ({ id, title, category }))).toEqual([
      { id: 'dis-invoice:1', title: 'Por hacer', category: 'unstarted' },
      { id: 'dis-invoice:2', title: 'En progreso', category: 'started' },
      { id: 'dis-invoice:3', title: 'Hecho', category: 'done' },
      { id: 'dis-invoice:5', title: 'Archivado', category: 'done' }
    ])
    expect(report.columnsAdded).toBe(4)
  })

  it('an existing board keeps its columns and gets the missing ones appended', () => {
    const existing: ProjectKanban = {
      columns: [
        { id: 'kcol-mine', title: 'Mine', color: '#111' },
        { id: 'dis-invoice:1', title: 'Renamed here', color: '#222' }
      ],
      assignments: [{ nodeId: 'term-1', columnId: 'kcol-mine' }]
    }
    const { board, report } = runTwice([], existing, snapshot([task(1)]))
    expect(board?.columns.map((c) => [c.id, c.title])).toEqual([
      ['kcol-mine', 'Mine'],
      ['dis-invoice:1', 'Renamed here'],
      ['dis-invoice:2', 'En progreso'],
      ['dis-invoice:3', 'Hecho'],
      ['dis-invoice:5', 'Archivado']
    ])
    expect(report.columnsAdded).toBe(3)
    expect(columnOf(board, 'term-1')).toBe('kcol-mine')
  })

  it('a project with no tasks and no mirrors keeps its unborn board', () => {
    expect(reconcileProject([], undefined, snapshot([task(1, { proyecto: { id: 9, nombre: 'Otro', githubRepo: null } })]), 7, newSticky).board).toBeUndefined()
  })
})

describe('reconcileProject', () => {
  it('pending, no sticky: creates it with text, reference, column, priority and due date', () => {
    const t = task(1, { titulo: 'Migrar el DNS', prioridad: 'ALTA', fechaLimite: '2026-11-30', columnaId: 2 })
    const { upserts, board, report } = runTwice([], undefined, snapshot([t]))
    expect(upserts).toEqual([
      {
        ...sticky('sticky-dis-7-1', 'Migrar el DNS\n\nClient: Exotic Garage'),
        disInvoiceRef: { taskId: 1, columnaId: 2, textHash: disInvoiceTextHash('Migrar el DNS\n\nClient: Exotic Garage') }
      }
    ])
    expect(columnOf(board, 'sticky-dis-7-1')).toBe('dis-invoice:2')
    expect(board?.meta).toEqual([{ nodeId: 'sticky-dis-7-1', priority: 'high', dueAt: new Date(2026, 10, 30, 23, 59).getTime() }])
    expect(report.created).toEqual([1])
    expect(report.metaUpdated).toEqual([])
  })

  it('keeps upstream order within a column', () => {
    const { board } = runTwice([mirrorOf(task(9))], seededBoard(), snapshot([task(9), task(1), task(2)]))
    expect(board?.assignments.map((a) => a.nodeId)).toEqual(['sticky-dis-7-1', 'sticky-dis-7-2'])
  })

  it('pending, text changed upstream: overwrites the text and the hash, and upstream wins over a local edit', () => {
    const before = mirrorOf(task(1))
    const edited = { ...before, text: 'my own edit', textUpdatedAt: 5, textUpdatedBy: 'someone' }
    const t = task(1, { descripcion: 'nueva' })
    const board = seededBoard([{ nodeId: before.id, columnId: 'dis-invoice:1' }], [{ nodeId: before.id, priority: 'medium' }])
    const { upserts, report } = runTwice([edited], board, snapshot([t]))
    const expected = 'Tarea 1\n\nClient: Exotic Garage\n\nnueva'
    expect(upserts).toHaveLength(1)
    expect(upserts[0].text).toBe(expected)
    expect(upserts[0].textUpdatedAt).toBeUndefined()
    expect(upserts[0].textUpdatedBy).toBeUndefined()
    expect(upserts[0].disInvoiceRef).toEqual({ taskId: 1, columnaId: 1, textHash: disInvoiceTextHash(expected) })
    expect(report.textUpdated).toEqual([1])
    expect(report.moved).toEqual([])
  })

  it('pending, text unchanged upstream: a local edit survives', () => {
    const t = task(1)
    const edited = { ...mirrorOf(t), text: 'my own edit' }
    const board = seededBoard([{ nodeId: edited.id, columnId: 'dis-invoice:1' }], [{ nodeId: edited.id, priority: 'medium' }])
    const result = runTwice([edited], board, snapshot([t]))
    expect(result.upserts).toEqual([])
    expect(result.board).toBe(board)
    expect(result.nodes[0].text).toBe('my own edit')
  })

  it('pending, upstream column changed: moves the card and records the column', () => {
    const before = mirrorOf(task(1))
    const moved = task(1, { columnaId: 2 })
    const board = seededBoard([{ nodeId: before.id, columnId: 'dis-invoice:1' }], [{ nodeId: before.id, priority: 'medium' }])
    const { upserts, board: next, report } = runTwice([before], board, snapshot([moved]))
    expect(columnOf(next, before.id)).toBe('dis-invoice:2')
    expect(upserts[0].disInvoiceRef?.columnaId).toBe(2)
    expect(upserts[0].text).toBe(before.text)
    expect(report.moved).toEqual([1])
  })

  it('pending, column unchanged upstream: a card dragged locally stays where the person put it', () => {
    const t = task(1)
    const before = mirrorOf(t)
    const board = seededBoard([{ nodeId: before.id, columnId: 'dis-invoice:3' }], [{ nodeId: before.id, priority: 'medium' }])
    const { upserts, board: next, report } = runTwice([before], board, snapshot([t]))
    expect(columnOf(next, before.id)).toBe('dis-invoice:3')
    expect(next).toBe(board)
    expect(upserts).toEqual([])
    expect(report.moved).toEqual([])
  })

  it('pending again after finishing, in its old column: moves back and clears finished', () => {
    const t = task(1)
    const before = mirrorOf(t, { movedToFinished: true })
    const board = seededBoard([{ nodeId: before.id, columnId: 'dis-invoice:3' }], [{ nodeId: before.id, priority: 'medium' }])
    const { upserts, board: next, report } = runTwice([before], board, snapshot([t]))
    expect(columnOf(next, before.id)).toBe('dis-invoice:1')
    expect(upserts[0].disInvoiceRef).toEqual({ taskId: 1, columnaId: 1, textHash: disInvoiceTextHash(before.text!) })
    expect(report.moved).toEqual([1])
  })

  it('priority or due date changed: updates the meta and keeps the rest of it', () => {
    const t = task(1, { prioridad: 'URGENTE', fechaLimite: '2027-01-02' })
    const before = mirrorOf(t)
    const assignees = [{ name: 'Ana', color: '#fff' }]
    const board = seededBoard(
      [{ nodeId: before.id, columnId: 'dis-invoice:1' }],
      [{ nodeId: before.id, priority: 'low', labels: ['l1'], assignees }]
    )
    const { upserts, board: next, report } = runTwice([before], board, snapshot([t]))
    expect(upserts).toEqual([])
    expect(next?.meta).toEqual([
      { nodeId: before.id, assignees, labels: ['l1'], priority: 'urgent', dueAt: new Date(2027, 0, 2, 23, 59).getTime() }
    ])
    expect(report.metaUpdated).toEqual([1])
  })

  it('a due date removed upstream is removed from the card', () => {
    const t = task(1)
    const before = mirrorOf(t)
    const board = seededBoard([{ nodeId: before.id, columnId: 'dis-invoice:1' }], [{ nodeId: before.id, priority: 'medium', dueAt: 123 }])
    const { board: next } = runTwice([before], board, snapshot([t]))
    expect(next?.meta).toEqual([{ nodeId: before.id, priority: 'medium' }])
  })

  it('missing from the snapshot: moves to the lowest finished column that is not billing, and flags it', () => {
    const before = mirrorOf(task(1))
    const board = seededBoard([{ nodeId: before.id, columnId: 'dis-invoice:1' }])
    const { upserts, board: next, report } = runTwice([before], board, snapshot([task(2)]))
    expect(columnOf(next, before.id)).toBe('dis-invoice:3')
    expect(upserts.find((n) => n.id === before.id)?.disInvoiceRef?.movedToFinished).toBe(true)
    expect(report.finished).toEqual([1])
  })

  it('finished once: a card dragged back is left alone by later syncs, and never deleted', () => {
    const before = mirrorOf(task(1), { movedToFinished: true })
    const board = seededBoard([{ nodeId: before.id, columnId: 'dis-invoice:1' }])
    const { upserts, board: next, nodes } = runTwice([before], board, snapshot([]))
    expect(upserts).toEqual([])
    expect(columnOf(next, before.id)).toBe('dis-invoice:1')
    expect(nodes.map((n) => n.id)).toEqual([before.id])
  })

  it('with no finished column: does not mark it finished, reports it, and moves it once a finished column appears', () => {
    const open = COLUMNS.filter((c) => !c.terminada)
    const before = mirrorOf(task(1))
    const board = seededBoard([{ nodeId: before.id, columnId: 'dis-invoice:1' }])

    const stranded = runTwice([before], board, snapshot([], open))
    expect(columnOf(stranded.board, before.id)).toBe('dis-invoice:1')
    expect(stranded.upserts).toEqual([])
    expect(stranded.report.finished).toEqual([])
    expect(stranded.report.noFinishedColumn).toEqual([1])

    const landed = runTwice(stranded.nodes, stranded.board, snapshot([], COLUMNS))
    expect(columnOf(landed.board, before.id)).toBe('dis-invoice:3')
    expect(landed.upserts[0].disInvoiceRef?.movedToFinished).toBe(true)
    expect(landed.report.finished).toEqual([1])
    expect(landed.report.noFinishedColumn).toEqual([])
  })

  it('now pending in another project: leaves the old sticky and reports it, the new project creates its own', () => {
    const before = mirrorOf(task(1))
    const reassigned = task(1, { proyecto: { id: 8, nombre: 'Otro', githubRepo: null } })
    const board = seededBoard([{ nodeId: before.id, columnId: 'dis-invoice:1' }])
    const old = runTwice([before], board, snapshot([reassigned]))
    expect(old.upserts).toEqual([])
    expect(columnOf(old.board, before.id)).toBe('dis-invoice:1')
    expect(old.report.reassigned).toEqual([1])
    expect(old.report.finished).toEqual([])

    const fresh = runTwice([], undefined, snapshot([reassigned]), 8)
    expect(fresh.report.created).toEqual([1])
    expect(fresh.upserts[0].id).toBe('sticky-dis-8-1')
  })

  it('a task with its project removed is not read as finished, or as moved to another project', () => {
    const before = mirrorOf(task(1))
    const { report, upserts } = runTwice([before], seededBoard([{ nodeId: before.id, columnId: 'dis-invoice:1' }]), snapshot([task(1, { proyecto: null })]))
    expect(report.reassigned).toEqual([])
    expect(report.finished).toEqual([])
    expect(upserts).toEqual([])
  })

  it('two proyectos sharing one DisTerm project: the other’s tasks are neither reassigned nor finished', () => {
    const sibling = task(2, { proyecto: { id: 8, nombre: 'Hermano', githubRepo: null } })
    const before = mirrorOf(sibling)
    const board = seededBoard([{ nodeId: before.id, columnId: 'dis-invoice:1' }])
    const { report, upserts } = reconcileProject([before], board, snapshot([task(1), sibling]), 7, newSticky, new Set([7, 8]))
    expect(report.reassigned).toEqual([])
    expect(report.finished).toEqual([])
    expect(upserts.map((n) => n.id)).toEqual(['sticky-dis-7-1'])
  })

  it('a task moved between proyectos on one DisTerm project keeps its one sticky', () => {
    const moved = task(1, { proyecto: { id: 8, nombre: 'Hermano', githubRepo: null } })
    const before = mirrorOf(task(1))
    const board = seededBoard([{ nodeId: before.id, columnId: 'dis-invoice:1' }])
    const sharing = new Set([7, 8])
    const fromOld = reconcileProject([before], board, snapshot([moved]), 7, newSticky, sharing)
    expect(fromOld.report.reassigned).toEqual([])
    const fromNew = reconcileProject([before], board, snapshot([moved]), 8, newSticky, sharing)
    expect(fromNew.upserts).toEqual([])
    expect(fromNew.report.created).toEqual([])
  })

  it('a task moved to a proyecto on another DisTerm project still warns', () => {
    const moved = task(1, { proyecto: { id: 9, nombre: 'Otro', githubRepo: null } })
    const before = mirrorOf(task(1))
    const board = seededBoard([{ nodeId: before.id, columnId: 'dis-invoice:1' }])
    expect(reconcileProject([before], board, snapshot([moved]), 7, newSticky, new Set([7, 8])).report.reassigned).toEqual([1])
  })

  it('a minted id never lands on a node that does not mirror the task', () => {
    const note = sticky('sticky-dis-7-1', 'my own note, kept after an undo cleared its reference')
    const { upserts, nodes, board } = runTwice([note], seededBoard(), snapshot([task(1)]))
    expect(upserts.map((n) => n.id)).toEqual(['sticky-dis-7-1-2'])
    expect(nodes.find((n) => n.id === 'sticky-dis-7-1')).toEqual(note)
    expect(columnOf(board, 'sticky-dis-7-1-2')).toBe('dis-invoice:1')
    expect(columnOf(board, 'sticky-dis-7-1')).toBeUndefined()
  })

  it('a minted id skips every suffix already taken, including by another task’s mirror', () => {
    const notes = [sticky('sticky-dis-7-1', 'a'), sticky('sticky-dis-7-1-2', 'b'), mirrorOf(task(5), {}, 'sticky-dis-7-1-3')]
    const { upserts } = runTwice(notes, seededBoard(), snapshot([task(5), task(1)]))
    expect(upserts.map((n) => n.id)).toEqual(['sticky-dis-7-1-4'])
  })

  it('a sticky deleted while pending comes back', () => {
    const t = task(1)
    const board = seededBoard([], [{ nodeId: 'sticky-dis-7-1', priority: 'medium' }])
    const { report, nodes, board: next } = runTwice([], board, snapshot([t]))
    expect(report.created).toEqual([1])
    expect(nodes.map((n) => n.id)).toEqual(['sticky-dis-7-1'])
    expect(columnOf(next, 'sticky-dis-7-1')).toBe('dis-invoice:1')
  })

  it('two stickies claiming one task: the first keeps it, the other becomes an ordinary note', () => {
    const t = task(1)
    const first = mirrorOf(t)
    const revived = { ...mirrorOf(t, {}, 'sticky-old'), text: 'revived by undo' }
    const board = seededBoard([{ nodeId: first.id, columnId: 'dis-invoice:1' }], [{ nodeId: first.id, priority: 'medium' }])
    const { upserts, report, nodes } = runTwice([first, revived], board, snapshot([t]))
    expect(upserts).toEqual([{ ...revived, disInvoiceRef: undefined }])
    expect(report.duplicatesCleared).toBe(1)
    expect(nodes.find((n) => n.id === 'sticky-old')?.text).toBe('revived by undo')
  })

  it('a task in a column the snapshot does not list: no card move, retried when the column appears', () => {
    const before = mirrorOf(task(1))
    const board = seededBoard([{ nodeId: before.id, columnId: 'dis-invoice:1' }], [{ nodeId: before.id, priority: 'medium' }])
    const elsewhere = task(1, { columnaId: 99 })
    const first = reconcileProject([before], board, snapshot([elsewhere]), 7, newSticky)
    expect(first.upserts).toEqual([])
    expect(first.report.unplaced).toEqual([1])
    expect(columnOf(first.board, before.id)).toBe('dis-invoice:1')
    const created = reconcileProject([], undefined, snapshot([elsewhere]), 7, newSticky)
    expect(created.report.created).toEqual([1])
    expect(created.report.unplaced).toEqual([1])
    expect(columnOf(created.board, 'sticky-dis-7-1')).toBeUndefined()
  })

  it('ignores a reference on anything but a sticky, and ordinary notes', () => {
    const terminal = { ...mirrorOf(task(1)), kind: 'terminal' } as CanvasNodeState
    const note = sticky('note-1', 'just a note')
    const { upserts, report } = runTwice([terminal, note], seededBoard(), snapshot([]))
    expect(upserts).toEqual([])
    expect(report.finished).toEqual([])
  })

  it('never touches another card on the board', () => {
    const t = task(1)
    const board = seededBoard([{ nodeId: 'term-1', columnId: 'dis-invoice:2' }])
    const { board: next } = runTwice([sticky('term-1', 'mine')], board, snapshot([t]))
    expect(columnOf(next, 'term-1')).toBe('dis-invoice:2')
  })
})
