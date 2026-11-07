import { useEffect, useState } from 'react'
import { DIS_INVOICE_KEY_CHANGED, useDisInvoiceSyncRun, type DisInvoiceSyncControl } from '../../state/disInvoiceSyncRun'

export type { DisInvoiceSyncControl }

/** One button for both boards. A person presses it: nothing here polls or runs on its own. */
export function DisInvoiceSyncButton({ control }: { control: DisInvoiceSyncControl }): React.JSX.Element {
  const busy = useDisInvoiceSyncRun((s) => s.busy)
  const outcome = useDisInvoiceSyncRun((s) => s.outcome)
  const start = useDisInvoiceSyncRun((s) => s.start)
  const dismiss = useDisInvoiceSyncRun((s) => s.dismiss)
  // Unknown until status answers, and kept unknown if it fails: the press asks again either way.
  const [hasKey, setHasKey] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      control
        .status()
        .then((s) => {
          if (!cancelled) setHasKey(s.hasKey)
        })
        .catch(() => {})
    }
    refresh()
    window.addEventListener(DIS_INVOICE_KEY_CHANGED, refresh)
    return () => {
      cancelled = true
      window.removeEventListener(DIS_INVOICE_KEY_CHANGED, refresh)
    }
  }, [control, busy])

  const connect = hasKey === false && !busy

  return (
    <div className="kanban-header__filter kanban-sync">
      <button
        className={`kanban-filter-btn${busy ? ' kanban-filter-btn--on' : ''}`}
        disabled={busy}
        aria-busy={busy}
        title={connect ? 'Add your dis-invoice connector key in Settings' : 'Bring pending tasks from dis-invoice onto the board'}
        onClick={() => void start(control)}
      >
        {busy ? 'Syncing…' : connect ? 'Connect dis-invoice' : 'Sync'}
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
            <button className="kanban-filter-btn" onClick={dismiss}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
