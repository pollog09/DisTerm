import { create } from 'zustand'
import { summarizeDisInvoiceSync, type DisInvoiceReportLine, type DisInvoiceSyncReport } from '../lib/disInvoiceSync'

export interface DisInvoiceSyncControl {
  status: () => Promise<{ hasKey: boolean }>
  run: () => Promise<DisInvoiceSyncReport>
  openSettings: () => void
}

/** Settings fires this after a key is saved or removed, so a board already open relabels its button. */
export const DIS_INVOICE_KEY_CHANGED = 'nodeterm:dis-invoice-key-changed'

export interface DisInvoiceSyncOutcome {
  lines: DisInvoiceReportLine[]
  offerSettings: boolean
}

interface DisInvoiceSyncRunState {
  busy: boolean
  outcome: DisInvoiceSyncOutcome | null
  start(control: DisInvoiceSyncControl): Promise<void>
  dismiss(): void
}

async function runOnce(control: DisInvoiceSyncControl): Promise<DisInvoiceSyncOutcome | null> {
  try {
    const { hasKey } = await control.status()
    if (!hasKey) {
      control.openSettings()
      return null
    }
    const report = await control.run()
    if (report.failure?.reason === 'no-key') {
      control.openSettings()
      return null
    }
    return { lines: summarizeDisInvoiceSync(report), offerSettings: report.failure?.reason === 'unauthorized' }
  } catch {
    return { lines: [{ tone: 'error', text: 'The sync stopped before it finished. Try again.' }], offerSettings: false }
  }
}

/** Outside the button, because a clone can outlast the board it was pressed on: switching boards
 *  unmounts the button, and the next one has to show the run and its report. */
export const useDisInvoiceSyncRun = create<DisInvoiceSyncRunState>((set, get) => ({
  busy: false,
  outcome: null,
  async start(control) {
    if (get().busy) return
    set({ busy: true, outcome: null })
    const outcome = await runOnce(control)
    set({ busy: false, outcome })
  },
  dismiss() {
    set({ outcome: null })
  }
}))
