// Canvas is too large to mount here, and a surface that forgets the WSL rows still compiles. This pins
// the surfaces named below to the one shared list. It cannot catch a new surface.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string =>
  readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')
const canvas = read('canvas/Canvas.tsx')

describe('the new-terminal surfaces offer the WSL rows', () => {
  it('lists once on a Windows core and publishes to the shared store', () => {
    expect(canvas).toContain('useTerminalProfiles(isWindowsCore)')
    expect(canvas).toContain('useWslTerminals.getState().publish(terminalProfiles)')
    expect(canvas.match(/useTerminalProfiles\(/g)).toHaveLength(1)
  })

  it('the group frame menu starts one inside the frame', () => {
    expect(canvas).toContain(
      'onClick: () => addTerminal(at, undefined, groupId, undefined, undefined, wsl.shell)'
    )
  })

  it('the sidebar "+" asks about its own project, not the active one', () => {
    expect(canvas).toContain('{ ...addCtx, wslTerminals: wslTerminalsForProject(projectId) }')
  })

  it('the palette has a row per distribution', () => {
    expect(canvas).toContain('id: `new-term-${wsl.shell}`')
  })

  it('the Dock and "New terminal here" reach addTerminal with the shell', () => {
    expect(canvas).toContain('onAddWslTerminal={(shell) =>')
    expect(canvas).toContain('addTerminal(undefined, undefined, undefined, d.cwd, undefined, d.shell)')
  })

  it('a board-created node keeps its shell, and a refused project opens nothing', () => {
    expect(canvas).toContain('data: { ...made.data, shell: wslShell }')
    expect(canvas.match(/!mayStartWslTerminal\(project\)/g)).toHaveLength(3)
  })

  it('the canvas surfaces offer a Claude in each, through the one path that asks its CLI', () => {
    expect(canvas).toContain('label: `New Claude: ${wsl.label}`')
    expect(canvas).toContain('id: `new-claude-${wsl.shell}`')
    expect(canvas).toContain('onAddWslClaude={(shell) => void addWslClaude(shell)}')
    expect(canvas.match(/void addWslClaude\(/g)).toHaveLength(3)
    expect(canvas).toContain('await ensureWslClaudeCliCaps(shell)')
    expect(canvas).toContain("{ wslShell: shell })")
  })

  it('a board-created Claude runs in the distribution and asks its CLI first', () => {
    expect(canvas).toContain("choice.kind === 'agent' && choice.shell && !capsAsked")
    expect(canvas).toContain('wslShell ? wslPermissionMode(project, wslShell) : activePermissionMode(choice.agentId)')
  })

  it.each([
    ['components/kanban/KanbanView.tsx', "wslCreateOptions(wslTerminals, !disabledAgents.includes('claude'))"],
    ['components/kanban/GlobalKanbanView.tsx', "wslCreateOptions(wslTerminals, !disabledAgents.includes('claude'))"],
    ['components/Dock.tsx', 'useWslTerminalsFor(activeProjectId)'],
    ['nodes/FilesNode.tsx', 'wslTerminalsForProject('],
    ['nodes/TerminalNode.tsx', 'wslTerminalsForProject(project?.id)']
  ])('%s reads the shared list', (file, needle) => {
    expect(read(file)).toContain(needle)
  })
})
