import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { errorText } from '../../shared/error-text'
import { IPC } from '../../shared/ipc'
import {
  SHIP_GRAPH_EXAMPLE,
  SHIP_LEASE_MS,
  type ShipConfigResult,
  type ShipGraphCreateResult,
  type ShipMachine,
  type ShipScope
} from '../../shared/ship-config'
import { posixQuote, quoteRemotePath } from '../../shared/ssh'
import type { CorePlatform } from '../platform'
import {
  buildShipConfig,
  newShipScriptNonce,
  parseRemoteShipOutput,
  readLocalShipInput,
  remoteShipScript
} from './discover'

/** Where one project's agents run, resolved per call by the shell. */
export type ShipConfigRoute =
  /** `cwd` null = a canvas with no folder: this machine's global config, and no project half. */
  | { kind: 'local'; cwd: string | null }
  /** `runScript` feeds a POSIX sh script to the host (`sh -s` over the project's ControlMaster). */
  | { kind: 'remote'; remoteCwd: string; host: string; runScript: (script: string) => Promise<{ code: number; stdout: string }> }
  | { kind: 'unsupported'; reason: string }

export interface ShipConfigRouter {
  route(projectId: string): ShipConfigRoute
}

/** How often a subscribed view re-reads. Polled rather than `fs.watch`ed because an agent file is
 *  usually a SYMLINK: a watch on the folder never fires for an edit of the link's target, and a watch
 *  on a target would have to follow every link and re-arm when one moves. */
export const SHIP_POLL_LOCAL_MS = 5_000
export const SHIP_POLL_REMOTE_MS = 20_000

const GRAPH_FILE = 'ship-graph.json'
const EXAMPLE_TEXT = `${JSON.stringify(SHIP_GRAPH_EXAMPLE, null, 2)}\n`

function localGlobalDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
}

export async function readShipConfig(projectId: unknown, router: ShipConfigRouter): Promise<ShipConfigResult> {
  if (typeof projectId !== 'string' || !projectId) return { ok: false, reason: 'No project.' }
  let route: ShipConfigRoute
  try {
    route = router.route(projectId)
  } catch (err) {
    return { ok: false, reason: errorText(err) }
  }
  if (route.kind === 'unsupported') return { ok: false, reason: route.reason }
  if (route.kind === 'local') {
    const globalDir = localGlobalDir()
    const machine: ShipMachine = { kind: 'local', label: '' }
    const input = await readLocalShipInput(globalDir, route.cwd)
    return {
      ok: true,
      config: buildShipConfig(input, {
        machine,
        globalGraphPath: path.join(globalDir, GRAPH_FILE),
        projectGraphPath: route.cwd ? path.join(route.cwd, '.claude', GRAPH_FILE) : null
      })
    }
  }
  const nonce = newShipScriptNonce()
  let result: { code: number; stdout: string }
  try {
    result = await route.runScript(remoteShipScript(nonce, route.remoteCwd))
  } catch (err) {
    return { ok: false, reason: `Could not read the host's agents: ${errorText(err)}` }
  }
  const parsed = parseRemoteShipOutput(nonce, result.stdout, true)
  if (!parsed.complete) {
    return { ok: false, reason: `Could not read the host's agents (ssh exited ${result.code}).` }
  }
  return {
    ok: true,
    config: buildShipConfig(parsed.input, {
      machine: { kind: 'ssh', label: route.host },
      globalGraphPath: `${parsed.globalDir ?? '~/.claude'}/${GRAPH_FILE}`,
      projectGraphPath: `${route.remoteCwd.replace(/\/+$/, '')}/.claude/${GRAPH_FILE}`
    })
  }
}

