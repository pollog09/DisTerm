import { useContext, useEffect, useState } from 'react'
import type { TerminalProfile } from '@shared/terminal-profiles'
import { SessionContext } from '../session/session'

/**
 * The shell picker's rows from the current session's core. Listing runs `wsl.exe`, so it only happens
 * when `enabled`; a failed read is an empty list, which leaves the free-text shell setting as it is.
 */
export function useTerminalProfiles(enabled: boolean): TerminalProfile[] {
  const api = useContext(SessionContext)?.api
  const [profiles, setProfiles] = useState<TerminalProfile[]>([])
  useEffect(() => {
    if (!enabled || !api) {
      setProfiles([])
      return
    }
    let live = true
    api.pty
      .terminalProfiles()
      .then((rows) => {
        if (live) setProfiles(rows)
      })
      .catch(() => {
        if (live) setProfiles([])
      })
    return () => {
      live = false
    }
  }, [enabled, api])
  return profiles
}
