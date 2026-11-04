import { useProjects } from '../../state/projects'
import { showAllProjectsBoard, showProjectBoard } from '../../state/viewMode'

export type KanbanScope = 'project' | 'all'

/**
 * The board's scope: this project's board or every project's (Omni). Omni is a scope of the
 * kanban side, so this switch — not a close button — is how the two boards reach each other;
 * leaving the board for the canvas stays the view toggle's job (Kanban tab, ⌘⇧B).
 */
export function KanbanScopeSwitch({ scope }: { scope: KanbanScope }): React.JSX.Element {
  const options: { id: KanbanScope; label: string }[] = [
    { id: 'project', label: 'This project' },
    { id: 'all', label: 'All projects' }
  ]
  const choose = (next: KanbanScope): void => {
    if (next === scope) return
    if (next === 'all') showAllProjectsBoard()
    else showProjectBoard(useProjects.getState().activeProjectId)
  }
  return (
    <div className="kanban-source-filter kanban-scope-switch" role="group" aria-label="Board scope">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={scope === option.id ? 'kanban-source-filter__button is-active' : 'kanban-source-filter__button'}
          aria-pressed={scope === option.id}
          onClick={() => choose(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
