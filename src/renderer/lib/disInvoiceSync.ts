import type { CanvasNodeState, Project, ProjectKanban } from '@shared/types'
import type { DisInvoiceApi, DisInvoiceFailureReason, DisInvoiceTask } from '@shared/dis-invoice'
import {
  reconcileProject,
  type DisInvoiceSnapshot,
  type NewDisInvoiceSticky,
  type ReconcileReport
} from '@shared/dis-invoice-reconcile'

import { createStickyNode, flowToNodeStates, nodeStatesToFlow, type CanvasNode } from '../state/workspace'

type Proyecto = NonNullable<DisInvoiceTask['proyecto']>

export interface DisInvoiceProjectOutcome {
  proyectoId: number
  nombre: string
  projectId: string
  /** A DisTerm project this sync added. */
  created: boolean
  reconcile: ReconcileReport
  /** The folder holds other files and is not a repository, so the repository was not cloned. */
  cloneSkipped: boolean
  /** Client text in a `.nodeterm/` canvas that git can see in this folder. */
  canvasExposed: boolean
}

export interface DisInvoiceSyncReport {
  failure?: { reason: DisInvoiceFailureReason; message: string }
  /** dis-invoice answered with no columns, so nothing was changed. */
  noColumns: boolean
  projects: DisInvoiceProjectOutcome[]
  /** Tasks with no dis-invoice project: there is no folder to map them to. */
  withoutProject: number
  /** Left without a DisTerm project because the limit gate did not let the sync add one. */
  stopped: string[]
  failed: Array<{ nombre: string; message: string }>
  /** Linked to a relay tab, whose canvas belongs to another machine. */
  skippedRemote: string[]
}

export interface DisInvoiceSyncDeps {
  disInvoice: DisInvoiceApi
  projects(): readonly Project[]
  nodesOf(projectId: string): CanvasNodeState[]
  boardOf(projectId: string): ProjectKanban | undefined
  stickyFactory(nodes: readonly CanvasNodeState[]): NewDisInvoiceSticky
  /** Called strictly before `applyBoard` for a project, because the board publisher prunes cards
   *  against live node ids. Both are synchronous: nothing may run between a read and its write. */
  applyNodes(projectId: string, upserts: CanvasNodeState[]): void
  applyBoard(projectId: string, board: ProjectKanban): void
  persist(): Promise<unknown>
  /** Asked before any folder work, so a refusal does not cost a clone. */
  gateNewProject(): Promise<boolean>
  /** Adds a project without switching tabs. Null means the limit gate refused it. */
  addProject(name: string, folder: string): Promise<Project | null>
}

const emptyReport = (): DisInvoiceSyncReport => ({
  noColumns: false,
  projects: [],
  withoutProject: 0,
  stopped: [],
  failed: [],
  skippedRemote: []
})

type Resolution =
  | { kind: 'ready'; project: Project; created: boolean; cloneSkipped: boolean }
  | { kind: 'stopped' }
  | { kind: 'failed'; message: string }

const isLocal = (project: Project): boolean => !project.remote && !project.ssh

