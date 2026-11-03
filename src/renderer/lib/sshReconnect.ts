/**
 * Auto-reconnect coordinator for SSH-project terminals whose ssh client died with a CONNECTION
 * failure (exit 255 — sleep/wake, network change, NAT idle drop). The remote tmux sessions
 * survive such drops, so all that's needed is to re-establish the project's ControlMaster and
 * respawn the dead nodes (`new-session -A` reattaches).
 *
 * Pure timer/state logic — Canvas injects `connect` (re-establish the master) and `respawn`
 * (bump the nodes' respawnNonce). TerminalNode feeds drops in via Canvas's setSshDropHandler
 * bridge; Canvas forwards every 'connected' status event to onConnected so an EXTERNAL
 * reconnect (the active-project effect on a tab switch) also flushes pending nodes.
 */

/** Backoff schedule between connect attempts; ~30s total, then the loop gives up. A later
 *  `onConnected` (tab-switch reconnect) still flushes whatever is pending. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]

/** A re-drop within this window of a node's respawn is refused: if the respawned ssh dies
 *  instantly the spawn itself is broken (bad key, revoked host, …) and reconnecting again
 *  would hot-loop connect→respawn→die forever. */
export const RESPAWN_REFUSE_MS = 10_000

interface ProjectLoop {
  /** Nodes waiting for a respawn once the master is back. */
  pending: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  /** Index into RECONNECT_DELAYS_MS for the NEXT attempt; delays.length ⇒ gave up. */
  attempt: number
  /** The project may not be dialed right now: the nodes wait, and nothing is scheduled. */
  held?: boolean
  /** These nodes died because the project closed, not because a spawn is broken, so their respawn
   *  does not start the refuse window: a late exit from that close must still be reported. */
  fromClose?: boolean
}

export interface SshReconnectorDeps {
  /** Re-establish the project's ControlMaster. Resolve true on success. */
  connect: (projectId: string) => Promise<boolean>
  /** Respawn the given (dead) terminal nodes of the project. */
  respawn: (projectId: string, nodeIds: string[]) => void
  /** May this project be dialed at all right now? Asked at every step that would lead to a dial,
   *  because the answer can change while a backoff is waiting. Absent = yes. */
  mayDial?: (projectId: string) => boolean
  /** Call back when `mayDial` may have changed, so held nodes can resume. Returns the unsubscribe. */
  onMayDialChange?: (changed: () => void) => () => void
  /** Can this project's terminals still be on the canvas? No means a held node is already gone, and
   *  reopening mounts it fresh, so a respawn would only kill a terminal that just attached. Absent = yes. */
  nodesMayBeMounted?: (projectId: string) => boolean
}

export class SshReconnector {
  private readonly deps: SshReconnectorDeps
  private readonly loops = new Map<string, ProjectLoop>()
  private readonly lastRespawn = new Map<string, { at: number; projectId: string }>()
  private disposed = false
  private readonly unsubscribe: (() => void) | undefined

  constructor(deps: SshReconnectorDeps) {
    this.deps = deps
    this.unsubscribe = deps.onMayDialChange?.(() => {
      this.dropUnmountedHolds()
      this.resumeHeld()
    })
  }

  /** A remote terminal's ssh died with exit 255: queue it and (re)start the project's loop. */
  reportDrop(projectId: string, nodeId: string): void {
    if (this.disposed) return
    // Remembered, never dialed. The terminal is dead and may stay mounted (closing the last tab leaves
    // its nodes on the canvas), so without this nothing would ever bring it back. Ahead of the refuse
    // window, because that window is about broken spawns and this death is the close's own.
    if (!this.mayDial(projectId)) {
      if (this.nodesMayBeMounted(projectId)) this.hold(projectId).pending.add(nodeId)
      return
    }
    const respawnedAt = this.lastRespawn.get(nodeId)
    if (respawnedAt !== undefined && Date.now() - respawnedAt.at < RESPAWN_REFUSE_MS) return
    let loop = this.loops.get(projectId)
    if (!loop) {
      loop = { pending: new Set(), timer: null, attempt: 0 }
      this.loops.set(projectId, loop)
    }
    loop.pending.add(nodeId)
    // Only kick the loop when idle AND not exhausted: an exhausted loop stays parked until
    // onConnected; a running one will pick this node up on its own flush.
    if (loop.timer === null && loop.attempt < RECONNECT_DELAYS_MS.length) this.schedule(projectId, loop)
  }

