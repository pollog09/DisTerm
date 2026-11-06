import type { CanvasNodeState, Project, ProjectKanban } from '@shared/types'
import type { DisInvoiceApi, DisInvoiceFailureReason, DisInvoiceTask } from '@shared/dis-invoice'
import {
  reconcileProject,
  type DisInvoiceSnapshot,
  type NewDisInvoiceSticky,
  type ReconcileReport
} from '@shared/dis-invoice-reconcile'

import { registeredCwd, type useProjects } from '../state/projects'
import { createStickyNode, defaultNodeSize, flowToNodeStates } from '../state/workspace'

type Proyecto = NonNullable<DisInvoiceTask['proyecto']>

export interface DisInvoiceProjectOutcome {
  proyectoId: number
  nombre: string
  projectId: string
  created: boolean
  reconcile: ReconcileReport
  cloned: boolean
  cloneSkipped: boolean
  /** Only on a project that already existed: a new project whose clone fails is not added. */
  cloneFailed: string | null
  canvasExposed: boolean
}

export interface DisInvoiceSyncReport {
  failure?: { reason: DisInvoiceFailureReason; message: string }
  noColumns: boolean
  projects: DisInvoiceProjectOutcome[]
  withoutProject: number
  stopped: string[]
  failed: Array<{ nombre: string; message: string }>
  skippedRemote: string[]
  /** On a project whose folder was missing at load: a save never writes a placeholder's nodes. */
  unavailable: string[]
}

export type DisInvoiceProjectAdd = { kind: 'added'; project: Project } | { kind: 'refused' } | { kind: 'foreign' }

