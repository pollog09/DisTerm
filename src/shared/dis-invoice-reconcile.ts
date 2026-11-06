import type { CanvasNodeState, KanbanColumn, KanbanColumnCategory, KanbanPriority, ProjectKanban } from './types'
import type { DisInvoiceColumn, DisInvoicePriority, DisInvoiceRef, DisInvoiceTask } from './dis-invoice'
import { normalizeDisInvoiceRef } from './dis-invoice'
import { fnv1a32 } from './kanban-default-board'
import { cardMeta, withCardMeta } from './kanban-labels'
import { placeAssignment, type CardAnchor } from './kanban-order'
import { SYSTEM_NODE_COLORS } from './node-colors'

export interface DisInvoiceSnapshot {
  columns: DisInvoiceColumn[]
  tasks: DisInvoiceTask[]
}

export interface ReconcileReport {
  created: number[]
  textUpdated: number[]
  moved: number[]
  metaUpdated: number[]
  finished: number[]
  noFinishedColumn: number[]
  reassigned: number[]
  unplaced: number[]
  columnsAdded: number
  /** Stickies that claimed a task another sticky already holds (an undo can revive one). */
  duplicatesCleared: number
}

export interface ReconcileResult {
  upserts: CanvasNodeState[]
  /** The same reference as the input when nothing changed, which callers compare by identity. */
  board: ProjectKanban | undefined
  report: ReconcileReport
}

export type NewDisInvoiceSticky = (spec: { id: string; text: string; ref: DisInvoiceRef }) => CanvasNodeState

const emptyReport = (): ReconcileReport => ({
  created: [],
  textUpdated: [],
  moved: [],
  metaUpdated: [],
  finished: [],
  noFinishedColumn: [],
  reassigned: [],
  unplaced: [],
  columnsAdded: 0,
  duplicatesCleared: 0
})

/** Derived rather than stored, so no mapping can drift and a rename here breaks nothing. */
export const disInvoiceColumnId = (columnaId: number): string => `dis-invoice:${columnaId}`

/** Scoped by project because the core store finds a project by node id, and a reassigned task gets
 *  a second sticky elsewhere. A mirror that lost its reference keeps its id and is a person's note
 *  now, so a name already on the canvas takes a suffix rather than merging over that node. */
