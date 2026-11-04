import { AGENT_CONFIG, BUILTIN_AGENT_IDS } from '@shared/agents/config'
import { effectiveLimit } from '@shared/project-limit'
import { RELAY_UNAVAILABLE_REASON } from '@shared/relay-availability'
import { useProjectLimit } from '../../../state/projectLimit'
import { useRelayConfigured } from '../../../state/relayAvailability'

const LAN_PAIRING = 'QR phone pairing on your LAN'
const PHONE_REMOTE = 'Remote access from your phone (relay, E2E encrypted)'
const MOBILE_PRO = 'nodeterm mobile Pro included'
const SEATS = '3 team seats included (extra seats $5/seat/mo)'
const LIVE_LINKS = 'Live links to a terminal: watch, chat, or let people type — viewers need nothing installed'
/** The rows this build cannot deliver without a relay server. Copy only: the gates are elsewhere. */
const NEEDS_RELAY = new Set([LAN_PAIRING, PHONE_REMOTE, MOBILE_PRO, SEATS, LIVE_LINKS])

const AGENT_NODES = `Agent nodes (${BUILTIN_AGENT_IDS.map((id) => AGENT_CONFIG[id].label).join(' / ')})`
const CORE_REST = [
  'Groups, worktrees, git & diff',
  AGENT_NODES,
  LAN_PAIRING,
  PHONE_REMOTE
]
/** The Core list while the free-tier project limit is off: exactly the copy that shipped before it
 *  existed (and the Server Edition's permanent list — its limit is never on). */
const CORE = ['Unlimited local terminals & canvas', 'Unlimited SSH projects', ...CORE_REST]
const PRO = [
  MOBILE_PRO,
  SEATS,
  LIVE_LINKS,
  'Larger on-device dictation models (base, small, large-v3-turbo)'
]

/** One column's rows. With no relay, the rows that need one are not ticked and say why. */
function Rows({ rows, relayOn }: { rows: readonly string[]; relayOn: boolean }): React.JSX.Element {
  const off = relayOn ? [] : rows.filter((f) => NEEDS_RELAY.has(f))
  return (
    <>
      {rows
        .filter((f) => !off.includes(f))
        .map((f) => (
          <p key={f} className="text-text">
            ✓ {f}
          </p>
        ))}
      {off.map((f) => (
        <p key={f} className="text-muted">
          – {f}
        </p>
      ))}
      {off.length > 0 ? (
        <p className="text-xs" style={{ color: 'var(--warn)' }}>
          {RELAY_UNAVAILABLE_REASON}
        </p>
      ) : null}
    </>
  )
}

/** Core vs Pro comparison. While the open-project limit is on, Core must not read "free forever" or
 *  an unqualified "unlimited" (docs/project-limit.md): it names the user's allowance, and Pro gains
 *  unlimited open projects. */
export function ProCompare(): React.JSX.Element {
  const limitState = useProjectLimit((s) => s.state)
  const active = limitState.active
  const relayOn = useRelayConfigured() === true
  const core = active
    ? [
        `Up to ${effectiveLimit(limitState)} open projects`,
        'Unlimited terminals & canvas in each project',
        'SSH projects',
        ...CORE_REST
      ]
    : CORE
  const pro = active ? ['Unlimited open projects', ...PRO] : PRO
  return (
    <div className="grid grid-cols-2 gap-4 text-sm">
      <div className="space-y-2">
        <h4 className="text-[13px] font-medium text-muted">{active ? 'Core — free' : 'Core — free forever'}</h4>
        <Rows rows={core} relayOn={relayOn} />
      </div>
      <div className="space-y-2">
        <h4 className="text-[13px] font-medium" style={{ color: 'var(--accent)' }}>
          Pro
        </h4>
        <p className="text-text">✓ Everything in Core</p>
        <Rows rows={pro} relayOn={relayOn} />
      </div>
    </div>
  )
}
