import { AgentIcon } from '../../lib/agentIcons'
import { IconTerminal } from '../icons'
import type { WslTerminalRow } from '../../state/wslTerminals'
import type { KanbanCreateOption } from './KanbanView'

/** A board's "+ New" rows for this project's WSL distributions: a terminal in each, and a Claude in
 *  each unless Claude is switched off. */
export function wslCreateOptions(
  rows: readonly WslTerminalRow[],
  claudeEnabled = true
): KanbanCreateOption[] {
  return rows.flatMap((row): KanbanCreateOption[] => [
    {
      key: `terminal:${row.shell}`,
      label: row.label,
      choice: { kind: 'terminal', shell: row.shell },
      icon: <IconTerminal />
    },
    ...(claudeEnabled
      ? [
          {
            key: `claude:${row.shell}`,
            label: `Claude: ${row.label}`,
            choice: { kind: 'agent', agentId: 'claude', shell: row.shell },
            icon: <AgentIcon agentId="claude" />
          } satisfies KanbanCreateOption
        ]
      : [])
  ])
}