/** Write the example, only if nothing is there. An example never replaces anything a person wrote. */
export async function createShipGraph(
  projectId: unknown,
  scope: unknown,
  router: ShipConfigRouter
): Promise<ShipGraphCreateResult> {
  const unsupported = (message: string): ShipGraphCreateResult => ({ ok: false, reason: 'unsupported', message })
  if (typeof projectId !== 'string' || !projectId) return unsupported('No project.')
  if (scope !== 'project' && scope !== 'global') return unsupported('Unknown location.')
  const where = scope as ShipScope
  let route: ShipConfigRoute
  try {
    route = router.route(projectId)
  } catch (err) {
    return unsupported(errorText(err))
  }
  if (route.kind === 'unsupported') return unsupported(route.reason)
  if (route.kind === 'local') {
    if (where === 'project' && !route.cwd) return unsupported('This canvas has no project folder.')
    const dir = where === 'project' ? path.join(route.cwd!, '.claude') : localGlobalDir()
    const file = path.join(dir, GRAPH_FILE)
    try {
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.writeFile(file, EXAMPLE_TEXT, { flag: 'wx' })
      return { ok: true, path: file }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, reason: 'exists', message: `${file} already exists.` }
      }
      return { ok: false, reason: 'failed', message: errorText(err) }
    }
  }
  const dir = where === 'project' ? `${quoteRemotePath(route.remoteCwd)}/.claude` : '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"'
  const nonce = newShipScriptNonce()
  // The whole script is one function, called on its last line: it arrives over the ssh channel, and a
  // cut-off script must run NOTHING. Run line by line, a cut mid-line is a different command (`mkdir -`,
  // and `ln "$t"` with one argument links into wherever the shell is). A cut function is a syntax error.
  // Never a bare `cat >` (remote-write.guard.test.ts): the body goes into a temp of ours, its size is
  // checked, and `ln` publishes it, failing on an existing file as `wx` does and a rename would not.
  // The script reports the path it used, because the host's shell resolves `~` and CLAUDE_CONFIG_DIR,
  // and success is its done marker, because exit 0 alone can be a shell that read nothing.
  const bytes = Buffer.byteLength(EXAMPLE_TEXT, 'utf8')
  const script =
    `nt_create_ship_graph() {\n` +
    `dir=${dir}\nf="$dir/${GRAPH_FILE}"\nprintf '\\n${nonce} path %s\\n' "$f"\n` +
    `if [ -e "$f" ] || [ -L "$f" ]; then exit 17; fi\nmkdir -p "$dir" || exit 1\n` +
    `t="$dir/.nodeterm-${nonce}.tmp"\ntrap 'rm -f "$t"' EXIT\n` +
    `printf '%s' ${posixQuote(EXAMPLE_TEXT)} > "$t" || exit 1\n` +
    `[ $(wc -c < "$t") -eq ${bytes} ] || exit 1\n` +
    `if ln "$t" "$f" 2>/dev/null; then printf '\\n${nonce} done\\n'; exit 0; fi\n` +
    `[ -e "$f" ] && exit 17\nexit 1\n}\nnt_create_ship_graph\n`
  try {
    const { code, stdout } = await route.runScript(script)
    const written = new RegExp(`${nonce} path (.+)`).exec(stdout)?.[1]
    const shown = written ?? `${where === 'project' ? route.remoteCwd : '~/.claude'}/${GRAPH_FILE}`
    if (code === 0 && stdout.includes(`${nonce} done`)) return { ok: true, path: shown }
    if (code === 17) return { ok: false, reason: 'exists', message: `${shown} already exists.` }
    return { ok: false, reason: 'failed', message: `Could not write ${shown} (ssh exited ${code}).` }
  } catch (err) {
    return { ok: false, reason: 'failed', message: errorText(err) }
  }
}

/**
 * Registered once per shell. While a view holds a lease, this re-reads the machine and pushes only on a
 * real change.
 *
 * LEASES, not a ref count, because a renderer that crashes or reloads and a relay peer that drops send
 * no unsubscribe, and a count they never decrement would re-read the config, or spawn `ssh sh -s`, until
 * the app quits. A view renews its lease (`holdShipConfigLease`); a dead one simply stops.
 *
 * ROUTED ON EVERY TICK, because the answer changes: a persisted graph view can open an SSH project
 * before its master connects, and must not keep the local cadence once reads go over ssh.
 *
 * ONE POLL READ PER PROJECT AT A TIME. The next read is scheduled after this one ends, and a view closed
 * and reopened on a slow host waits for the read already out rather than starting another. A stopped
 * poll's answer is dropped. A view's own one-shot read (`shipConfigRead`) is separate from this.
 */
export function registerShipConfigHandlers(platform: CorePlatform, router: ShipConfigRouter): void {
  platform.handle(IPC.shipConfigRead, (projectId: unknown) => readShipConfig(projectId, router))
  platform.handle(IPC.shipGraphCreate, (projectId: unknown, scope: unknown) => createShipGraph(projectId, scope, router))

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
    const end = (): void => {
      alive = false
      clearTimeout(timer)
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
      const read = readShipConfig(projectId, router)
      polling.set(projectId, read)
      try {
        const signature = JSON.stringify(await read)
        if (alive) {
          const last = lastSeen.get(projectId)
          if (last !== undefined && signature !== last) platform.broadcast(IPC.shipConfigChanged(projectId), projectId)
          lastSeen.set(projectId, signature)
        }
      } catch {
        /* a transient failure keeps the last signature; the next tick retries */
      } finally {
        if (polling.get(projectId) === read) polling.delete(projectId)
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

  platform.on(IPC.shipConfigSubscribe, (projectId: unknown, leaseId: unknown) => {
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

  platform.on(IPC.shipConfigUnsubscribe, (projectId: unknown, leaseId: unknown) => {
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
