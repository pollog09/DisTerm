import { useEffect } from 'react'
import { create } from 'zustand'

// Whether this core has a relay server configured. Read once: NODETERM_RELAY_URL is fixed for the
// life of the process. `null` = not answered yet, which every surface treats as "not available" so a
// control is never enabled on a guess. A failed read is `false`, for the same reason.
interface RelayAvailabilityState {
  configured: boolean | null
  load: () => void
}

let asked = false

export const useRelayAvailability = create<RelayAvailabilityState>((set, get) => ({
  configured: null,
  load: () => {
    if (asked || get().configured !== null) return
    asked = true
    void Promise.resolve()
      .then(() => window.nodeTerminal.remoteHost.relayConfigured())
      .then(
        (configured) => set({ configured: configured === true }),
        () => set({ configured: false })
      )
  }
}))

/** The answer, loading it on first use. */
export function useRelayConfigured(): boolean | null {
  const configured = useRelayAvailability((s) => s.configured)
  useEffect(() => useRelayAvailability.getState().load(), [])
  return configured
}

/** Test seam: forget the answer so the next `load` asks again. */
export function resetRelayAvailabilityForTest(): void {
  asked = false
  useRelayAvailability.setState({ configured: null })
}
