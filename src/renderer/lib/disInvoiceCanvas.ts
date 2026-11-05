import type { CanvasNodeState, ProjectKanban } from '@shared/types'
import { useProjects } from '../state/projects'
import { flowToNodeStates, type CanvasNode } from '../state/workspace'
import { mergeUpsertsIntoFlow, type DisInvoiceSyncDeps } from './disInvoiceSync'

/** What Sync needs from the mounted canvas. Canvas passes its refs and setters and nothing else. */
export interface DisInvoiceCanvasDeps {
  /** The project React Flow holds. */
  flowProjectId(): string | null | undefined
  flowNodes(): CanvasNode[]
  setFlowNodes(next: CanvasNode[]): void
  castNewNode(projectId: string, node: CanvasNode): void
  markDirty(): void
}

export type DisInvoiceCanvas = Pick<DisInvoiceSyncDeps, 'nodesOf' | 'boardOf' | 'applyNodes' | 'applyBoard'> & {
  isLive(projectId: string): boolean
}

export function disInvoiceCanvas(deps: DisInvoiceCanvasDeps): DisInvoiceCanvas {
  /**
   * React Flow holds this project and it is the active one, so `persist()` will commit `flowNodes`
   * over the store: a store-only write here would be erased. That includes the settle window after a
   * load (`loadingRef` set, epoch already installed). In the gap before a switch's load runs, the
   * refs are still the outgoing project's, whose commit already happened, so the store is the truth.
   */
  const isLive = (projectId: string): boolean =>
    deps.flowProjectId() === projectId && useProjects.getState().activeProjectId === projectId

  return {
    isLive,
    nodesOf: (projectId) =>
      isLive(projectId) ? flowToNodeStates(deps.flowNodes()) : useProjects.getState().getProject(projectId)?.nodes ?? [],
    boardOf: (projectId) => useProjects.getState().getProject(projectId)?.kanban,
    applyNodes(projectId: string, upserts: CanvasNodeState[]): void {
      if (!isLive(projectId)) {
        useProjects.getState().applyOwnNodeMutations(projectId, upserts.map((node) => ({ op: 'upsert', node })))
        return
      }
      const { next, added } = mergeUpsertsIntoFlow(deps.flowNodes(), upserts)
      deps.setFlowNodes(next)
      for (const node of added) deps.castNewNode(projectId, node)
      deps.markDirty()
    },
    applyBoard(projectId: string, board: ProjectKanban): void {
      useProjects.getState().setProjectKanban(projectId, board)
      deps.markDirty()
    }
  }
}