  /**
   * The user asked for it (the connection banner's Reconnect, or an offline node's own button):
   * try NOW, whatever the backoff was doing.
   *
   * Three things separate this from `reportDrop`: it skips the first delay (a person is watching),
   * it resets an EXHAUSTED loop's attempt counter (giving up is for the automatic loop, not for
   * an explicit ask), and it clears the respawn-refuse window for the named nodes — that window
   * exists to stop a broken spawn from hot-looping by itself, and a click is not a hot loop.
   */
  retryNow(projectId: string, nodeIds: string[] = []): void {
    if (this.disposed) return
    let loop = this.loops.get(projectId)
    if (!loop) {
      loop = { pending: new Set(), timer: null, attempt: 0 }
      this.loops.set(projectId, loop)
    }
    for (const id of nodeIds) {
      loop.pending.add(id)
      this.lastRespawn.delete(id)
    }
    if (loop.timer !== null) {
      clearTimeout(loop.timer)
      loop.timer = null
    }
    loop.attempt = 0
    void this.tryConnect(projectId, loop)
  }

  /** The project's master is (re)connected — by our loop or anyone else's. Flush pending nodes. */
  onConnected(projectId: string): void {
    if (this.disposed) return
    const loop = this.loops.get(projectId)
    if (!loop) return
    // A connect that landed after its project closed: nothing is up, so the nodes keep waiting.
    if (!this.mayDial(projectId)) return
    if (loop.timer !== null) clearTimeout(loop.timer)
    this.loops.delete(projectId)
    this.flush(projectId, loop)
  }

  /** Stop dialing this project: a pending backoff is cancelled. Its queued nodes are kept, because
   *  they still need a respawn when the project is back. Its refuse windows end here: this close is
   *  about to kill those terminals, and that exit says nothing about a broken spawn. Refused, it would
   *  strand a terminal when it lands just after a quick reopen. */
  forget(projectId: string): void {
    for (const [nodeId, r] of this.lastRespawn) if (r.projectId === projectId) this.lastRespawn.delete(nodeId)
    if (this.loops.has(projectId)) this.hold(projectId)
  }

  private hold(projectId: string): ProjectLoop {
    let loop = this.loops.get(projectId)
    if (!loop) {
      loop = { pending: new Set(), timer: null, attempt: 0 }
      this.loops.set(projectId, loop)
    }
    if (loop.timer !== null) clearTimeout(loop.timer)
    loop.timer = null
    loop.attempt = 0
    loop.held = true
    loop.fromClose = true
    return loop
  }

  /** A held project whose terminals have left the canvas has nothing left to respawn. */
  private dropUnmountedHolds(): void {
    if (this.disposed) return
    for (const [projectId, loop] of this.loops) {
      if (loop.held && !this.nodesMayBeMounted(projectId)) this.loops.delete(projectId)
    }
  }

  private nodesMayBeMounted(projectId: string): boolean {
    return this.deps.nodesMayBeMounted ? this.deps.nodesMayBeMounted(projectId) : true
  }

  /** Projects that may be dialed again go back to the ordinary loop. On a timer rather than at once,
   *  and not only from `onConnected`: a connect that reuses a live master reports no status at all. */
  private resumeHeld(): void {
    if (this.disposed) return
    for (const [projectId, loop] of this.loops) {
      if (!loop.held || !this.mayDial(projectId)) continue
      loop.held = false
      if (loop.pending.size === 0) this.loops.delete(projectId)
      else this.schedule(projectId, loop)
    }
  }

  private mayDial(projectId: string): boolean {
    return this.deps.mayDial ? this.deps.mayDial(projectId) : true
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe?.()
    for (const loop of this.loops.values()) {
      if (loop.timer !== null) clearTimeout(loop.timer)
    }
    this.loops.clear()
  }

  private schedule(projectId: string, loop: ProjectLoop): void {
    loop.timer = setTimeout(() => {
      loop.timer = null
      void this.tryConnect(projectId, loop)
    }, RECONNECT_DELAYS_MS[loop.attempt])
    loop.attempt++
  }

  private async tryConnect(projectId: string, loop: ProjectLoop): Promise<void> {
    if (!this.mayDial(projectId)) {
      if (this.loops.get(projectId) === loop) this.hold(projectId)
      return
    }
    let ok = false
    try {
      ok = await this.deps.connect(projectId)
    } catch {
      ok = false
    }
    if (this.disposed) return
    // onConnected may have flushed (and deleted) the loop while connect was in flight.
    if (this.loops.get(projectId) !== loop) return
    // Closed while that was in flight: the nodes wait for the reopen, with no retry scheduled.
    if (loop.held) return
    if (ok) {
      this.loops.delete(projectId)
      this.flush(projectId, loop)
    } else if (loop.attempt < RECONNECT_DELAYS_MS.length) {
      this.schedule(projectId, loop)
    }
    // else: exhausted — keep the loop parked with its pending set so onConnected can flush it.
  }

  private flush(projectId: string, loop: ProjectLoop): void {
    if (loop.pending.size === 0) return
    const nodeIds = [...loop.pending]
    const now = Date.now()
    for (const id of nodeIds) {
      if (loop.fromClose) this.lastRespawn.delete(id)
      else this.lastRespawn.set(id, { at: now, projectId })
    }
    this.deps.respawn(projectId, nodeIds)
  }
}
