import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Canvas.tsx cannot be mounted in a test, so which board gets the button is pinned at source level.
const RENDERER = path.resolve(__dirname, '../..')
const read = (rel: string): string => readFileSync(path.join(RENDERER, rel), 'utf8').replace(/\r\n/g, '\n')

describe('the dis-invoice Sync button', () => {
  const canvas = read('canvas/Canvas.tsx')

  it('is hidden on a relay tab on both boards, whose board belongs to another machine', () => {
    const guarded = "disInvoiceSync={sessionForProject(activeProjectId).source === 'relay' ? undefined : disInvoiceSyncControl}"
    expect(canvas.split(guarded)).toHaveLength(3)
    expect(canvas).not.toContain('disInvoiceSync={disInvoiceSyncControl}')
  })

  it('offers the accounts of the project a task’s rows start in, which an Omni lane need not be the active one', () => {
    const rows = canvas.slice(canvas.indexOf('disInvoiceStartItemsRef.current = '), canvas.indexOf('// ---- Board dispatch'))
    expect(rows).toContain('label: (agentLabel) => agentLabel,\n              projectId\n')
    expect(canvas).toContain('getProject(pick?.projectId ?? useProjects.getState().activeProjectId)')
  })

  it('is on the Omni board, in its empty state too, because the first sync is what fills it', () => {
    const button = '{disInvoiceSync && <DisInvoiceSyncButton control={disInvoiceSync} />}'
    expect(read('components/kanban/GlobalKanbanView.tsx').split(button)).toHaveLength(3)
  })

  it('starts an agent on the brief path its pane reads, asking about the shell the spawn will use', () => {
    const start = canvas.slice(canvas.indexOf('const startDisInvoiceWork = useCallback('), canvas.indexOf('disInvoiceStartItemsRef.current = '))
    expect(start).toContain('paneShell: trustedProjectShell(projectId) || useSettings.getState().settings.defaultShell')
    expect(start).toContain('briefPathInWsl: api.disInvoice.briefPathInWsl')
    expect(start).toContain('{ promptFile: brief.path, title }')
  })

  it('only a person pressing it runs a sync: nothing else calls the orchestrator', () => {
    expect(canvas.match(/\brunDisInvoiceSync\(/g)).toHaveLength(1)
    expect(canvas.match(/\bsyncDisInvoice\b/g)).toHaveLength(3)
    expect(canvas).toContain('run: syncDisInvoice,')
  })
})
