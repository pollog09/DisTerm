import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Canvas.tsx cannot be mounted in a test, so which board gets the button is pinned at source level.
const RENDERER = path.resolve(__dirname, '../..')
const read = (rel: string): string => readFileSync(path.join(RENDERER, rel), 'utf8').replace(/\r\n/g, '\n')

describe('the dis-invoice Sync button', () => {
  const canvas = read('canvas/Canvas.tsx')

  it('is hidden on a relay tab, whose board belongs to another machine', () => {
    expect(canvas).toContain(
      "disInvoiceSync={sessionForProject(activeProjectId).source === 'relay' ? undefined : disInvoiceSyncControl}"
    )
  })

  it('is on the Omni board, in its empty state too, because the first sync is what fills it', () => {
    expect(canvas).toContain('disInvoiceSync={disInvoiceSyncControl}')
    const button = '{disInvoiceSync && <DisInvoiceSyncButton control={disInvoiceSync} />}'
    expect(read('components/kanban/GlobalKanbanView.tsx').split(button)).toHaveLength(3)
  })

  it('only a person pressing it runs a sync: nothing else calls the orchestrator', () => {
    expect(canvas.match(/\brunDisInvoiceSync\(/g)).toHaveLength(1)
    expect(canvas.match(/\bsyncDisInvoice\b/g)).toHaveLength(3)
    expect(canvas).toContain('run: syncDisInvoice,')
  })
})
