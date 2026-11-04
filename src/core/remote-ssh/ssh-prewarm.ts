// Dial the ControlMasters of OPEN SSH projects shortly after boot, so the first switch to one is
// already warm.
//
// WHY (measured, 2026-09-15, real sshd behind a 25 ms one-way delay proxy = 50 ms RTT). A project's
// master is established only when the user first switches to it, so the first visit of every app
// run pays the cold establish (TCP + KEX + auth until `-O check` answers: 0.44 s) and then the
// connect's remote setup chain (~23 serialized ssh exec children: 3.54 s) before a single terminal
// can attach. Both are wall-clock the user spends looking at blank panes. Neither depends on the
// user having switched — so do them while nobody is waiting.
//
// Three properties this planner exists to guarantee, all of them things that were easy to get
// wrong by hand:
//  - CLOSED projects are never dialed. `closeProject` is non-destructive and deliberately leaves
//    the host's sessions running; a closed tab is the user saying "not now", and waking an SSH
//    login (and possibly a passphrase prompt) for it is worse than a slow first switch.
//  - A project that is already connected, or already being connected, is never re-dialed. The
//    pre-warm must never be the thing that competes with the user's own connect.
//  - One host at a time. Bursting every master at once is the failure mode the `SshChildGate`
//    exists for, one level up: the gate caps exec children PER control path, so N simultaneous
//    fresh masters to N hosts are N independent budgets and nothing paces the logins themselves.

import type { SshConnection } from '../../shared/ssh'
import { isWslHost } from '../../shared/wsl-project'

/** One project to pre-warm: everything `SshProjectManager.prewarm` needs, and nothing else. */
export interface SshPrewarmTarget {
  projectId: string
  conn: SshConnection
  remoteCwd?: string
}

/** The shape this reads off the workspace index. Structural on purpose — `Project` carries far
 *  more than a pre-warm may look at, and narrowing it here keeps the planner a pure unit. */
export interface SshPrewarmCandidate {
  id: string
  closed?: boolean
  ssh?: { server: SshConnection; remoteCwd: string }
}

export interface SshPrewarmPlanInput {
  projects: readonly SshPrewarmCandidate[]
  /** Is this project's master already up, or already being established? Re-asked at FIRE time too
   *  (see `runSshPrewarm`), because a plan made at boot is stale the moment the user switches. */
  busy: (projectId: string) => boolean
}

/** The ordered list of projects worth pre-warming. Order is the index's own (the tab order). */
export function planSshPrewarm(input: SshPrewarmPlanInput): SshPrewarmTarget[] {
  const out: SshPrewarmTarget[] = []
  for (const p of input.projects) {
    if (!p.ssh || p.closed) continue
    // Dialing one boots the distro, and a stuck distro can hang for minutes. Starting it is the
    // user's choice, made when they switch to the project.
    if (isWslHost(p.ssh.server.host)) continue
    if (input.busy(p.id)) continue
    // A project can appear twice in a malformed index; one master per id is all there is.
    if (out.some((t) => t.projectId === p.id)) continue
    out.push({ projectId: p.id, conn: p.ssh.server, remoteCwd: p.ssh.remoteCwd })
  }
  return out
}

export interface SshPrewarmRunDeps {
  /** Establish one master, silently. Must never reject (the manager's `prewarm` swallows). */
  connect: (target: SshPrewarmTarget) => Promise<void>
  /** Re-asked immediately before each dial: the user may have opened this project meanwhile. */
  busy: (projectId: string) => boolean
  /** Gap between hosts. Sequential dialing is the point; this only spaces them out further. */
  delay: (ms: number) => Promise<void>
  gapMs: number
  /** Abort the remaining queue (app quitting). */
  stopped?: () => boolean
}

/**
 * Dial the planned masters one at a time, re-checking each one at fire time.
 *
 * Sequential, never a `Promise.all`: each dial is a full TCP + KEX + auth login, and a burst of
 * them is exactly what trips a host's `MaxStartups` — the failure that reads to the user as a
 * dropped terminal and the reconnect backoff. Nothing here is awaited by any user-facing path.
 *
 * Returns how many dials were actually attempted, for tests and diagnostics.
 */
export async function runSshPrewarm(
  targets: readonly SshPrewarmTarget[],
  deps: SshPrewarmRunDeps
): Promise<number> {
  let attempted = 0
  for (let i = 0; i < targets.length; i++) {
    if (deps.stopped?.()) break
    const target = targets[i]
    // Fire-time re-ask: the plan was made seconds (and one user switch) ago.
    if (deps.busy(target.projectId)) continue
    attempted++
    try {
      await deps.connect(target)
    } catch {
      // A pre-warm failure is not a user-facing event. The project's own connect, on the switch
      // that actually opens it, reports its own error with its own ssh cause.
    }
    if (i < targets.length - 1 && deps.gapMs > 0) await deps.delay(deps.gapMs)
  }
  return attempted
}
