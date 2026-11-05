import { useCallback, useEffect, useRef, useState } from 'react'
import { summarizeDisInvoiceSync, type DisInvoiceReportLine, type DisInvoiceSyncReport } from '../../lib/disInvoiceSync'

export interface DisInvoiceSyncControl {
  status: () => Promise<{ hasKey: boolean }>
  run: () => Promise<DisInvoiceSyncReport>
  openSettings: () => void
}

type Outcome = { lines: DisInvoiceReportLine[]; offerSettings: boolean }

/** One button for both boards. A person presses it: nothing here polls or runs on its own. */
export function DisInvoiceSyncButton({ control }: { control: DisInvoiceSyncControl }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const sync = useCallback(async () => {
    setOutcome(null)
    setBusy(true)
    let next: Outcome
    try {
      const { hasKey } = await control.status()
      if (!hasKey) {
        control.openSettings()
        return
      }
      const report = await control.run()
      if (report.failure?.reason === 'no-key') {
        control.openSettings()
        return
      }
      next = { lines: summarizeDisInvoiceSync(report), offerSettings: report.failure?.reason === 'unauthorized' }
    } catch {
      next = { lines: [{ tone: 'error', text: 'The sync stopped before it finished. Try again.' }], offerSettings: false }
    } finally {
      if (mounted.current) setBusy(false)
    }
    if (mounted.current) setOutcome(next)
  }, [control])

  return (
    <div className="kanban-header__filter kanban-sync">
      <button
        className={`kanban-filter-btn${busy ? ' kanban-filter-btn--on' : ''}`}
        disabled={busy}
        aria-busy={busy}
        title="Bring pending tasks from dis-invoice onto the board"
        onClick={() => void sync()}
      >
        {busy ? 'Syncing…' : 'Sync'}
      </button>
      {outcome && (
        <div className="kanban-filter-menu kanban-sync__report" role="status" aria-live="polite">
          {outcome.lines.map((line) => (
            <p key={line.text} className={`kanban-sync__line kanban-sync__line--${line.tone}`}>
              {line.text}
            </p>
          ))}
          <div className="kanban-sync__actions">
            {outcome.offerSettings && (
              <button className="kanban-filter-btn" onClick={control.openSettings}>
                Open Settings
              </button>
            )}
            <button className="kanban-filter-btn" onClick={() => setOutcome(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
