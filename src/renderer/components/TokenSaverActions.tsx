import { useState } from 'react'
import { capabilityAgentId } from '@shared/agents/config'
import { priceOf } from '@shared/token-savers'
import type { ContextWindowUsage } from '@shared/types'
import { chatSendRefusal } from '../lib/chatSendGate'
import { formatTokensShort } from '../lib/usageFormat'
import { useAgentStatus } from '../state/agentStatus'
import { useTokenSavers, useTokenSaversSnap, type CacheState } from '../state/tokenSavers'

/** A handoff is offered from this context size; it is pressed home from the second. */
export const HANDOFF_OFFER_TOKENS = 100_000
export const HANDOFF_URGE_TOKENS = 250_000
const KEEP_WARM_MINUTES = 60

/**
 * The token-saver actions in a Claude node's context meter (docs/reference/token-savers.md): hand off
 * a long chat to a fresh node, switch to the effort level effort-advisor suggested, keep the prompt
 * cache warm. Each needs its mod installed and on, and a LOCAL Claude session: the mods run in that
 * session, and a handoff file on this machine is not readable from an SSH host.
 */
export function TokenSaverActions({
  nodeId,
  agentId,
  remote,
  usage,
  cache
}: {
  nodeId: string
  agentId: string | undefined
  remote: boolean
  usage: ContextWindowUsage
  cache: CacheState | null
}): JSX.Element | null {
  const snap = useTokenSaversSnap()
  const pending = useTokenSavers((s) => !!s.pendingHandoff[nodeId])
  const [note, setNote] = useState('')
  if (!snap?.installed || remote || !agentId || capabilityAgentId(agentId) !== 'claude') return null
  const on = (id: keyof typeof snap.switches): boolean => snap.switches[id]
  // Read at click time, through the same gate the ⌘M composer uses: a command typed into a dialog
  // would answer it, and into a busy turn it would queue behind it.
  const type = async (text: string): Promise<boolean> => {
    if (chatSendRefusal(agentId, useAgentStatus.getState().byId[nodeId] ?? {}) !== null) {
      setNote('Claude is busy; try again when it is waiting for you.')
      return false
    }
    const ok = await window.nodeTerminal.pty.sendText(nodeId, text).catch(() => false)
    if (ok !== true) setNote('The terminal did not take the command.')
    return ok === true
  }

  const suggestion = on('effort-advisor') ? snap.effort[nodeId] : undefined
  const showEffort = suggestion && suggestion.level !== usage.effort
  const warm = snap.keepWarm[nodeId]
  const price = priceOf(usage.model)
  const pingUsd = price ? (usage.usedTokens * price.input * 0.1) / 1_000_000 : null
  const pings = snap.rows.filter((r) => r.mod === 'keep-warm' && r.nodeId === nodeId && warm && Date.parse(r.ts) >= warm.until - 2 * 3_600_000).length

  return (
    <div className="ctx-popover__actions">
      {on('handoff') && usage.usedTokens >= HANDOFF_OFFER_TOKENS && (
        <div className="ctx-popover__sub">
          {usage.usedTokens >= HANDOFF_URGE_TOKENS ? 'This chat is long: every message re-sends it. ' : ''}
          <button
            className="ctx-popover__link"
            disabled={pending}
            onClick={async (e) => {
              e.stopPropagation()
              if (await type('/handoff')) {
                useTokenSavers.getState().markHandoffPending(nodeId)
                setNote('Writing the handoff… a new node opens when it is ready.')
              }
            }}
          >
            {pending ? 'Writing handoff…' : 'Hand off to a fresh node'}
          </button>
        </div>
      )}
      {showEffort && (
        <div className="ctx-popover__sub" title={suggestion.why}>
          Effort advisor: <b>{suggestion.level}</b>
          {usage.effort ? ` (now ${usage.effort})` : ''} ·{' '}
          <button
            className="ctx-popover__link"
            onClick={(e) => {
              e.stopPropagation()
              void type(`/effort ${suggestion.level}`)
            }}
          >
            Switch
          </button>
          {cache && cache.kind !== 'cold' && (
            <> — switching now re-writes ~{formatTokensShort(usage.usedTokens)} cached tokens</>
          )}
        </div>
      )}
      {on('keep-warm') && cache && (
        <div className="ctx-popover__sub">
          {warm ? (
            <>
              Keeping the cache warm until{' '}
              {new Date(warm.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {pings} ping
              {pings === 1 ? '' : 's'} ·{' '}
              <button
                className="ctx-popover__link"
                onClick={(e) => {
                  e.stopPropagation()
                  void useTokenSavers.getState().setKeepWarm(nodeId, 0, usage.cacheTtlMs ?? 300_000)
                }}
              >
                Stop
              </button>
            </>
          ) : (
            cache.kind !== 'cold' && (
              <>
                <button
                  className="ctx-popover__link"
                  onClick={(e) => {
                    e.stopPropagation()
                    void useTokenSavers.getState().setKeepWarm(nodeId, KEEP_WARM_MINUTES, usage.cacheTtlMs ?? 300_000)
                  }}
                >
                  Keep the cache warm for 1 h
                </button>
                {pingUsd !== null && ` (~$${pingUsd.toFixed(3)} a ping)`}
              </>
            )
          )}
        </div>
      )}
      {note && <div className="ctx-popover__sub">{note}</div>}
    </div>
  )
}
