// Pure part of keep-warm: whether a tick sends a cache ping. No engine calls here, so DisTerm's own
// tests import this file directly. KeepWarmEntry and the caps mirror src/shared/token-savers.ts.

export interface KeepWarmEntry {
  until: number
  ttlMs: number
}

/** The most pings one opt-in may send, and the longest one may run (KEEP_WARM_MAX_*). */
export const MAX_PINGS = 30
export const MAX_RUN_MS = 2 * 60 * 60 * 1000
/** A ping goes out this long before the cache entry would lapse. */
export const LEAD_MS = 45_000
/** How often the mod looks. Under LEAD_MS / 2, so a tick always falls inside the window. */
export const TICK_MS = 15_000
/** Failed pings in a row that end an opt-in. */
export const MAX_FAILURES = 3

export interface WarmState {
  /** A main-thread turn is running: its own requests keep the cache warm. */
  isBusy: boolean
  /** When the cache was last written or read by the main thread or a ping; 0 before any. */
  lastAt: number
  /** The opt-in (its `until`) the counters below belong to; null before one was seen. */
  optIn: number | null
  /** When that opt-in was first seen. */
  optInSeenAt: number
  pings: number
  failures: number
  /** A ping is out. */
  isPinging: boolean
}

export function initialState(): WarmState {
  return { isBusy: false, lastAt: 0, optIn: null, optInSeenAt: 0, pings: 0, failures: 0, isPinging: false }
}

export type Decision =
  | { kind: 'ping' }
  | { kind: 'wait'; why: string }
  /** This opt-in is over; nothing more is sent for it. */
  | { kind: 'done'; why: string }

/** A usable opt-in from the file's value for one node, or null. */
export function readEntry(v: unknown): KeepWarmEntry | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const until = o.until
  const ttlMs = o.ttlMs
  if (typeof until !== 'number' || !Number.isFinite(until)) return null
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= LEAD_MS + TICK_MS) return null
  return { until, ttlMs }
}

/** The state once a tick has read `entry`: a new opt-in starts its counters afresh. */
export function adoptEntry(state: WarmState, entry: KeepWarmEntry | null, now: number): WarmState {
  if (!entry || entry.until === state.optIn) return state
  return { ...state, optIn: entry.until, optInSeenAt: now, pings: 0, failures: 0 }
}

/**
 * Whether to ping now. A ping is worth it only in the window between `ttlMs - LEAD_MS` and
 * `ttlMs` after the last cache use: earlier the cache is still fresh, and later it has lapsed,
 * so a ping would pay to write the whole chat again instead of keeping it.
 */
export function shouldPing(state: WarmState, entry: KeepWarmEntry | null, now: number): Decision {
  if (!entry) return { kind: 'wait', why: 'not turned on for this node' }
  if (entry.until <= now) return { kind: 'done', why: 'opt-in ended' }
  if (state.optIn === entry.until && now - state.optInSeenAt >= MAX_RUN_MS) return { kind: 'done', why: 'ran its longest' }
  if (state.pings >= MAX_PINGS) return { kind: 'done', why: 'ping cap reached' }
  if (state.failures >= MAX_FAILURES) return { kind: 'done', why: 'pings kept failing' }
  if (state.isPinging) return { kind: 'wait', why: 'a ping is out' }
  if (state.isBusy) return { kind: 'wait', why: 'a turn is running' }
  if (state.lastAt <= 0) return { kind: 'wait', why: 'nothing cached yet' }
  const idle = now - state.lastAt
  if (idle >= entry.ttlMs) return { kind: 'wait', why: 'cache already lapsed' }
  if (idle < entry.ttlMs - LEAD_MS) return { kind: 'wait', why: 'cache still fresh' }
  return { kind: 'ping' }
}

/** What the fork is asked: it must answer at once, so the ping costs a cache read and a word. */
export const PING_PROMPT =
  'Automated cache refresh from a plugin, not a message from the person: you have no tools and ' +
  'nothing needs doing. Reply with exactly "OK" right away, without thinking it over.'
