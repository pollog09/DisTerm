import { useContext, useEffect, useState } from 'react'
import type { TerminalProfile } from '@shared/terminal-profiles'
import { SessionContext } from '../session/session'

/** Listing runs `wsl.exe`, so regaining focus re-reads at most this often. */
export const PROFILE_REFRESH_GAP_MS = 60_000

/**
 * What a re-read leaves on screen. The core answers no distributions both when there are none and
 * when `wsl.exe` failed or timed out, and a failed read is never evidence of absence: distributions
 * already listed stay until a read names others. An unchanged answer keeps the same array.
 */
export function nextProfiles(
  current: TerminalProfile[],
  read: TerminalProfile[]
): TerminalProfile[] {
  const hadWsl = current.some((p) => p.kind === 'wsl')
  if (hadWsl && !read.some((p) => p.kind === 'wsl')) return current
  return JSON.stringify(current) === JSON.stringify(read) ? current : read
}

/**
 * The shell picker's rows from the current session's core, only when `enabled`. Read again when the
 * window regains focus, so a slow first `wsl.exe` or a distribution installed later shows up with no
 * restart. A failed read leaves what is there, which starts empty and keeps the free-text setting.
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
    let readAt = 0
    const read = (): void => {
      readAt = Date.now()
      api.pty
        .terminalProfiles()
        .then((rows) => {
          if (live) setProfiles((current) => nextProfiles(current, rows))
        })
        .catch(() => {})
    }
    const onFocus = (): void => {
      if (Date.now() - readAt >= PROFILE_REFRESH_GAP_MS) read()
    }
    read()
    window.addEventListener('focus', onFocus)
    return () => {
      live = false
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, api])
  return profiles
}
