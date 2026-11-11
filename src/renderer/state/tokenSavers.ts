// The token-savers snapshot (core/token-savers/service.ts), one subscription for the whole window.
// The panel, the Settings section and every context meter read it from here.
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { TokenSaverId, TokenSaversSnapshot } from '@shared/token-savers'

interface TokenSaversState {
  snap: TokenSaversSnapshot | null
  /** Set when the bridge has no token savers (a relay tab), so the UI hides instead of spinning. */
  unavailable: boolean
  busy: boolean
  panelOpen: boolean
  setPanelOpen(open: boolean): void
  install(): Promise<void>
  uninstall(): Promise<void>
  setSwitch(id: TokenSaverId, on: boolean): Promise<void>
  setKeepWarm(nodeId: string, minutes: number, ttlMs: number): Promise<void>
  /** Nodes that asked for a handoff, with when: the next handoff file for one opens a new node. */
  pendingHandoff: Record<string, number>
  /** `/handoff` was typed into the node's pane: wait for its file. */
  markHandoffPending(nodeId: string): void
}

/** The event Canvas answers by opening a new agent node seeded with the handoff file. */
export const HANDOFF_READY_EVENT = 'nodeterm:token-savers-handoff'
export interface HandoffReadyDetail {
  nodeId: string
  file: string
}
/** How long a requested handoff is waited for before the request is dropped. */
const HANDOFF_WAIT_MS = 5 * 60_000

let started = false

export const useTokenSavers = create<TokenSaversState>((set) => {
  const run = async (fn: () => Promise<TokenSaversSnapshot>): Promise<void> => {
    set({ busy: true })
    try {
      set({ snap: await fn() })
    } catch {
      /* the next push carries the state; the error text, if any, is in snap.installError */
    } finally {
      set({ busy: false })
    }
  }
  return {
    snap: null,
    unavailable: false,
    busy: false,
    panelOpen: false,
    setPanelOpen: (panelOpen) => set({ panelOpen }),
    install: () => run(() => window.nodeTerminal.tokenSavers.install()),
    uninstall: () => run(() => window.nodeTerminal.tokenSavers.uninstall()),
    setSwitch: (id, on) => run(() => window.nodeTerminal.tokenSavers.setSwitch(id, on)),
    setKeepWarm: (nodeId, minutes, ttlMs) => run(() => window.nodeTerminal.tokenSavers.setKeepWarm(nodeId, minutes, ttlMs)),
    pendingHandoff: {},
    markHandoffPending: (nodeId) => set((st) => ({ pendingHandoff: { ...st.pendingHandoff, [nodeId]: Date.now() } }))
  }
})

/** Start the subscription once, on first use. */
export function ensureTokenSavers(): void {
  if (started) return
  started = true
  const api = window.nodeTerminal?.tokenSavers
  if (!api) {
    useTokenSavers.setState({ unavailable: true })
    return
  }
  api.onUpdate((snap) => {
    useTokenSavers.setState({ snap })
    settleHandoffs(snap)
  })
  api.get().then(
    (snap) => useTokenSavers.setState({ snap }),
    () => useTokenSavers.setState({ unavailable: true })
  )
}

/** A requested handoff whose file has arrived opens a new node, once. Pure apart from the event. */
export function settleHandoffs(snap: TokenSaversSnapshot, now = Date.now()): void {
  const pending = useTokenSavers.getState().pendingHandoff
  const left: Record<string, number> = {}
  let moved = false
  for (const [nodeId, askedAt] of Object.entries(pending)) {
    const h = snap.handoffs[nodeId]
    // A little slack: the mod stamps the file with its own clock.
    if (h && h.at >= askedAt - 5_000) {
      window.dispatchEvent(new CustomEvent<HandoffReadyDetail>(HANDOFF_READY_EVENT, { detail: { nodeId, file: h.file } }))
      moved = true
    } else if (now - askedAt < HANDOFF_WAIT_MS) left[nodeId] = askedAt
    else moved = true
  }
  if (moved) useTokenSavers.setState({ pendingHandoff: left })
}

export function useTokenSaversSnap(): TokenSaversSnapshot | null {
  useEffect(ensureTokenSavers, [])
  return useTokenSavers((s) => s.snap)
}

/** Milliseconds now, re-rendered every `everyMs` while `active`. */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [active, everyMs])
  return now
}

export type CacheState = { kind: 'warm' | 'cooling' | 'cold'; leftMs: number }

/** Warm with more than a minute left, cooling under a minute, cold once the TTL has passed. Pure. */
export function cacheState(lastReplyAt: number, ttlMs: number, now: number): CacheState {
  const leftMs = lastReplyAt + ttlMs - now
  if (leftMs <= 0) return { kind: 'cold', leftMs: 0 }
  return { kind: leftMs <= 60_000 ? 'cooling' : 'warm', leftMs }
}

export function formatClock(ms: number): string {
  const s = Math.ceil(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}
