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
}

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
    setSwitch: (id, on) => run(() => window.nodeTerminal.tokenSavers.setSwitch(id, on))
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
  api.onUpdate((snap) => useTokenSavers.setState({ snap }))
  api.get().then(
    (snap) => useTokenSavers.setState({ snap }),
    () => useTokenSavers.setState({ unavailable: true })
  )
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