/** One sync of every dis-invoice project. Nothing is written until the whole snapshot is in hand. */
export async function runDisInvoiceSync(deps: DisInvoiceSyncDeps): Promise<DisInvoiceSyncReport> {
  const report = emptyReport()
  const { disInvoice } = deps

  const fetched = await disInvoice.fetch()
  if (!fetched.ok) {
    report.failure = { reason: fetched.reason, message: fetched.message }
    return report
  }
  if (fetched.columns.length === 0) {
    report.noColumns = true
    return report
  }
  const snapshot: DisInvoiceSnapshot = { columns: fetched.columns, tasks: fetched.tasks }

  const proyectos = new Map<number, Proyecto>()
  for (const task of snapshot.tasks) {
    if (task.proyecto) proyectos.set(task.proyecto.id, task.proyecto)
    else report.withoutProject++
  }

  const links = await disInvoice.links()

  const originOf = new Map<string, string | null>()
  const originRepo = async (cwd: string): Promise<string | null> => {
    if (!originOf.has(cwd)) originOf.set(cwd, (await disInvoice.inspectFolder(cwd)).originRepo)
    return originOf.get(cwd) ?? null
  }

  const linkedProject = (proyectoId: number): Project | undefined => {
    const projectId = links[proyectoId]?.projectId
    return projectId ? deps.projects().find((p) => p.id === projectId) : undefined
  }

  let refused = false

  const resolve = async (proyecto: Proyecto): Promise<Resolution> => {
    if (proyecto.githubRepo) {
      for (const project of deps.projects()) {
        if (project.closed || !isLocal(project) || !project.cwd) continue
        if ((await originRepo(project.cwd)) !== proyecto.githubRepo) continue
        await disInvoice.saveLink(proyecto.id, project.id, project.cwd)
        return { kind: 'ready', project, created: false, cloneSkipped: false }
      }
    }
    const folder = await disInvoice.ensureFolder(proyecto.id)
    if (!folder.ok) return { kind: 'failed', message: folder.message }

    const atFolder = deps.projects().find((p) => p.cwd === folder.folder && isLocal(p))
    if (atFolder) {
      await disInvoice.saveLink(proyecto.id, atFolder.id, folder.folder)
      return { kind: 'ready', project: atFolder, created: false, cloneSkipped: false }
    }

    if (refused || !(await deps.gateNewProject())) {
      refused = true
      return { kind: 'stopped' }
    }

    let cloneSkipped = false
    if (proyecto.githubRepo && !folder.isRepo) {
      if (folder.empty) {
        const clone = await disInvoice.clone(proyecto.id)
        if (!clone.ok) return { kind: 'failed', message: clone.message }
      } else {
        cloneSkipped = true
      }
    }

    const project = await deps.addProject(proyecto.nombre, folder.folder)
    if (!project) {
      refused = true
      return { kind: 'stopped' }
    }
    await disInvoice.saveLink(proyecto.id, project.id, folder.folder)
    return { kind: 'ready', project, created: true, cloneSkipped }
  }

  const targets: Array<{
    proyectoId: number
    nombre: string
    project: Project
    created: boolean
    cloneSkipped: boolean
  }> = []

  // One at a time: the gate refuses a request while another is deciding, rather than queueing it.
  for (const proyecto of [...proyectos.values()].sort((a, b) => a.id - b.id)) {
    const linked = linkedProject(proyecto.id)
    if (linked?.remote) {
      report.skippedRemote.push(proyecto.nombre)
      continue
    }
    if (linked) {
      targets.push({ proyectoId: proyecto.id, nombre: proyecto.nombre, project: linked, created: false, cloneSkipped: false })
      continue
    }
    const resolved = await resolve(proyecto)
    if (resolved.kind === 'stopped') report.stopped.push(proyecto.nombre)
    else if (resolved.kind === 'failed') report.failed.push({ nombre: proyecto.nombre, message: resolved.message })
    else {
      targets.push({
        proyectoId: proyecto.id,
        nombre: proyecto.nombre,
        project: resolved.project,
        created: resolved.created,
        cloneSkipped: resolved.cloneSkipped
      })
    }
  }

  // A linked project with nothing pending any more still has stickies to finish.
  for (const key of Object.keys(links)) {
    const proyectoId = Number(key)
    if (proyectos.has(proyectoId)) continue
    const linked = linkedProject(proyectoId)
    if (!linked || linked.remote) continue
    targets.push({ proyectoId, nombre: linked.name, project: linked, created: false, cloneSkipped: false })
  }

  const exposedBy = new Map<string, boolean>()
  for (const { project } of targets) {
    if (exposedBy.has(project.id) || !project.cwd || project.storeInAppData) continue
    exposedBy.set(project.id, (await disInvoice.inspectFolder(project.cwd)).canvasExposed)
  }

  let changed = targets.some((target) => target.created)
  // One tick, no await: a read of a project's nodes and the write built from it cannot be split.
  for (const target of targets) {
    const projectId = target.project.id
    const nodes = deps.nodesOf(projectId)
    const board = deps.boardOf(projectId)
    const result = reconcileProject(nodes, board, snapshot, target.proyectoId, deps.stickyFactory(nodes))
    if (result.upserts.length > 0) {
      deps.applyNodes(projectId, result.upserts)
      changed = true
    }
    if (result.board && result.board !== board) {
      deps.applyBoard(projectId, result.board)
      changed = true
    }
    report.projects.push({
      proyectoId: target.proyectoId,
      nombre: target.nombre,
      projectId,
      created: target.created,
      reconcile: result.report,
      cloneSkipped: target.cloneSkipped,
      canvasExposed: exposedBy.get(projectId) ?? false
    })
  }

  if (changed) await deps.persist()
  return report
}

const GRID_COLUMNS = 4
const GRID_GAP = 32

/** Lays mirrored stickies in a grid below whatever else is on the canvas. The rest of the node comes
 *  from the ordinary sticky factory. The id is deterministic, so undo cannot mint a second mirror. */
