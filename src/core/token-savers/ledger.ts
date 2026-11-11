// Pure: the token-savers ledger (`~/.nodeterm/token-savers/savings.jsonl`) → the snapshot DisTerm
// draws. The mods append; this never writes. Rules in docs/reference/token-savers.md § Ledger.
import {
  LEFT_OUT_MAX_BEFORE,
  LEFT_OUT_MAX_RATIO,
  emptyTotals,
  priceOf,
  type LedgerLine,
  type LedgerRow,
  type SaverTotals,
  type TokenSaversSnapshot
} from '../../shared/token-savers'

export const LEDGER_MAX_ROWS = 300

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** One raw line → a ledger line, or null when it is not one (bad JSON, no numbers, no mod). */
export function parseLedgerLine(raw: string): LedgerLine | null {
  const s = raw.trim()
  if (!s) return null
  let o: Record<string, unknown>
  try {
    const v: unknown = JSON.parse(s)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    o = v as Record<string, unknown>
  } catch {
    return null
  }
  const before = num(o.before)
  const after = num(o.after)
  const mod = str(o.mod)
  const ts = str(o.ts)
  if (before === null || after === null || !mod || !ts || !Number.isFinite(Date.parse(ts))) return null
  const h = o.helper as Record<string, unknown> | null | undefined
  const helper =
    h && typeof h === 'object' && str(h.model)
      ? { model: h.model as string, in: num(h.in) ?? 0, out: num(h.out) ?? 0 }
      : null
  const usd = num(o.usd_saved)
  return {
    ts,
    session: str(o.session),
    nodeId: str(o.nodeId),
    tool_use_id: str(o.tool_use_id),
    mod,
    action: str(o.action) ?? '',
    before: Math.max(0, before),
    after: Math.max(0, after),
    helper,
    measured: o.measured === 'real' ? 'real' : 'estimated',
    ...(usd !== null && { usd_saved: usd })
  }
}

/** Why a line counts in no total, or '' when it counts. Dollar-only lines (before = after = 0) count. */
export function leftOutReason(l: LedgerLine): string {
  if (l.before > LEFT_OUT_MAX_BEFORE) return `before is over ${LEFT_OUT_MAX_BEFORE.toLocaleString('en-US')} tokens`
  if (l.after > 0 && l.before / l.after > LEFT_OUT_MAX_RATIO) return `a cut of more than ${LEFT_OUT_MAX_RATIO}x`
  if (l.after > l.before) return 'after is larger than before'
  return ''
}

export function helperUsd(l: LedgerLine): number {
  if (!l.helper) return 0
  const p = priceOf(l.helper.model)
  if (!p) return 0
  return (l.helper.in * p.input + l.helper.out * p.output) / 1_000_000
}

/** The local calendar day of a timestamp, YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function add(t: SaverTotals, r: LedgerRow): void {
  if (r.leftOut) {
    t.leftOut += 1
    return
  }
  t.actions += 1
  t.before += r.before
  t.after += r.after
  t.saved += r.saved
  t.helperUsd += r.helperUsd
  t.usdSaved += r.usd_saved ?? 0
}

/**
 * Text of the ledger → totals and rows. Each `tool_use_id` counts once: a later line for the same id
 * replaces the earlier one, except that an `estimated` line never replaces a `real` one.
 */
export function aggregateLedger(
  text: string,
  now: number
): Omit<TokenSaversSnapshot, 'installed' | 'installError' | 'switches'> {
  const byKey = new Map<string, LedgerRow>()
  let skipped = 0
  let n = 0
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    const l = parseLedgerLine(raw)
    if (!l) {
      skipped += 1
      continue
    }
    n += 1
    const key = l.tool_use_id ? `${l.mod}:${l.tool_use_id}` : `#${n}`
    const prev = byKey.get(key)
    if (prev && prev.measured === 'real' && l.measured === 'estimated') continue
    if (prev) byKey.delete(key) // re-insert so Map order follows the latest line
    const leftOut = leftOutReason(l)
    byKey.set(key, { ...l, key, saved: l.before - l.after, helperUsd: helperUsd(l), leftOut })
  }
  const day = localDay(now)
  const today = emptyTotals()
  const all = emptyTotals()
  const byNode: Record<string, SaverTotals> = {}
  const byMod: Record<string, SaverTotals> = {}
  const rows = [...byKey.values()]
  for (const r of rows) {
    add(all, r)
    if (localDay(Date.parse(r.ts)) === day) add(today, r)
    if (r.nodeId) add((byNode[r.nodeId] ??= emptyTotals()), r)
    add((byMod[r.mod] ??= emptyTotals()), r)
  }
  rows.reverse()
  return { day, today, all, byNode, byMod, rows: rows.slice(0, LEDGER_MAX_ROWS), skipped }
}
