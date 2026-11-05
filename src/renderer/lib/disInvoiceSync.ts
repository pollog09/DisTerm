import type { CanvasNodeState, Project, ProjectKanban } from '@shared/types'
import type { DisInvoiceApi, DisInvoiceFailureReason, DisInvoiceTask } from '@shared/dis-invoice'
import {
  reconcileProject,
  type DisInvoiceSnapshot,
  type NewDisInvoiceSticky,
  type ReconcileReport
} from '@shared/dis-invoice-reconcile'

import { registeredCwd, type useProjects } from '../state/projects'
import { createStickyNode, flowToNodeStates, nodeStatesToFlow, type CanvasNode } from '../state/workspace'

type Proyecto = NonNullable<DisInvoiceTask['proyecto']>

export interface DisInvoiceProjectOutcome {
  proyectoId: number
  nombre: string
  projectId: string
  /** A DisTerm project this sync added. */
  created: boolean
  reconcile: ReconcileReport
  /** The repository landed in this project's folder during this sync. */
  cloned: boolean
  /** The folder holds other files and is not a repository, so the repository was not cloned. */
  cloneSkipped: boolean
  /** The project already existed, so its tasks synced, but its repository could not be cloned. */
  cloneFailed: string | null
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
  /** On a relay or SSH project, which runs on another machine. */
  skippedRemote: string[]
  /** On a project whose folder was missing at load: a save never writes a placeholder's nodes. */
  unavailable: string[]
}

/** `foreign`: a relay or SSH project already holds that folder. */
export type DisInvoiceProjectAdd = { kind: 'added'; project: Project } | { kind: 'refused' } | { kind: 'foreign' }

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
  /** Asked before any folder work, so a refusal costs neither a folder nor a clone. */
  gateNewProject(): Promise<boolean>
  /** Adds a project without switching tabs, asking the limit gate one last time. */
  addProject(name: string, folder: string): Promise<DisInvoiceProjectAdd>
}

const emptyReport = (): DisInvoiceSyncReport => ({
  noColumns: false,
  projects: [],
  withoutProject: 0,
  stopped: [],
  failed: [],
  skippedRemote: [],
  unavailable: []
})

type CloneFacts = Pick<DisInvoiceProjectOutcome, 'cloned' | 'cloneSkipped' | 'cloneFailed'>

const NOTHING_CLONED: CloneFacts = { cloned: false, cloneSkipped: false, cloneFailed: null }