export interface DisInvoiceSyncDeps {
  disInvoice: DisInvoiceApi
  projects(): readonly Project[]
  nodesOf(projectId: string): CanvasNodeState[]
  boardOf(projectId: string): ProjectKanban | undefined
  stickyFactory(nodes: readonly CanvasNodeState[]): NewDisInvoiceSticky
  /** One call per project, nodes before board, because the board publisher prunes cards against live
   *  node ids. Synchronous: nothing may run between a read and its write. */
  applyProject(projectId: string, upserts: CanvasNodeState[], board: ProjectKanban | undefined): void
  persist(): Promise<unknown>
  /** Asked before any folder work, so a refusal costs neither a folder nor a clone. */
  gateNewProject(): Promise<boolean>
  /** Asks the limit gate one last time: this is the deciding ask. */
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

type Target = { proyectoId: number; nombre: string; project: Project; created: boolean } & CloneFacts

const isLocal = (project: Project): boolean => !project.remote && !project.ssh

// One at a time: the gate refuses a request while another is deciding, rather than queueing it.
async function resolveProjectsOneAtATime(
  proyectos: Proyecto[],
  resolve: (proyecto: Proyecto) => Promise<Resolution>,
  report: DisInvoiceSyncReport
): Promise<Target[]> {
  const targets: Target[] = []
  for (const proyecto of proyectos) {
    const resolved = await resolve(proyecto)
    if (resolved.kind === 'ready') targets.push({ ...resolved, proyectoId: proyecto.id, nombre: proyecto.nombre })
    else if (resolved.kind === 'failed') report.failed.push({ nombre: proyecto.nombre, message: resolved.message })
    else if (resolved.kind === 'stopped') report.stopped.push(proyecto.nombre)
    else (resolved.kind === 'foreign' ? report.skippedRemote : report.unavailable).push(proyecto.nombre)
  }
  return targets
}

/** Synchronous, so a read of a project's nodes and the write built from it cannot be split. */
function reconcileAndApply(
  deps: Pick<DisInvoiceSyncDeps, 'nodesOf' | 'boardOf' | 'stickyFactory' | 'applyProject'>,
  targets: readonly Target[],
  snapshot: DisInvoiceSnapshot,
  exposedBy: ReadonlyMap<string, boolean>,
  report: DisInvoiceSyncReport
): boolean {
  const proyectosOf = new Map<string, Set<number>>()
  for (const { project, proyectoId } of targets) {
    proyectosOf.set(project.id, (proyectosOf.get(project.id) ?? new Set<number>()).add(proyectoId))
  }

  let changed = false
  for (const target of targets) {
    const projectId = target.project.id
    const nodes = deps.nodesOf(projectId)
    const board = deps.boardOf(projectId)
    const result = reconcileProject(nodes, board, snapshot, target.proyectoId, deps.stickyFactory(nodes), proyectosOf.get(projectId))
    const nextBoard = result.board && result.board !== board ? result.board : undefined
    if (result.upserts.length > 0 || nextBoard) {
      deps.applyProject(projectId, result.upserts, nextBoard)
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
  return changed
}

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

  /** Only an empty folder is cloned into, so an existing working tree is never touched. */
  const cloneInto = async (proyecto: Proyecto, folder: { isRepo: boolean; empty: boolean }): Promise<CloneFacts> => {
    if (!proyecto.githubRepo || folder.isRepo) return NOTHING_CLONED
    if (!folder.empty) return { ...NOTHING_CLONED, cloneSkipped: true }
    const clone = await disInvoice.clone(proyecto.id)
    return clone.ok ? { ...NOTHING_CLONED, cloned: true } : { ...NOTHING_CLONED, cloneFailed: clone.message }
  }

  /** A project first synced before dis-invoice named its repository has a folder and no clone yet. */
  const cloneIntoExisting = async (proyecto: Proyecto, project: Project): Promise<CloneFacts> => {
    if (!proyecto.githubRepo || !project.cwd) return NOTHING_CLONED
    if ((await originRepo(project.cwd)) === proyecto.githubRepo) return NOTHING_CLONED
    // "Set folder…" can move a project away from the folder its link recorded.
    if ((await disInvoice.plannedFolder(proyecto.id)) !== project.cwd) return NOTHING_CLONED
    const folder = await disInvoice.ensureFolder(proyecto.id)
    return folder.ok ? cloneInto(proyecto, folder) : { ...NOTHING_CLONED, cloneFailed: folder.message }
  }

  const useExisting = async (proyecto: Proyecto, project: Project): Promise<Resolution> => {
    if (!isLocal(project)) return { kind: 'foreign' }
    if (project.unavailable) return { kind: 'unavailable' }
    return { kind: 'ready', project, created: false, ...(await cloneIntoExisting(proyecto, project)) }
  }

  const linkExisting = async (proyecto: Proyecto, project: Project, folder: string): Promise<Resolution> => {
    const resolved = await useExisting(proyecto, project)
    if (resolved.kind === 'ready') await disInvoice.saveLink(proyecto.id, project.id, folder)
    return resolved
  }

  const createProject = async (proyecto: Proyecto): Promise<Resolution> => {
    if (refused || !(await deps.gateNewProject())) {
      refused = true
      return { kind: 'stopped' }
    }
    const folder = await disInvoice.ensureFolder(proyecto.id)
    if (!folder.ok) return { kind: 'failed', message: folder.message }
    const clone = await cloneInto(proyecto, folder)
    if (clone.cloneFailed) return { kind: 'failed', message: clone.cloneFailed }

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
        if ((await originRepo(project.cwd)) === proyecto.githubRepo) return linkExisting(proyecto, project, project.cwd)
      }
    }
    const target = await disInvoice.plannedFolder(proyecto.id)
    if (!target) return { kind: 'failed', message: 'That project is not in the last sync.' }
    const atTarget = deps.projects().find((p) => p.cwd === target)
    return atTarget ? linkExisting(proyecto, atTarget, target) : createProject(proyecto)
  }

  const sorted = [...proyectos.values()].sort((a, b) => a.id - b.id)
  const targets = await resolveProjectsOneAtATime(sorted, resolve, report)

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

