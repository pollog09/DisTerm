import { agentGraphLog, type AgentGraphLog } from '../agent-graph/event-log'
import type { FileEdit } from '../../shared/agents/file-edit'
import { SYSTEM_MAP_FILE, relativeInsideRoot, systemMapOwner, type CompiledSystemMap } from '../../shared/system-map'

const ABSOLUTE_RE = /^[A-Za-z]:[\\/]/

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || ABSOLUTE_RE.test(p) || p.startsWith('\\\\')
}

/**
 * The system maps someone is viewing, and the edits that light their parts up (CLAUDE.md "System map"
 * in docs/reference/agent-graph.md). A project is here only while a view holds a lease on its map
 * (core/system-map/handlers.ts): no viewer, no matching, nothing recorded.
 *
 * THE PATH GOES NOWHERE. An edit's path is matched against each registered project's roots and globs
 * here, and only the part id it matched (or none) reaches the log. It is never stored, logged or sent.
 */
export class SystemMapTouches {
  private readonly projects = new Map<string, { roots: readonly string[]; compiled: CompiledSystemMap }>()

  constructor(private readonly log: AgentGraphLog = agentGraphLog) {}

  /** A viewed project's map (replaces the previous entry). */
  set(projectId: string, roots: readonly string[], compiled: CompiledSystemMap): void {
    this.projects.set(projectId, { roots: [...roots], compiled })
  }

  drop(projectId: string): void {
    this.projects.delete(projectId)
  }

  /** One Claude edit. Paths are matched here and go nowhere else. */
  recordEdit(nodeId: string, edit: FileEdit, now = Date.now()): void {
    let abs: string
    if (isAbsolutePath(edit.path)) abs = edit.path
    else if (edit.cwd && isAbsolutePath(edit.cwd)) abs = `${edit.cwd}/${edit.path}`
    else return
    for (const [projectId, { roots, compiled }] of this.projects) {
      let rel: string | null = null
      for (const root of roots) {
        rel = relativeInsideRoot(root, abs)
        if (rel !== null) break
      }
      if (rel === null || rel === SYSTEM_MAP_FILE) continue
      const owner = systemMapOwner(compiled, rel)
      // A lookup over its budget made no claim: not lit, and not "matched no part" either.
      if (owner === 'over-budget') continue
      this.log.recordMapTouch(projectId, nodeId, { partId: owner?.partId, subId: edit.subId, subType: edit.subType }, now)
    }
  }

  /** Test only. */
  projectIds(): string[] {
    return [...this.projects.keys()]
  }
}

export const systemMapTouches = new SystemMapTouches()
