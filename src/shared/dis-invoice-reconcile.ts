// Every rule for mirroring dis-invoice onto one DisTerm project, in one pure reducer. Canvas and the
// sync orchestrator only apply its output. docs/reference/kanban.md holds the reasoning.
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

/** Task ids per outcome. All empty means the project already matched the snapshot. */
export interface ReconcileReport {
  created: number[]
  textUpdated: number[]
  moved: number[]
  metaUpdated: number[]
  finished: number[]
  /** Pending in another project now. This sticky stays, and that project gets its own. */
  reassigned: number[]
  /** In a column the snapshot does not list, so its card has no column to go to. */
  unplaced: number[]
  columnsAdded: number
  /** Stickies that claimed a task another sticky already holds (an undo can revive one). */
  duplicatesCleared: number
}

export interface ReconcileResult {
  /** Whole node states to write. Empty on a second run. */
  upserts: CanvasNodeState[]
  /** The same reference as the input when nothing changed. */
  board: ProjectKanban | undefined
  report: ReconcileReport
}

export type NewDisInvoiceSticky = (spec: {
  id: string
  text: string
  ref: DisInvoiceRef
  /** How many mirrored stickies the project has before this one, for placement. */
  index: number
}) => CanvasNodeState

const emptyReport = (): ReconcileReport => ({
  created: [],
  textUpdated: [],
  moved: [],
  metaUpdated: [],
  finished: [],
  reassigned: [],
  unplaced: [],
  columnsAdded: 0,
  duplicatesCleared: 0
})

/** Derived rather than stored, so no mapping can drift and a rename here breaks nothing. */
export const disInvoiceColumnId = (columnaId: number): string => `dis-invoice:${columnaId}`

/** Scoped by project because the core store finds a project by node id, and a reassigned task gets
 *  a second sticky elsewhere. */
export const disInvoiceStickyId = (proyectoId: number, taskId: number): string => `sticky-dis-${proyectoId}-${taskId}`

/** The first line is the title, because a card's title is the text's first line. */
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
function dueAtOf(fecha: string | null): number | undefined {
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

export function reconcileProject(
  nodes: readonly CanvasNodeState[],
  initialBoard: ProjectKanban | undefined,
  snapshot: DisInvoiceSnapshot,
  proyectoId: number,
  newSticky: NewDisInvoiceSticky
): ReconcileResult {
  const report = emptyReport()
  const upserts: CanvasNodeState[] = []
  // The list is empty until someone opens dis-invoice's board. That says nothing about the tasks.
  if (snapshot.columns.length === 0) return { upserts, board: initialBoard, report }

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
  const mirroredBefore = mirrors.size

  // A project losing its last task still needs its board, to receive that task's sticky.
  const before = initialBoard
  let board = own.length > 0 || mirroredBefore > 0 ? withMirroredColumns(initialBoard, snapshot.columns) : initialBoard
  if (board && board !== before) report.columnsAdded = board.columns.length - (before?.columns.length ?? 0)

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
    const dueAt = dueAtOf(task.fechaLimite)
    if (current?.priority === priority && current?.dueAt === dueAt) return false
    board = withCardMeta(board, nodeId, {
      assignees: current?.assignees,
      labels: current?.labels,
      priority,
      ...(dueAt === undefined ? {} : { dueAt })
    })
    return true
  }

  let created = 0
  for (const task of own) {
    const text = renderDisInvoiceTask(task)
    const textHash = disInvoiceTextHash(text)
    const mirror = mirrors.get(task.id)

    if (!mirror) {
      const id = disInvoiceStickyId(proyectoId, task.id)
      upserts.push(
        newSticky({
          id,
          text,
          ref: { taskId: task.id, columnaId: task.columnaId, textHash },
          index: mirroredBefore + created++
        })
      )
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

    if (ref.finished || ref.columnaId !== task.columnaId) {
      if (hasColumn(task.columnaId)) {
        place(node.id, task.columnaId, 'top')
        const { finished: _cleared, ...open } = nextRef
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
    if (pending.has(taskId)) {
      report.reassigned.push(taskId)
      continue
    }
    // Moved once. Dragging it back afterwards is the person's call, and later syncs respect it.
    if (ref.finished) continue
    if (finishedColumn) place(node.id, finishedColumn.id, 'top')
    upserts.push({ ...node, disInvoiceRef: { ...ref, finished: true } })
    report.finished.push(taskId)
  }

  return { upserts, board, report }
}
