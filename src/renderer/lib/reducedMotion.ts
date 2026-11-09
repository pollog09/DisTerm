import { useSyncExternalStore } from 'react'
import { WINDOW_ACTIVITY_ATTR } from './windowActivity'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

const motionQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION) : null

/** The system's Reduce Motion, live. An environment with no `matchMedia` reads as "no preference". */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const q = motionQuery()
      q?.addEventListener?.('change', onChange)
      return () => q?.removeEventListener?.('change', onChange)
    },
    () => motionQuery()?.matches ?? false
  )
}

/**
 * Is anybody looking at the window: the same answer the CSS animation gate reads
 * (`data-nt-window="idle"`, `windowActivity.ts`), or the page is hidden. For a JS frame loop, which
 * that gate cannot reach.
 */
export function windowWatched(doc: Document = document): boolean {
  return !doc.hidden && doc.documentElement.getAttribute(WINDOW_ACTIVITY_ATTR) !== 'idle'
}

export function useWindowWatched(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const watch = new MutationObserver(onChange)
      watch.observe(document.documentElement, { attributes: true, attributeFilter: [WINDOW_ACTIVITY_ATTR] })
      document.addEventListener('visibilitychange', onChange)
      return () => {
        watch.disconnect()
        document.removeEventListener('visibilitychange', onChange)
      }
    },
    () => windowWatched()
  )
}
