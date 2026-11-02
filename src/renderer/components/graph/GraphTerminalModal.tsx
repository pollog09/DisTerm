import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { isTopDialog, nextDialogId, popDialog, pushDialog } from '../dialog-stack'
import { IconClose, IconExternal } from '../icons'
import type { KanbanSession } from '../kanban/KanbanView'
import { ModalTerminal } from '../kanban/ModalTerminal'

/**
 * A node's terminal, opened from the graph: the same co-attached viewer the board's card modal runs
 * (`ModalTerminal`, a second client on the node's tmux session), in the same sheet. Not the card modal
 * itself, which carries a board's worth of actions this view has no writers for; anything beyond
 * looking and typing is one click away through "Show on canvas".
 */
export function GraphTerminalModal({
  session,
  projectId,
  onClose,
  onShowOnCanvas
}: {
  session: KanbanSession
  projectId: string
  onClose: () => void
  onShowOnCanvas: () => void
}) {
  const [id] = useState(nextDialogId)
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    pushDialog(id)
    return () => popDialog(id)
  }, [id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !isTopDialog(id)) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    // Capture phase, as the card modal does: this must beat the terminal and the canvas's listeners.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [id, onClose])

  return createPortal(
    <div className="kanban-modal-scrim" onMouseDown={onClose}>
      <div className="kanban-modal agent-graph-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="kanban-modal__header">
          <span className="agent-graph-modal__title">{session.title || session.id}</span>
          <button className="agent-graph__button" onClick={onShowOnCanvas} title="Leave the graph and frame this node on the canvas">
            <IconExternal /> Show on canvas
          </button>
          <button className="agent-graph__button" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div className="kanban-modal__pane" data-kind="terminal">
          <ModalTerminal
            key={session.id}
            nodeId={session.id}
            spawn={session.spawn}
            searchOpen={searchOpen}
            onCloseSearch={() => setSearchOpen(false)}
            projectId={projectId}
          />
        </div>
      </div>
    </div>,
    document.body
  )
}
