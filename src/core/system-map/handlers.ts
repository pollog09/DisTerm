import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../../shared/ipc'
import { SHIP_LEASE_MS } from '../../shared/ship-config'
import { SYSTEM_MAP_FILE } from '../../shared/system-map'
import type { CorePlatform } from '../platform'
import { SHIP_POLL_LOCAL_MS, SHIP_POLL_REMOTE_MS } from '../ship-config/handlers'
import { readSystemMap, readSystemMapFull, type SystemMapRouter } from './read'
import { systemMapTouches, type SystemMapTouches } from './touches'

/** A local map whose file did not change is still read in full this often: a commit changes its header
 *  without touching the file. */
export const SYSTEM_MAP_FULL_READ_MS = 60_000

/**
 * Registered once per shell. The same lease model as ship config (`registerShipConfigHandlers`): a view
 * renews its lease, a dead one simply stops, every tick is routed again, and one poll read per project
 * runs at a time. While a project holds a lease its map is also registered with `touches`, which is what
 * lets an edit light a part; when the last lease goes, so does the registration.
 *
 * A LOCAL tick stats the file first and re-reads only on a change (or every `SYSTEM_MAP_FULL_READ_MS`),
 * because a full read runs git twice. A remote tick reads in full: one `ssh sh -s` either way.
 */
export function registerSystemMapHandlers(platform: CorePlatform, router: SystemMapRouter, touches: SystemMapTouches = systemMapTouches): void {
  platform.handle(IPC.systemMapRead, (projectId: unknown) => readSystemMap(projectId, router))

  interface Sub {
    leases: Map<string, number>
    stop: () => void
  }
  const subs = new Map<string, Sub>()
  /** Survives a lapsed subscription, so a view that lost its lease while hidden still hears of what
   *  changed in the meantime. One string per project someone looked at. */
  const lastSeen = new Map<string, string>()
  const polling = new Map<string, Promise<unknown>>()

  const start = (projectId: string, sub: Pick<Sub, 'leases'>): (() => void) => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let statSignature: string | undefined
    let lastFullRead = 0
    let first = true
    const end = (): void => {
      alive = false
      clearTimeout(timer)
      touches.drop(projectId)
    }

    /** Whether this tick needs a full read; a local route answers from a stat of the file. */
    const needsFullRead = async (): Promise<boolean> => {
      let route: ReturnType<SystemMapRouter['route']>
      try {
        route = router.route(projectId)
      } catch {
        return true
      }
      if (route.kind !== 'local' || !route.cwd) return true
      let signature: string
      try {
        const stat = await fs.promises.stat(path.join(route.cwd, SYSTEM_MAP_FILE))
        signature = `${stat.mtimeMs}:${stat.size}`
      } catch {
        signature = 'absent'
      }
      const changed = signature !== statSignature
      statSignature = signature
      return first || changed || Date.now() - lastFullRead >= SYSTEM_MAP_FULL_READ_MS
    }

    const tick = async (): Promise<void> => {
      if (!alive) return
      const now = Date.now()
      for (const [id, expires] of sub.leases) if (expires <= now) sub.leases.delete(id)
      if (sub.leases.size === 0) {
        end()
        subs.delete(projectId)
        return
      }
      for (let out = polling.get(projectId); out; out = polling.get(projectId)) {
        await out.catch(() => {})
        if (!alive) return
      }
      const full = await needsFullRead()
      if (!alive) return
      first = false
      if (full) {
        const read = readSystemMapFull(projectId, router)
        polling.set(projectId, read)
        try {
          const outcome = await read
          lastFullRead = Date.now()
          if (alive) {
            if (outcome.compiled) touches.set(projectId, outcome.roots, outcome.compiled)
            else touches.drop(projectId)
            const signature = JSON.stringify(outcome.result)
            const last = lastSeen.get(projectId)
            if (last !== undefined && signature !== last) platform.broadcast(IPC.systemMapChanged(projectId), projectId)
            lastSeen.set(projectId, signature)
          }
        } catch {
          /* a transient failure keeps the last signature; the next tick retries */
        } finally {
          if (polling.get(projectId) === read) polling.delete(projectId)
        }
      }
      if (!alive) return
      let remote = false
      try {
        remote = router.route(projectId).kind === 'remote'
      } catch {
        /* the next read reports the failure to whoever asks */
      }
      timer = setTimeout(() => void tick(), remote ? SHIP_POLL_REMOTE_MS : SHIP_POLL_LOCAL_MS)
      timer.unref?.()
    }
    void tick()
    return end
  }

  platform.on(IPC.systemMapSubscribe, (projectId: unknown, leaseId: unknown) => {
    if (typeof projectId !== 'string' || !projectId || typeof leaseId !== 'string' || !leaseId) return
    const existing = subs.get(projectId)
    if (existing) {
      existing.leases.set(leaseId, Date.now() + SHIP_LEASE_MS)
      return
    }
    const sub: Sub = { leases: new Map([[leaseId, Date.now() + SHIP_LEASE_MS]]), stop: () => {} }
    subs.set(projectId, sub)
    sub.stop = start(projectId, sub)
  })

  platform.on(IPC.systemMapUnsubscribe, (projectId: unknown, leaseId: unknown) => {
    if (typeof projectId !== 'string' || typeof leaseId !== 'string') return
    const existing = subs.get(projectId)
    if (!existing) return
    existing.leases.delete(leaseId)
    if (existing.leases.size === 0) {
      existing.stop()
      subs.delete(projectId)
    }
  })
}