function freeStickyId(proyectoId: number, taskId: number, taken: Set<string>): string {
  const base = `sticky-dis-${proyectoId}-${taskId}`
  let id = base
  for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`
  taken.add(id)
  return id
}

export function renderDisInvoiceTask(task: DisInvoiceTask): string {
  const title = task.titulo.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  const description = task.descripcion?.trim()
  return `${title}\n\nClient: ${task.cliente.nombre}${description ? `\n\n${description}` : ''}`
}

export const disInvoiceTextHash = (text: string): string => fnv1a32(text).toString(16)

const PRIORITY: Record<DisInvoicePriority, KanbanPriority> = {
  BAJA: 'low',
  MEDIA: 'medium',
  ALTA: 'high',
  URGENTE: 'urgent'
}

/** The end of the due day where this machine is. Midnight UTC would read as overdue on the day, and
 *  as the day before anywhere west of Greenwich. */
function endOfLocalDay(fecha: string | null): number | undefined {
  if (!fecha) return undefined
  const [year, month, day] = fecha.split('-').map(Number)
  return new Date(year, month - 1, day, 23, 59).getTime()
}

const byOrden = (a: DisInvoiceColumn, b: DisInvoiceColumn): number => a.orden - b.orden || a.id - b.id

/** A task that reaches the billed column stops being work to do, and that column is billing's. */
const mirroredColumns = (columns: DisInvoiceColumn[]): DisInvoiceColumn[] =>
  columns.filter((column) => !column.alFacturar).sort(byOrden)

const finishedColumnOf = (columns: DisInvoiceColumn[]): DisInvoiceColumn | undefined =>
  mirroredColumns(columns).find((column) => column.terminada)

function toBoardColumns(columns: DisInvoiceColumn[]): KanbanColumn[] {
  const mirrored = mirroredColumns(columns)
  const firstOpen = mirrored.find((column) => !column.terminada)
  return mirrored.map((column, index) => {
    const category: KanbanColumnCategory = column.terminada ? 'done' : column === firstOpen ? 'unstarted' : 'started'
    return {
      id: disInvoiceColumnId(column.id),
      title: column.nombre,
      color: SYSTEM_NODE_COLORS[index % SYSTEM_NODE_COLORS.length],
      category
    }
  })
}

function withMirroredColumns(board: ProjectKanban | undefined, columns: DisInvoiceColumn[]): ProjectKanban {
  const wanted = toBoardColumns(columns)
  if (!board) return { columns: wanted, assignments: [] }
  const have = new Set(board.columns.map((column) => column.id))
  const missing = wanted.filter((column) => !have.has(column.id))
  return missing.length ? { ...board, columns: [...board.columns, ...missing] } : board
}

/** `sharing` holds every dis-invoice project that lands on this DisTerm project. A task moved among
 *  them stays on this canvas, so it has not moved anywhere a person needs to hear about. */
export function reconcileProject(
  nodes: readonly CanvasNodeState[],
  initialBoard: ProjectKanban | undefined,
  snapshot: DisInvoiceSnapshot,
  proyectoId: number,
  newSticky: NewDisInvoiceSticky,
  sharing: ReadonlySet<number> = new Set([proyectoId])
): ReconcileResult {
  const report = emptyReport()
  const upserts: CanvasNodeState[] = []

  const pending = new Map(snapshot.tasks.map((task) => [task.id, task]))
  const own = snapshot.tasks.filter((task) => task.proyecto?.id === proyectoId)

  const mirrors = new Map<number, { node: CanvasNodeState; ref: DisInvoiceRef }>()
  for (const node of nodes) {
    const ref = node.kind === 'sticky' ? normalizeDisInvoiceRef(node.disInvoiceRef) : undefined
    if (!ref) continue
    if (mirrors.has(ref.taskId)) {
      upserts.push({ ...node, disInvoiceRef: undefined })
      report.duplicatesCleared++
    } else {
      mirrors.set(ref.taskId, { node, ref })
    }
  }

  // A project losing its last task still needs its board, to receive that task's sticky.
  let board = own.length > 0 || mirrors.size > 0 ? withMirroredColumns(initialBoard, snapshot.columns) : initialBoard
  if (board && board !== initialBoard) report.columnsAdded = board.columns.length - (initialBoard?.columns.length ?? 0)

  const hasColumn = (columnaId: number): boolean =>
    !!board?.columns.some((column) => column.id === disInvoiceColumnId(columnaId))

  const place = (nodeId: string, columnaId: number, anchor: CardAnchor): void => {
    if (!board) return
    const assignments = placeAssignment(board.assignments, nodeId, disInvoiceColumnId(columnaId), anchor)
    if (assignments !== board.assignments) board = { ...board, assignments }
  }

  const syncMeta = (nodeId: string, task: DisInvoiceTask): boolean => {
    if (!board) return false
    const current = cardMeta(board, nodeId)
    const priority = PRIORITY[task.prioridad]
    const dueAt = endOfLocalDay(task.fechaLimite)
    if (current?.priority === priority && current?.dueAt === dueAt) return false
    board = withCardMeta(board, nodeId, {
      assignees: current?.assignees,
      labels: current?.labels,
      priority,
      ...(dueAt === undefined ? {} : { dueAt })
    })
    return true
  }

  const takenIds = new Set(nodes.map((node) => node.id))
  for (const task of own) {
    const text = renderDisInvoiceTask(task)
    const textHash = disInvoiceTextHash(text)
    const mirror = mirrors.get(task.id)

    if (!mirror) {
      const id = freeStickyId(proyectoId, task.id, takenIds)
      upserts.push(newSticky({ id, text, ref: { taskId: task.id, columnaId: task.columnaId, textHash } }))
      report.created.push(task.id)
      if (hasColumn(task.columnaId)) place(id, task.columnaId, 'end')
      else report.unplaced.push(task.id)
      syncMeta(id, task)
      continue
    }

    const { node, ref } = mirror
    let nextNode = node
    let nextRef = ref

    if (ref.textHash !== textHash) {
      nextNode = { ...nextNode, text, textUpdatedAt: undefined, textUpdatedBy: undefined }
      nextRef = { ...nextRef, textHash }
      report.textUpdated.push(task.id)
    }

    if (ref.movedToFinished || ref.columnaId !== task.columnaId) {
      if (hasColumn(task.columnaId)) {
        place(node.id, task.columnaId, 'top')
        const { movedToFinished: _cleared, ...open } = nextRef
        nextRef = { ...open, columnaId: task.columnaId }
        report.moved.push(task.id)
      } else {
        report.unplaced.push(task.id)
      }
    }

    if (nextNode !== node || nextRef !== ref) upserts.push({ ...nextNode, disInvoiceRef: nextRef })
    if (syncMeta(node.id, task)) report.metaUpdated.push(task.id)
  }

  const ownIds = new Set(own.map((task) => task.id))
  const finishedColumn = finishedColumnOf(snapshot.columns)
  for (const [taskId, { node, ref }] of mirrors) {
    if (ownIds.has(taskId)) continue
    const stillPending = pending.get(taskId)
    if (stillPending) {
      const owner = stillPending.proyecto?.id
      if (owner !== undefined && !sharing.has(owner)) report.reassigned.push(taskId)
      continue
    }
    // Moved once. Dragging it back afterwards is the person's call, and later syncs respect it.
    if (ref.movedToFinished) continue
    if (!finishedColumn) {
      report.noFinishedColumn.push(taskId)
      continue
    }
    place(node.id, finishedColumn.id, 'top')
    upserts.push({ ...node, disInvoiceRef: { ...ref, movedToFinished: true } })
    report.finished.push(taskId)
  }

  return { upserts, board, report }
}
