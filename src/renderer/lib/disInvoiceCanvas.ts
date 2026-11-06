import type { CanvasNodeState, ProjectKanban } from '@shared/types'
import { useProjects } from '../state/projects'
import { flowToNodeStates, nodeStatesToFlow, type CanvasNode } from '../state/workspace'
import type { DisInvoiceSyncDeps } from './disInvoiceSync'

export interface DisInvoiceCanvasDeps {
  flowProjectId(): string | null | undefined
  flowNodes(): CanvasNode[]
  setFlowNodes(next: CanvasNode[]): void
  castNewNode(projectId: string, node: CanvasNode): void
  markDirty(): void
}

export type DisInvoiceCanvas = Pick<DisInvoiceSyncDeps, 'nodesOf' | 'boardOf' | 'applyProject'> & {
  flowOwnsProject(projectId: string): boolean
}

/** An existing node keeps what only the live canvas knows (measured size, selection): sync owns
 *  nothing on it but its text and its reference. */
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

export function disInvoiceCanvas(deps: DisInvoiceCanvasDeps): DisInvoiceCanvas {
  /**
   * React Flow holds this project and it is the active one, so `persist()` will commit `flowNodes`
   * over the store: a store-only write here would be erased. That includes the settle window after a
   * load (`loadingRef` set, epoch already installed). In the gap before a switch's load runs, the
   * refs are still the outgoing project's, whose commit already happened, so the store is the truth.
   */
  const flowOwnsProject = (projectId: string): boolean =>
    deps.flowProjectId() === projectId && useProjects.getState().activeProjectId === projectId

  const applyNodes = (projectId: string, upserts: CanvasNodeState[]): void => {
    if (!flowOwnsProject(projectId)) {
      useProjects.getState().applyOwnNodeMutations(projectId, upserts.map((node) => ({ op: 'upsert', node })))
      return
    }
    const { next, added } = mergeUpsertsIntoFlow(deps.flowNodes(), upserts)
    deps.setFlowNodes(next)
    for (const node of added) deps.castNewNode(projectId, node)
    deps.markDirty()
  }

  return {
    flowOwnsProject,
    nodesOf: (projectId) =>
      flowOwnsProject(projectId)
        ? flowToNodeStates(deps.flowNodes())
        : useProjects.getState().getProject(projectId)?.nodes ?? [],
    boardOf: (projectId) => useProjects.getState().getProject(projectId)?.kanban,
    applyProject(projectId: string, upserts: CanvasNodeState[], board: ProjectKanban | undefined): void {
      if (upserts.length > 0) applyNodes(projectId, upserts)
      if (!board) return
      useProjects.getState().setProjectKanban(projectId, board)
      deps.markDirty()
    }
  }
}