type Resolution =
  | ({ kind: 'ready'; project: Project; created: boolean } & CloneFacts)
  | { kind: 'stopped' | 'foreign' | 'unavailable' }
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

  /** A project first synced before dis-invoice named its repository has a folder and no clone yet.
   *  Only an empty folder is cloned into, so an existing working tree is never touched. */
  const cloneIntoExisting = async (proyecto: Proyecto, project: Project): Promise<CloneFacts> => {
    if (!proyecto.githubRepo || !project.cwd) return NOTHING_CLONED
    if ((await originRepo(project.cwd)) === proyecto.githubRepo) return NOTHING_CLONED
    // "Set folder…" can move a project away from the folder its link recorded.
    if ((await disInvoice.plannedFolder(proyecto.id)) !== project.cwd) return NOTHING_CLONED
    const folder = await disInvoice.ensureFolder(proyecto.id)
    if (!folder.ok) return { ...NOTHING_CLONED, cloneFailed: folder.message }
    if (folder.isRepo) return NOTHING_CLONED
    if (!folder.empty) return { ...NOTHING_CLONED, cloneSkipped: true }
    const clone = await disInvoice.clone(proyecto.id)
    return clone.ok ? { ...NOTHING_CLONED, cloned: true } : { ...NOTHING_CLONED, cloneFailed: clone.message }
  }

  const useExisting = async (proyecto: Proyecto, project: Project): Promise<Resolution> => {
    if (!isLocal(project)) return { kind: 'foreign' }
    if (project.unavailable) return { kind: 'unavailable' }
    return { kind: 'ready', project, created: false, ...(await cloneIntoExisting(proyecto, project)) }
  }

  const createProject = async (proyecto: Proyecto): Promise<Resolution> => {
    if (refused || !(await deps.gateNewProject())) {
      refused = true
      return { kind: 'stopped' }
    }
    const folder = await disInvoice.ensureFolder(proyecto.id)
    if (!folder.ok) return { kind: 'failed', message: folder.message }

    let clone = NOTHING_CLONED
    if (proyecto.githubRepo && !folder.isRepo) {
      if (!folder.empty) clone = { ...NOTHING_CLONED, cloneSkipped: true }
      else {
        const cloned = await disInvoice.clone(proyecto.id)
        if (!cloned.ok) return { kind: 'failed', message: cloned.message }
        clone = { ...NOTHING_CLONED, cloned: true }
      }
    }

    const added = await deps.addProject(proyecto.nombre, folder.folder)
    if (added.kind === 'foreign') return { kind: 'foreign' }
    if (added.kind === 'refused') {
      refused = true
      return { kind: 'stopped' }
    }
    await disInvoice.saveLink(proyecto.id, added.project.id, folder.folder)
    return { kind: 'ready', project: added.project, created: true, ...clone }
  }

  const resolve = async (proyecto: Proyecto): Promise<Resolution> => {
    const linked = linkedProject(proyecto.id)
    if (linked) return useExisting(proyecto, linked)
    if (proyecto.githubRepo) {
      for (const project of deps.projects()) {
        if (project.closed || !isLocal(project) || !project.cwd) continue
        if ((await originRepo(project.cwd)) !== proyecto.githubRepo) continue
        await disInvoice.saveLink(proyecto.id, project.id, project.cwd)
        return useExisting(proyecto, project)
      }
    }
    const target = await disInvoice.plannedFolder(proyecto.id)
    if (!target) return { kind: 'failed', message: 'That project is not in the last sync.' }
    const atTarget = deps.projects().find((p) => p.cwd === target)
    if (!atTarget) return createProject(proyecto)
    if (isLocal(atTarget) && !atTarget.unavailable) await disInvoice.saveLink(proyecto.id, atTarget.id, target)
    return useExisting(proyecto, atTarget)
  }

  type Target = { proyectoId: number; nombre: string; project: Project; created: boolean } & CloneFacts
  const targets: Target[] = []

  // One at a time: the gate refuses a request while another is deciding, rather than queueing it.
  for (const proyecto of [...proyectos.values()].sort((a, b) => a.id - b.id)) {
    const resolved = await resolve(proyecto)
    if (resolved.kind === 'ready') targets.push({ ...resolved, proyectoId: proyecto.id, nombre: proyecto.nombre })
    else if (resolved.kind === 'failed') report.failed.push({ nombre: proyecto.nombre, message: resolved.message })
    else if (resolved.kind === 'stopped') report.stopped.push(proyecto.nombre)
    else (resolved.kind === 'foreign' ? report.skippedRemote : report.unavailable).push(proyecto.nombre)
  }

  // A linked project with nothing pending any more still has stickies to finish.
  for (const key of Object.keys(links)) {
    const proyectoId = Number(key)
    if (proyectos.has(proyectoId)) continue
    const linked = linkedProject(proyectoId)
    if (!linked || !isLocal(linked)) continue
    if (linked.unavailable) report.unavailable.push(linked.name)
    else targets.push({ proyectoId, nombre: linked.name, project: linked, created: false, ...NOTHING_CLONED })
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
      cloned: target.cloned,
      cloneSkipped: target.cloneSkipped,
      cloneFailed: target.cloneFailed,
      canvasExposed: exposedBy.get(projectId) ?? false
    })
  }

  if (changed) await deps.persist()
  return report
}

type ProjectStore = Pick<
  ReturnType<typeof useProjects.getState>,
  'projects' | 'registerProject' | 'setProjectStoreInAppData' | 'getProject'
>

/**
 * The store write behind adding a project. `registerProject` matches by cwd alone and un-closes what
 * it matches, so a relay or SSH project at this path is refused first, untouched. A folder that ships
 * a canvas is adopted as it is. A project created here stores its canvas in app data, to keep client
 * text out of the folder and out of git.
 */
export function registerDisInvoiceProject(
  store: ProjectStore,
  name: string,
  folder: string,
  probed: Project | null
): DisInvoiceProjectAdd {
  const holder = store.projects.find((p) => p.cwd === registeredCwd(folder))
  if (holder && !isLocal(holder)) return { kind: 'foreign' }
  const { project, created } = store.registerProject({ resolvedCwd: folder, name, probed: probed ?? undefined })
  if (!created) return { kind: 'added', project }
  store.setProjectStoreInAppData(project.id, true)
  return { kind: 'added', project: store.getProject(project.id) ?? project }
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
    if (project.cloneFailed) {
      lines.push({ tone: 'error', text: `${project.nombre}: its tasks synced, but its repository could not be cloned and will be retried next sync. ${project.cloneFailed}` })
    }
    if (project.canvasExposed) {
      lines.push({ tone: 'warn', text: `${project.nombre}: client task text is in .nodeterm/project.json and git can see it. Ignore .nodeterm/ or store this project's canvas in app data before you commit.` })
    }
  }
  if (report.skippedRemote.length) {
    lines.push({ tone: 'warn', text: `Skipped, because the project runs on another machine: ${report.skippedRemote.join(', ')}.` })
  }
  if (report.unavailable.length) {
    lines.push({ tone: 'warn', text: `Skipped, because the project's folder is unavailable: ${report.unavailable.join(', ')}. Restore it and sync again.` })
  }
  return lines
}