  const applied = reconcileAndApply(deps, targets, snapshot, exposedBy, report)
  const changed = applied || targets.some((target) => target.created)
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

/** Lays mirrored stickies in a grid below whatever else is on the canvas, each in the first slot no
 *  mirror covers, because deleting one frees a slot while later ones stay put. */
export function disInvoiceStickyFactory(nodes: readonly CanvasNodeState[]): NewDisInvoiceSticky {
  const bottom = nodes
    .filter((node) => !node.disInvoiceRef)
    .reduce((lowest, node) => Math.max(lowest, node.position.y + node.size.height), 0)
  const top = bottom ? bottom + GRID_GAP : GRID_GAP
  const { width, height } = defaultNodeSize('sticky')
  const occupied = nodes
    .filter((node) => node.disInvoiceRef)
    .map((node) => ({ ...node.position, width: node.size.width, height: node.size.height }))

  const takeFreeSlot = (): { x: number; y: number } => {
    for (let slot = 0; ; slot++) {
      const x = GRID_GAP + (slot % GRID_COLUMNS) * (width + GRID_GAP)
      const y = top + Math.floor(slot / GRID_COLUMNS) * (height + GRID_GAP)
      if (occupied.some((o) => x < o.x + o.width && o.x < x + width && y < o.y + o.height && o.y < y + height)) continue
      occupied.push({ x, y, width, height })
      return { x, y }
    }
  }

  return ({ id, text, ref }) => {
    const { x, y } = takeFreeSlot()
    const made = createStickyNode(0, { x: x + width / 2, y: y + height / 2 })
    return flowToNodeStates([{ ...made, id, data: { ...made.data, text, disInvoiceRef: ref } }])[0]
  }
}

export interface DisInvoiceReportLine {
  tone: 'ok' | 'warn' | 'error'
  text: string
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`

export function summarizeDisInvoiceSync(report: DisInvoiceSyncReport): DisInvoiceReportLine[] {
  if (report.failure) return [{ tone: 'error', text: report.failure.message }]
  if (report.noColumns) {
    return [{ tone: 'warn', text: 'dis-invoice has no columns yet. Open its board once, then sync again. Nothing was changed.' }]
  }
  const lines: DisInvoiceReportLine[] = []
  // A set, because two dis-invoice projects on one DisTerm project each see the same sticky.
  const sum = (pick: (r: ReconcileReport) => number[]): number =>
    new Set(report.projects.flatMap((project) => pick(project.reconcile))).size

  const added = report.projects.filter((p) => p.created).length
  const created = sum((r) => r.created)
  const updated = sum((r) => r.textUpdated)
  const moved = sum((r) => r.moved)
  const finished = sum((r) => r.finished)
  const details = sum((r) => r.metaUpdated)
  const cloned = report.projects.filter((p) => p.cloned).length
  const columns = report.projects.reduce((total, p) => total + p.reconcile.columnsAdded, 0)
  const duplicates = report.projects.reduce((total, p) => total + p.reconcile.duplicatesCleared, 0)
  const parts = [
    added && plural(added, 'project') + ' added',
    cloned && plural(cloned, 'repository', 'repositories') + ' cloned',
    columns && plural(columns, 'column') + ' added',
    created && plural(created, 'task') + ' added',
    updated && plural(updated, 'task') + ' updated',
    moved && plural(moved, 'task') + ' moved',
    finished && plural(finished, 'task') + ' finished',
    details && plural(details, 'due date or priority', 'due dates or priorities') + ' updated',
    duplicates && plural(duplicates, 'duplicate note') + ' unlinked'
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
  const noFinishedColumn = sum((r) => r.noFinishedColumn)
  if (noFinishedColumn) {
    lines.push({ tone: 'warn', text: `${plural(noFinishedColumn, 'task')} left the pending list, but dis-invoice lists no finished column, so no card was moved. They move once it has one.` })
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
