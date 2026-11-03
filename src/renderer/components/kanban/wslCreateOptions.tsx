import { IconTerminal } from '../icons'
import type { WslTerminalRow } from '../../state/wslTerminals'
import type { KanbanCreateOption } from './KanbanView'

/** A board's "+ New" rows for this project's WSL distributions, beside its plain "Terminal". */
export function wslCreateOptions(rows: readonly WslTerminalRow[]): KanbanCreateOption[] {
  return rows.map((row) => ({
    key: `terminal:${row.shell}`,
    label: row.label,
    choice: { kind: 'terminal', shell: row.shell },
    icon: <IconTerminal />
  }))
}
