import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from './icons'
import { TOKEN_SAVER_INFO, type SaverTotals, type TokenSaverId } from '@shared/token-savers'
import { formatTokensShort } from '../lib/usageFormat'
import { useTokenSavers, useTokenSaversSnap } from '../state/tokenSavers'

export interface TokenSavingsPanelProps {
  onClose: () => void
  /** A canvas node's title, or undefined when the node is not on the open canvas. */
  nodeTitle: (nodeId: string) => string | undefined
}

function localDay(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const usd = (n: number): string => (Math.abs(n) < 0.01 && n !== 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)
const modTitle = (mod: string): string => TOKEN_SAVER_INFO[mod as TokenSaverId]?.title ?? mod

function Totals({ label, t }: { label: string; t: SaverTotals }): JSX.Element {
  return (
    <div className="tsp__card">
      <div className="tsp__card-label">{label}</div>
      <div className="tsp__card-big">~{formatTokensShort(t.saved)} tokens</div>
      <div className="tsp__card-sub">
        {t.actions} action{t.actions === 1 ? '' : 's'} · {formatTokensShort(t.before)} → {formatTokensShort(t.after)}
      </div>
      <div className="tsp__card-sub">
        Helper cost {usd(t.helperUsd)}
        {t.usdSaved !== 0 && ` · model choice ${t.usdSaved >= 0 ? 'saved' : 'cost'} ${usd(Math.abs(t.usdSaved))}`}
      </div>
      {t.leftOut > 0 && <div className="tsp__card-sub">{t.leftOut} left out (not believable)</div>}
    </div>
  )
}

/**
 * What the token-saver mods saved, across every agent on this machine (docs/reference/token-savers.md).
 * The ledger is the mods' own estimate (chars / 4) unless a row says REAL; the panel says which.
 */
export function TokenSavingsPanel({ onClose, nodeTitle }: TokenSavingsPanelProps): JSX.Element {
  const snap = useTokenSaversSnap()
  const unavailable = useTokenSavers((s) => s.unavailable)
  const [filter, setFilter] = useState<'today' | 'all'>('today')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows = useMemo(() => {
    if (!snap) return []
    return filter === 'today' ? snap.rows.filter((r) => localDay(Date.parse(r.ts)) === snap.day) : snap.rows
  }, [snap, filter])

  const nodes = useMemo(
    () => Object.entries(snap?.byNode ?? {}).sort((a, b) => b[1].saved - a[1].saved),
    [snap]
  )

  return createPortal(
    <div className="sc-overlay" onClick={onClose}>
      <div className="logpanel tsp" onClick={(e) => e.stopPropagation()}>
        <div className="logpanel__head">
          <h2>Token savings</h2>
          <div className="logpanel__chips">
            {(['today', 'all'] as const).map((f) => (
              <button key={f} className={`logpanel__chip${filter === f ? ' is-on' : ''}`} onClick={() => setFilter(f)}>
                {f === 'today' ? 'Today' : 'All time'}
              </button>
            ))}
          </div>
          <span className="tsp__spacer" />
          <button className="drawer__close" aria-label="Close" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="tsp__body">
          {unavailable && <p className="tsp__empty">Token savers are not available in this window.</p>}
          {!unavailable && !snap && <p className="tsp__empty">Loading…</p>}
          {snap && !snap.installed && snap.all.actions === 0 && (
            <p className="tsp__empty">
              The token savers are not installed. Settings → Token savers installs them into Claude Code.
            </p>
          )}
          {snap && (
            <>
              <div className="tsp__cards">
                <Totals label="Today" t={snap.today} />
                <Totals label="All time" t={snap.all} />
              </div>
              <h3 className="tsp__h">By mod</h3>
              <table className="tsp__table">
                <tbody>
                  {Object.entries(snap.byMod).map(([mod, t]) => (
                    <tr key={mod}>
                      <td>{modTitle(mod)}</td>
                      <td className="tsp__num">{t.actions}</td>
                      <td className="tsp__num">~{formatTokensShort(t.saved)}</td>
                      <td className="tsp__num">{usd(t.helperUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {nodes.length > 0 && (
                <>
                  <h3 className="tsp__h">By agent</h3>
                  <table className="tsp__table">
                    <tbody>
                      {nodes.map(([id, t]) => (
                        <tr key={id}>
                          <td>{nodeTitle(id) ?? <span className="tsp__muted">Not on this canvas</span>}</td>
                          <td className="tsp__num">{t.actions}</td>
                          <td className="tsp__num">~{formatTokensShort(t.saved)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              <h3 className="tsp__h">Actions</h3>
              {rows.length === 0 ? (
                <p className="tsp__empty">Nothing yet. A big file read, a subagent or a screenshot shows up here.</p>
              ) : (
                <table className="tsp__table">
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key} className={r.leftOut ? 'is-left-out' : undefined} title={r.leftOut || undefined}>
                        <td className="tsp__muted">{new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                        <td>{modTitle(r.mod)}</td>
                        <td>{r.action}</td>
                        <td className="tsp__num">
                          {r.before || r.after ? `${formatTokensShort(r.before)} → ${formatTokensShort(r.after)}` : ''}
                        </td>
                        <td className="tsp__num">{r.helper ? usd(r.helperUsd) : ''}</td>
                        <td className="tsp__badge">{r.leftOut ? 'LEFT OUT' : r.measured === 'real' ? 'REAL' : 'ESTIMATED'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {snap.skipped > 0 && <p className="tsp__muted">{snap.skipped} ledger lines could not be read.</p>}
              <p className="tsp__muted">
                Estimated rows count characters / 4. Only the newest 8 MB of the ledger and 300 actions are shown.
              </p>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