export function disInvoiceStickyFactory(nodes: readonly CanvasNodeState[]): NewDisInvoiceSticky {
  const bottom = nodes
    .filter((node) => !node.disInvoiceRef)
    .reduce((lowest, node) => Math.max(lowest, node.position.y + node.size.height), 0)
  const top = bottom ? bottom + GRID_GAP : GRID_GAP
  return ({ id, text, ref, index }) => {
    const sized = createStickyNode(index)
    const width = sized.width ?? 0
    const height = sized.height ?? 0
    const made = createStickyNode(index, {
      x: GRID_GAP + (index % GRID_COLUMNS) * (width + GRID_GAP) + width / 2,
      y: top + Math.floor(index / GRID_COLUMNS) * (height + GRID_GAP) + height / 2
    })
    return flowToNodeStates([{ ...made, id, data: { ...made.data, text, disInvoiceRef: ref } }])[0]
  }
}

/** Upserts onto the live canvas. An existing node keeps what only the live canvas knows (measured
 *  size, selection): sync owns nothing on it but its text and its reference. */
export function mergeUpsertsIntoFlow(
  nodes: readonly CanvasNode[],
  upserts: readonly CanvasNodeState[]
): { next: CanvasNode[]; added: CanvasNode[] } {
  const byId = new Map(upserts.map((upsert) => [upsert.id, upsert]))
  const merged = nodes.map((node) => {
    const upsert = byId.get(node.id)
    if (!upsert) return node
    byId.delete(node.id)
    const { text, textUpdatedAt, textUpdatedBy, disInvoiceRef } = upsert
    return { ...node, data: { ...node.data, text, textUpdatedAt, textUpdatedBy, disInvoiceRef } }
  })
  const added = nodeStatesToFlow([...byId.values()])
  return { next: [...merged, ...added], added }
}

export interface DisInvoiceReportLine {
  tone: 'ok' | 'warn' | 'error'
  text: string
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`

/** The whole report in sentences, so nothing that was skipped goes unsaid. */
export function summarizeDisInvoiceSync(report: DisInvoiceSyncReport): DisInvoiceReportLine[] {
  if (report.failure) return [{ tone: 'error', text: report.failure.message }]
  if (report.noColumns) {
    return [{ tone: 'warn', text: 'dis-invoice has no columns yet. Open its board once, then sync again. Nothing was changed.' }]
  }
  const lines: DisInvoiceReportLine[] = []
  const sum = (pick: (r: ReconcileReport) => number[]): number =>
    report.projects.reduce((total, project) => total + pick(project.reconcile).length, 0)

  const added = report.projects.filter((p) => p.created).length
  const created = sum((r) => r.created)
  const updated = sum((r) => r.textUpdated)
  const moved = sum((r) => r.moved)
  const finished = sum((r) => r.finished)
  const details = sum((r) => r.metaUpdated)
  const parts = [
    added && plural(added, 'project') + ' added',
    created && plural(created, 'task') + ' added',
    updated && plural(updated, 'task') + ' updated',
    moved && plural(moved, 'task') + ' moved',
    finished && plural(finished, 'task') + ' finished',
    details && plural(details, 'due date or priority', 'due dates or priorities') + ' updated'
  ].filter(Boolean)
  lines.push({
    tone: 'ok',
    text: parts.length ? `${parts.join(', ')}.` : `Already up to date across ${plural(report.projects.length, 'project')}.`
  })

  if (report.withoutProject) {
    lines.push({
      tone: 'warn',
      text: `${plural(report.withoutProject, 'task')} skipped because ${report.withoutProject === 1 ? 'it has' : 'they have'} no project in dis-invoice. Assign one and sync again.`
    })
  }
  const reassigned = sum((r) => r.reassigned)
  if (reassigned) {
    lines.push({ tone: 'warn', text: `${plural(reassigned, 'task')} moved to another project in dis-invoice. The old notes were left in place.` })
  }
  const unplaced = sum((r) => r.unplaced)
  if (unplaced) lines.push({ tone: 'warn', text: `${plural(unplaced, 'task')} in a column dis-invoice did not list, so no card was moved.` })
  if (report.stopped.length) {
    lines.push({ tone: 'warn', text: `Stopped before adding: ${report.stopped.join(', ')}. No more projects can be opened right now, so their tasks did not sync.` })
  }
  for (const { nombre, message } of report.failed) {
    lines.push({ tone: 'error', text: `${nombre} was skipped and will be retried next sync. ${message}` })
  }
  for (const project of report.projects) {
    if (project.cloneSkipped) {
      lines.push({ tone: 'warn', text: `${project.nombre}: its folder already has other files and is not a repository, so nothing was cloned. Its tasks still synced.` })
    }
    if (project.canvasExposed) {
      lines.push({ tone: 'warn', text: `${project.nombre}: client task text is in .nodeterm/project.json and git can see it. Ignore .nodeterm/ or store this project's canvas in app data before you commit.` })
    }
  }
  if (report.skippedRemote.length) {
    lines.push({ tone: 'warn', text: `Skipped, because the canvas belongs to another machine: ${report.skippedRemote.join(', ')}.` })
  }
  return lines
}
