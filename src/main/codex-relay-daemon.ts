/* A single tiny, detached WebSocket relay shared by every local Codex node. It keeps the TUI
 * connected across Electron restarts while observing thread/resume on that node's own connection.
 * The authenticated Codex app-server remains shared per account; this is only a routing shim.
 *
 * Adapted from @Corvin's `src/main/codex-relay-daemon.ts` in external PR #112 (S6 PR 4 slice). The
 * one deliberate divergence from the reference: cross-account rollout exposure does NOT re-implement
 * `linkSync` here — it calls PR 3's atomic, never-overwrite primitive
 * (`planCodexRolloutExposure`/`commitCodexRolloutExposure` in `src/core/codex-accounts-core.ts`) and
 * then VERIFIES the target app-server can discover the copy before the caller recycles the node,
 * rolling the published link back if it cannot (§4.2 step 4 / §6). Ships inert: no node connects
 * until PR 5/6 wire it live.
 *
 * ── Task 4.0 probe results (Codex CLI 0.146.0, `/usr/bin/codex`, npm-managed; recorded in full in
 *    docs/superpowers/probes/2026-08-codex-relay-daemon.md) ──
 *  U4  PARTIAL/VERIFIED. `codex app-server daemon start|stop|version` honours `CODEX_HOME` (creates
 *      `<CODEX_HOME>/app-server-daemon/`; `version` JSON reports
 *      `socketPath=<CODEX_HOME>/app-server-control/app-server-control.sock`). The `SUN_LEN` limit is
 *      REAL — a long `CODEX_HOME` makes the socket connect fail "path must be shorter than SUN_LEN",
 *      which is exactly why the managed home digest is short. `--remote <ADDR>` and
 *      `--remote-auth-token-env <ENV_VAR>` exist on the global/`resume`/`fork` commands (token by env
 *      var name, never on argv — GC 6). NOT runnable headless: `daemon start` binding a live socket,
 *      and the `account/read`→{email} / `thread/read`→{path,cwd} RPC shapes, need the curl-managed
 *      standalone install (`<CODEX_HOME>/packages/standalone/current/codex`) absent here — owed
 *      device-verification.
 *  U1  UNVERIFIED headless (no standalone daemon). Does a RUNNING app-server surface a freshly
 *      hardlinked rollout on `thread/read` WITHOUT a reindex? Cannot measure without the managed
 *      install. The design does NOT rest on the optimistic answer: `exposeForeignThread` re-reads the
 *      TARGET socket after linking (`thread-check`) and rolls the link back if the far side does not
 *      report the thread — so a false U1 degrades to a refused copy, never a silent one. Owed
 *      device-verification; not blocking.
 *  U2  UNVERIFIED headless (needs auth + a second login + a running daemon). Does the conversation id
 *      survive copy+switch? Safety net if not: hardlinked inode + resume-by-path (history deleted,
 *      precedence history > path > id) and the `-32004` guard — `resolveRelayThreadResponse` flags a
 *      changed id and the reply is rewritten to `-32004`, refusing the silent fork. Owed
 *      device-verification; not blocking.
 *  U6  Local self-spawn VERIFIED runnable: the `process.argv[2]` dispatch (serve/register/
 *      account-read/thread-check/expose-thread) runs under plain `node` (proven by a child-process
 *      test that self-spawns `serve` and completes a `/register` round-trip). In Electron main
 *      `process.execPath` is the Electron binary; `ELECTRON_RUN_AS_NODE=1` runs it as Node. The
 *      remote leg (uploaded `codex-relay.js` via `nodeterm-codex`) needs a live SSH host — owed. */
import { createHash, randomUUID, timingSafeEqual } from 'crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { renameAtomicSync, tempNameFor } from '../core/fs-atomic'
import { createServer, request } from 'http'
import { homedir } from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { WebSocket, WebSocketServer } from 'ws'
import {
  commitCodexRolloutExposure,
  isSafeAccountId,
  planCodexRolloutExposure
} from '../core/codex-accounts-core'
import { parseEndpointEnv } from '../core/agents/hook-endpoint-parse'

// Protocol v6 adds a node-scoped capability to every Electron identity request. It also merges
// account-isolated catalogs and resumes a selected foreign rollout by path in
// the chosen account. Codex preserves the rollout's thread id; switching login never forks history.
// Keep earlier versions on their own state files so already-connected nodes may drain safely.
const VERSION = '6'
const SAFE = /^[A-Za-z0-9._-]+$/
const SAFE_NODE_TOKEN = /^[A-Za-z0-9_-]{43}$/
const SAFE_ENDPOINT = /^\/[A-Za-z0-9._/ -]+$/
const INVALID_OWNER = '__invalid__'
const root = path.join(homedir(), '.nodeterm')
const statePath = path.join(root, `codex-relay-v${VERSION}.json`)

type State = { version: string; pid: number; port: number; token: string }
type Route = {
  nodeId: string
  nodeToken: string
  accountId?: string
  socketPath: string
  hookEndpoint: string
}
export type RelayForeignThread = {
  socketPath: string
  path: string
  cwd: string
  name?: string
}
export type RelayThreadLocation =
  | { kind: 'native' }
  | { kind: 'foreign'; thread: RelayForeignThread }
  | { kind: 'ambiguous' }
  | { kind: 'unavailable' }
type RegisteredRoute = {
  route: Route
  timer: NodeJS.Timeout
  active: number
}

export type RelayThreadRequest = {
  method: string
  source?: string
  sourceName?: string
}
export type RelayThreadResponse =
  | { ok: true; threadId: string; source?: string; name?: string }
  | { ok: false; unexpectedThreadId?: string }

/** Per-connection JSON-RPC tracking. Equal request ids in parallel node connections remain
 * isolated because every connection supplies its own map. */
export function trackRelayThreadRequest(
  pending: Map<string, RelayThreadRequest>,
  message: unknown,
  sourceName?: string
): void {
  const m = message as {
    id?: unknown
    method?: unknown
    params?: { threadId?: unknown }
  }
  if (
    m?.id === undefined ||
    typeof m.method !== 'string' ||
    !/^thread\/(?:resume|start|fork)$/.test(m.method)
  )
    return
  pending.set(String(m.id), {
    method: m.method,
    source: typeof m.params?.threadId === 'string' ? m.params.threadId : undefined,
    sourceName
  })
}

export function resolveRelayThreadResponse(
  pending: Map<string, RelayThreadRequest>,
  message: unknown
): RelayThreadResponse | undefined {
  const m = message as {
    id?: unknown
    error?: unknown
    result?: { thread?: { id?: unknown; name?: unknown } }
  }
  if (m?.id === undefined) return undefined
  const tracked = pending.get(String(m.id))
  if (!tracked) return undefined
  pending.delete(String(m.id))
  if (m.error) return undefined
  const threadId = m.result?.thread?.id
  if (typeof threadId !== 'string' || !SAFE.test(threadId)) return { ok: false }
  if (tracked.method === 'thread/resume' && tracked.source && threadId !== tracked.source) {
    return { ok: false, unexpectedThreadId: threadId }
  }
  const rawName = typeof m.result?.thread?.name === 'string' ? m.result.thread.name.trim() : ''
  return {
    ok: true,
    threadId,
    source: tracked.source,
    name: rawName || tracked.sourceName
  }
}

/**
 * The JSON-RPC error a rewritten relay response carries when the observation failed, or `null` when
 * it succeeded. Two DISTINCT failures reach `resolveRelayThreadResponse` as `{ ok: false }`, and
 * before this they were both rewritten to the SAME "Codex changed the conversation id" message:
 *  - `unexpectedThreadId` set — a `thread/resume` came back under a DIFFERENT id: the silent-fork
 *    case the `-32004` guard exists for (§4.2 step 5 / Property 5).
 *  - `unexpectedThreadId` UNSET — the response's thread id was missing or malformed: NOT an id
 *    change. Telling the operator "the id changed" here is wrong, so it gets a distinct internal
 *    error wording (carried PR-4 minor: tighten the -32004 wording).
 */
export function relayThreadResponseError(
  observed: RelayThreadResponse
): { code: number; message: string } | null {
  if (observed.ok) return null
  return observed.unexpectedThreadId !== undefined
    ? { code: -32004, message: 'Codex changed the conversation id during account switch' }
    : { code: -32603, message: 'Codex returned a malformed conversation id during account switch' }
}

type RelayThread = Record<string, any> & {
  id: string
  path?: string | null
  cwd: string
  name?: string | null
  createdAt?: number
  updatedAt?: number
  recencyAt?: number | null
}

export type RelayThreadReadOutcome =
  { kind: 'found'; thread: RelayThread } | { kind: 'absent' } | { kind: 'unavailable' }

type RelayThreadSource = { socketPath: string; threads: RelayThread[] }

type RelayCursor = {
  key: string
  direction: 1 | -1
  value: number
  id: string
}

function rolloutIdentity(rolloutPath: unknown): string | null {
  if (typeof rolloutPath !== 'string' || !path.isAbsolute(rolloutPath)) return null
  try {
    const stat = statSync(rolloutPath)
    return stat.isFile() ? `${stat.dev}:${stat.ino}` : null
  } catch {
    return null
  }
}

function decodeRelayCursor(cursor: unknown): RelayCursor | null {
  if (typeof cursor !== 'string' || !cursor.startsWith('nodeterm:')) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor.slice(9), 'base64url').toString()) as RelayCursor
    return typeof parsed.key === 'string' &&
      (parsed.direction === 1 || parsed.direction === -1) &&
      Number.isFinite(parsed.value) &&
      typeof parsed.id === 'string' &&
      SAFE.test(parsed.id)
      ? parsed
      : null
  } catch {
    return null
  }
}

function encodeRelayCursor(cursor: RelayCursor): string {
  return `nodeterm:${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`
}

/** Merge already server-filtered account pages without ever sharing their state databases. The
 * selected account wins an equal thread id. Foreign entries without an absolute rollout path are
 * omitted because they cannot be safely resumed in the selected account. */
export function mergeRelayThreadLists(
  sources: RelayThreadSource[],
  currentSocketPath: string,
  params: Record<string, any>
): {
  result: {
    data: RelayThread[]
    nextCursor: string | null
    backwardsCursor: string | null
  }
  foreignThreads: Map<string, RelayForeignThread>
} {
  const ordered = [...sources].sort((a, b) =>
    a.socketPath === currentSocketPath ? -1 : b.socketPath === currentSocketPath ? 1 : 0
  )
  const byId = new Map<string, { thread: RelayThread; socketPath: string } | null>()
  for (const source of ordered) {
    for (const thread of source.threads) {
      if (!thread || typeof thread.id !== 'string' || !SAFE.test(thread.id)) continue
      if (
        source.socketPath !== currentSocketPath &&
        (typeof thread.path !== 'string' || !path.isAbsolute(thread.path))
      )
        continue
      const existing = byId.get(thread.id)
      if (source.socketPath === currentSocketPath) {
        byId.set(thread.id, { thread, socketPath: source.socketPath })
        continue
      }
      if (existing === null || (existing && existing.socketPath !== currentSocketPath)) {
        const sameRollout =
          existing &&
          rolloutIdentity(existing.thread.path) !== null &&
          rolloutIdentity(existing.thread.path) === rolloutIdentity(thread.path)
        // Hardlinks in multiple account homes are one conversation. Different/unreadable inodes
        // remain ambiguous; never pick one by catalog order.
        if (!sameRollout) byId.set(thread.id, null)
        continue
      }
      if (existing) continue
      byId.set(thread.id, { thread, socketPath: source.socketPath })
    }
  }
  const sortKey =
    params.sortKey === 'updated_at'
      ? 'updatedAt'
      : params.sortKey === 'recency_at'
        ? 'recencyAt'
        : 'createdAt'
  const direction = params.sortDirection === 'asc' ? 1 : -1
  const valueOf = (thread: RelayThread): number =>
    Number(thread[sortKey] ?? thread.updatedAt ?? thread.createdAt ?? 0)
  const compare = (a: { thread: RelayThread }, b: { thread: RelayThread }): number => {
    const av = valueOf(a.thread)
    const bv = valueOf(b.thread)
    return av === bv ? a.thread.id.localeCompare(b.thread.id) : (av - bv) * direction
  }
  const all = [...byId.values()]
    .filter((entry): entry is { thread: RelayThread; socketPath: string } => entry !== null)
    .sort(compare)
  const cursor = decodeRelayCursor(params.cursor)
  let offset = 0
  if (cursor && cursor.key === sortKey && cursor.direction === direction) {
    offset = all.findIndex(
      (entry) =>
        compare(entry, {
          thread: { id: cursor.id, cwd: '', [sortKey]: cursor.value }
        }) > 0
    )
    if (offset < 0) offset = all.length
  }
  const requestedLimit = Number(params.limit)
  const limit =
    Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 1000) : 50
  const page = all.slice(offset, offset + limit)
  const foreignThreads = new Map<string, RelayForeignThread>()
  for (const { thread, socketPath } of page) {
    if (socketPath === currentSocketPath || typeof thread.path !== 'string') continue
    foreignThreads.set(thread.id, {
      socketPath,
      path: thread.path,
      cwd: thread.cwd,
      name: typeof thread.name === 'string' && thread.name.trim() ? thread.name.trim() : undefined
    })
  }
  const next = offset + page.length
  const last = page.at(-1)?.thread
  return {
    result: {
      data: page.map((entry) => entry.thread),
      nextCursor:
        next < all.length && last
          ? encodeRelayCursor({
              key: sortKey,
              direction,
              value: valueOf(last),
              id: last.id
            })
          : null,
      backwardsCursor: null
    },
    foreignThreads
  }
}

export function retargetRelayResumeByPath(
  message: Record<string, any>,
  threadId: string,
  sourcePath: string,
  cwd: string
): Record<string, any> {
  const params = { ...(message.params ?? {}), threadId, path: sourcePath, cwd }
  // Resume precedence is history > path > id. Remove picker-supplied history so Codex loads the
  // verified rollout path and preserves its existing thread identity under the selected login.
  delete params.history
  return { ...message, params }
}

export function relayThreadReservationKey(threadId: string): string {
  return `thread\0${threadId}`
}

/**
 * Claim a per-thread reservation SYNCHRONOUSLY — before any `await` — so two connections arriving
 * in the same event-loop turn can never both pass and open the same rollout in parallel (Property
 * 3 / Property 10). Returns false (already reserved) or true (this owner now holds it); on success
 * both maps are mutated in the same synchronous step, which is the whole point: the window between
 * "check" and "set" must not contain an await. `owner` is a per-connection `Symbol` so a release
 * only ever removes a reservation this exact connection still owns.
 */
export function tryReserveRelayThread(
  reservations: Map<string, symbol>,
  requestReservations: Map<string, string>,
  reservationKey: string,
  requestId: string,
  owner: symbol
): boolean {
  if (!requestId || !reservationKey) return false
  if (requestReservations.has(requestId) || reservations.has(reservationKey)) return false
  reservations.set(reservationKey, owner)
  requestReservations.set(requestId, reservationKey)
  return true
}

function readState(): State | null {
  try {
    const x = JSON.parse(readFileSync(statePath, 'utf8')) as State
    return x.version === VERSION && x.port > 0 && !!x.token ? x : null
  } catch {
    return null
  }
}

export function acquireProcessLock(lock: string): boolean {
  const attempt = (): boolean => {
    try {
      // mkdir is the ownership operation. Unlike create-then-write of a file, contenders can never
      // observe a newly-created empty lock and delete it before this process writes its pid.
      mkdirSync(lock, { mode: 0o700 })
      writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`, {
        mode: 0o600
      })
      return true
    } catch {
      return false
    }
  }
  if (attempt()) return true
  // Read the lock's type, mtime and (legacy-file) owner from ONE descriptor, and the directory
  // owner file from ONE open+read — never a `statSync(path)` followed by a `readFileSync(path)` on
  // the same path (that check-then-use is a real fs race; here the fd IS the check-and-use, one
  // inode). Same liveness semantics as before: a live pid holds the lock; a missing owner inside a
  // fresh directory is the post-mkdir/pre-write window and is left alone for a grace period.
  let owner = 0
  let directory = false
  let lockMtimeMs = 0
  let fd: number | undefined
  try {
    fd = openSync(lock, 'r')
    const stat = fstatSync(fd)
    directory = stat.isDirectory()
    lockMtimeMs = stat.mtimeMs
    if (!directory) owner = Number(readFileSync(fd, 'utf8').trim())
  } catch {
    /* the lock vanished after our attempt failed — nothing to reclaim */
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd)
      } catch {}
  }
  if (directory) {
    // The owner file is a child of the lock directory; read it in a single open+read (no prior
    // stat), so a missing owner surfaces as an open error, not a separate existence check.
    let ownerFd: number | undefined
    try {
      ownerFd = openSync(path.join(lock, 'owner'), 'r')
      owner = Number(readFileSync(ownerFd, 'utf8').trim())
    } catch {
      /* no owner file yet: the tiny post-mkdir/pre-write window */
    } finally {
      if (ownerFd !== undefined)
        try {
          closeSync(ownerFd)
        } catch {}
    }
  }
  if (owner > 0) {
    try {
      process.kill(owner, 0)
      return false
    } catch {}
  }
  if (directory && owner <= 0) {
    // A missing owner is the tiny post-mkdir/pre-write window of a live contender. Only reclaim it
    // after it has remained incomplete long enough that the creator demonstrably died. `lockMtimeMs`
    // came from the same `fstatSync` above — no extra stat, no new race.
    if (Date.now() - lockMtimeMs < 10_000) return false
  }
  try {
    if (directory) rmSync(lock, { recursive: true, force: true })
    else unlinkSync(lock)
  } catch {
    return false
  }
  return attempt()
}

function releaseProcessLock(lock: string): void {
  try {
    const owner = Number(readFileSync(path.join(lock, 'owner'), 'utf8').trim())
    if (owner === process.pid) rmSync(lock, { recursive: true, force: true })
  } catch {}
}

function authOk(raw: string | undefined, token: string): boolean {
  if (!raw?.startsWith('Bearer ')) return false
  const a = Buffer.from(raw.slice(7))
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function bearerToken(raw: string | undefined): string {
  return raw?.startsWith('Bearer ') ? raw.slice(7) : ''
}

export function relayControlPost(
  port: number,
  token: string,
  pathname: string,
  body: unknown
): Promise<string> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    // LOOPBACK-ONLY IPC, not an external request. The hostname is the hardcoded literal `127.0.0.1`
    // (never a variable, never a remote host); the only recipient is THIS machine's own relay daemon
    // on an ephemeral loopback port, gated by the per-process control token read from the relay's own
    // `0600` state file and compared with `timingSafeEqual` on the far side. No file content is
    // exfiltrated off-box: the "file data" a taint tracker sees is that local capability token
    // travelling to the local socket that minted it. See docs/superpowers/probes for the transport.
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data)
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () =>
          res.statusCode === 200
            ? resolve(Buffer.concat(chunks).toString())
            : reject(new Error('relay request failed'))
        )
      }
    )
    req.on('error', reject)
    req.setTimeout(1_000, () => req.destroy(new Error('relay request timed out')))
    req.end(data)
  })
}

/**
 * Create the `~/.nodeterm` relay root, mode `0o700`, idempotently. `serve()` already makes it, but
 * that runs in the DETACHED daemon child — a caller reaching for the relay from the app process
 * (the state file, the process lock, `ensureServer`) needs the directory to exist first. Only
 * `serve()` created it before S6 PR 5, so `ensureServer` / any first relay use in the app process
 * could race a missing root (carried PR-4 obligation). Exported so the main-side account wiring can
 * ensure it at boot too. `target` is injectable so a test never touches the real home.
 */
export function ensureCodexRelayRoot(target: string = root): void {
  mkdirSync(target, { recursive: true, mode: 0o700 })
}

async function ensureServer(): Promise<State> {
  // The root must exist before we read the state file or take the process lock — both live under it.
  ensureCodexRelayRoot()
  const current = readState()
  if (current) {
    try {
      await relayControlPost(current.port, current.token, '/ping', {})
      return current
    } catch {
      /* stale */
    }
  }
  const lock = `${statePath}.lock`
  const ownsLock = acquireProcessLock(lock)
  if (ownsLock) {
    const child = spawn(process.execPath, [__filename, 'serve'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    child.unref()
  }
  try {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 50))
      const state = readState()
      if (state) {
        try {
          await relayControlPost(state.port, state.token, '/ping', {})
          return state
        } catch {}
      }
    }
    throw new Error('DisTerm Codex relay unavailable')
  } finally {
    if (ownsLock) {
      releaseProcessLock(lock)
    }
  }
}

function scope(accountId?: string): string {
  return accountId || 'system'
}
function identityFile(threadId: string, accountId?: string): string {
  return path.join(root, 'codex-thread-nodes', scope(accountId), threadId)
}
function nameFile(socketPath: string, threadId: string): string {
  const socketScope = createHash('sha256').update(socketPath).digest('hex').slice(0, 16)
  return path.join(root, 'codex-thread-names', socketScope, threadId)
}
function parseOwner(file: string, expectedScope?: string): string {
  try {
    const raw = readFileSync(file, 'utf8')
    const accountId = /^accountId=(.*)$/m.exec(raw)?.[1]
    const nodeId = /^nodeId=(.*)$/m.exec(raw)?.[1] ?? ''
    const endpoint = /^endpoint=(.*)$/m.exec(raw)?.[1] ?? ''
    if (
      (expectedScope ? accountId !== expectedScope : !!accountId) ||
      !SAFE.test(nodeId) ||
      !SAFE_ENDPOINT.test(endpoint)
    )
      return INVALID_OWNER
    return nodeId
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? '' : INVALID_OWNER
  }
}
function conflictingOwner(threadId: string): string {
  if (!SAFE.test(threadId)) return ''
  const mappings = path.join(root, 'codex-thread-nodes')
  const owners = new Set<string>()
  const legacyOwner = parseOwner(path.join(mappings, threadId))
  if (legacyOwner) owners.add(legacyOwner)
  try {
    for (const entry of readdirSync(mappings, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE.test(entry.name)) continue
      const owner = parseOwner(path.join(mappings, entry.name, threadId), entry.name)
      if (owner) owners.add(owner)
    }
  } catch {
    owners.add(INVALID_OWNER)
  }
  if (owners.size === 0) return ''
  if (owners.size === 1) return owners.values().next().value ?? ''
  return '__ambiguous__'
}
function persistName(route: Route, threadId: string, name?: string): void {
  if (!name?.trim()) return
  const nf = nameFile(route.socketPath, threadId)
  mkdirSync(path.dirname(nf), { recursive: true, mode: 0o700 })
  writeFileSync(nf, name.trim().slice(0, 500), { mode: 0o600 })
}

async function bind(route: Route, threadId: string, name?: string): Promise<boolean> {
  if (!SAFE.test(threadId) || !SAFE.test(route.nodeId)) return false
  const file = identityFile(threadId, route.accountId)
  const existingOwner = parseOwner(file, scope(route.accountId))
  // Without Electron's live workspace we cannot distinguish a stale owner from a live one. Never
  // steal another node's thread in the detached fallback; the authenticated main handler may
  // rebind it after checking liveness.
  if (existingOwner && existingOwner !== route.nodeId) {
    persistName(route, threadId, name)
    // The reservation remains held until Electron has atomically checked liveness and committed
    // the replacement mapping. Without that acknowledgement, report failure to the TUI.
    return notifyElectron(route, threadId, name)
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = tempNameFor(file)
  const quarantined: Array<{ source: string; quarantine: string }> = []
  const mappings = path.join(root, 'codex-thread-nodes')
  try {
    writeFileSync(
      tmp,
      `accountId=${scope(route.accountId)}\nnodeId=${route.nodeId}\nendpoint=${route.hookEndpoint}\n`,
      {
        mode: 0o600
      }
    )
    for (const dir of readdirSync(mappings, { withFileTypes: true })) {
      const files: Array<{ file: string; scope?: string }> =
        dir.isDirectory() && SAFE.test(dir.name)
          ? readdirSync(path.join(mappings, dir.name)).map((n) => ({
              file: path.join(mappings, dir.name, n),
              scope: dir.name
            }))
          : dir.isFile()
            ? [{ file: path.join(mappings, dir.name) }]
            : []
      for (const other of files) {
        if (
          other.file !== file &&
          other.file !== tmp &&
          (parseOwner(other.file, other.scope) === route.nodeId ||
            path.basename(other.file) === threadId)
        ) {
          const quarantine = `${other.file}.transfer-${process.pid}-${Date.now()}-${quarantined.length}`
          renameAtomicSync(other.file, quarantine)
          quarantined.push({ source: other.file, quarantine })
        }
      }
    }
    renameAtomicSync(tmp, file)
  } catch {
    for (const item of quarantined.reverse()) {
      try {
        renameAtomicSync(item.quarantine, item.source)
      } catch {}
    }
    try {
      unlinkSync(tmp)
    } catch {}
    return false
  }
  for (const item of quarantined) {
    try {
      unlinkSync(item.quarantine)
    } catch {}
  }
  try {
    persistName(route, threadId, name)
  } catch {}
  // Local atomic mapping is already the ownership commit. Await Electron for immediate title/status
  // refresh, but an app restart must not invalidate the durable mapping the relay just wrote.
  await notifyElectron(route, threadId, name)
  return true
}

function indexedName(socketPath: string, threadId?: string): string | undefined {
  if (!threadId || !SAFE.test(threadId)) return undefined
  const home = path.dirname(path.dirname(socketPath))
  try {
    let found: string | undefined
    for (const line of readFileSync(path.join(home, 'session_index.jsonl'), 'utf8').split('\n')) {
      if (!line.includes(threadId)) continue
      const x = JSON.parse(line) as { id?: string; thread_name?: string }
      if (x.id === threadId && x.thread_name?.trim()) found = x.thread_name.trim()
    }
    return found
  } catch {
    return undefined
  }
}

/**
 * Read + parse the local endpoint env file for `hookRequest`/`hookJsonRequest`. Values are
 * `posixQuote`d since #351, so this must go through the shared quote-aware parser — a naive
 * first-`=` split keeps the quotes, making the port NaN and the sock non-absolute, and every
 * authorize/observed/catalog call then dies "endpoint unavailable". Exported for tests.
 */
export function readHookEndpointEnv(file: string): Record<string, string> {
  return parseEndpointEnv(readFileSync(file, 'utf8'))
}

/** Exported for tests. */
export function hookEndpointOptions(
  env: Record<string, string>,
  pathname: string
): { socketPath: string; path: string } | { hostname: string; port: number; path: string } | null {
  if (env.NODETERM_HOOK_SOCK?.startsWith('/')) {
    return { socketPath: env.NODETERM_HOOK_SOCK, path: pathname }
  }
  const port = Number(env.NODETERM_HOOK_PORT)
  return port > 0 ? { hostname: '127.0.0.1', port, path: pathname } : null
}

function hookRequest(
  route: Route,
  pathname: string,
  fields: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    let env: Record<string, string>
    try {
      env = readHookEndpointEnv(route.hookEndpoint)
    } catch (error) {
      reject(error)
      return
    }
    const token = env.NODETERM_HOOK_TOKEN
    const endpoint = hookEndpointOptions(env, pathname)
    if (!endpoint || !token || !SAFE_NODE_TOKEN.test(route.nodeToken)) {
      reject(new Error('DisTerm hook endpoint unavailable'))
      return
    }
    const body = new URLSearchParams(fields).toString()
    const req = request(
      {
        ...endpoint,
        method: 'POST',
        headers: {
          'x-nodeterm-hook-token': token,
          'x-nodeterm-node-token': route.nodeToken,
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body)
        }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.setTimeout(3_000, () => req.destroy(new Error('DisTerm hook request timed out')))
    req.end(body)
  })
}

function hookJsonRequest<T>(route: Route, pathname: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let env: Record<string, string>
    try {
      env = readHookEndpointEnv(route.hookEndpoint)
    } catch (error) {
      reject(error)
      return
    }
    const token = env.NODETERM_HOOK_TOKEN
    const endpoint = hookEndpointOptions(env, pathname)
    if (!endpoint || !token || !SAFE_NODE_TOKEN.test(route.nodeToken)) {
      reject(new Error('DisTerm hook endpoint unavailable'))
      return
    }
    const req = request(
      {
        ...endpoint,
        method: 'POST',
        headers: {
          'x-nodeterm-hook-token': token,
          'x-nodeterm-node-token': route.nodeToken,
          'x-nodeterm-node-id': route.nodeId,
          'content-length': '0'
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error('DisTerm hook request failed'))
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()) as T)
          } catch {
            reject(new Error('DisTerm hook returned invalid JSON'))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(10_000, () => req.destroy(new Error('DisTerm hook request timed out')))
    req.end()
  })
}

export function listThreadsAt(
  socketPath: string,
  requestedParams: Record<string, any>,
  timeoutMs = 10_000
): Promise<RelayThread[]> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket
    let settled = false
    let requestId = 2
    const threads: RelayThread[] = []
    const seenCursors = new Set<string>()
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      if (error) reject(error)
      else resolve(threads)
    }
    const timer = setTimeout(() => finish(new Error('Codex thread catalog timed out')), timeoutMs)
    timer.unref?.()
    try {
      ws = new WebSocket(`ws+unix://${socketPath}:/rpc`, {
        perMessageDeflate: false
      })
    } catch {
      clearTimeout(timer)
      reject(new Error('Codex app-server is unavailable'))
      return
    }
    const requestPage = (cursor?: string): void => {
      const params = {
        ...requestedParams,
        cursor: cursor ?? null,
        limit: 1000
      }
      ws.send(JSON.stringify({ id: requestId, method: 'thread/list', params }))
    }
    ws.once('open', () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'initialize',
          params: {
            clientInfo: { name: 'nodeterm-relay', version: VERSION },
            capabilities: { experimentalApi: true }
          }
        })
      )
    )
    ws.on('message', (raw) => {
      let message: Record<string, any>
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (message.id === 1) {
        if (message.error) return finish(new Error('Codex app-server initialization failed'))
        ws.send(JSON.stringify({ method: 'initialized' }))
        requestPage()
        return
      }
      if (message.id !== requestId) return
      if (message.error || !Array.isArray(message.result?.data)) {
        finish(new Error('Codex thread catalog failed'))
        return
      }
      threads.push(...message.result.data)
      const cursor = message.result.nextCursor
      if (
        typeof cursor !== 'string' ||
        !cursor ||
        seenCursors.has(cursor) ||
        threads.length >= 10_000
      ) {
        finish()
        return
      }
      seenCursors.add(cursor)
      requestId += 1
      requestPage(cursor)
    })
    ws.once('error', () => finish(new Error('Codex app-server is unavailable')))
    ws.once('close', () => finish(new Error('Codex app-server closed during thread listing')))
  })
}

function isExplicitThreadAbsent(error: unknown, threadId: string): boolean {
  if (!error || typeof error !== 'object') return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (code !== -32600 || typeof message !== 'string') return false
  return (
    message === `thread not loaded: ${threadId}` ||
    message === `no rollout found for thread id ${threadId}`
  )
}

export function readThreadOutcomeAt(
  socketPath: string,
  threadId: string,
  timeoutMs = 5_000
): Promise<RelayThreadReadOutcome> {
  if (!path.isAbsolute(socketPath) || !SAFE.test(threadId)) {
    return Promise.resolve({ kind: 'unavailable' })
  }
  return new Promise((resolve) => {
    let ws: WebSocket
    let settled = false
    const finish = (outcome: RelayThreadReadOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      resolve(outcome)
    }
    const timer = setTimeout(() => finish({ kind: 'unavailable' }), timeoutMs)
    timer.unref?.()
    try {
      ws = new WebSocket(`ws+unix://${socketPath}:/rpc`, {
        perMessageDeflate: false
      })
    } catch {
      clearTimeout(timer)
      resolve({ kind: 'unavailable' })
      return
    }
    ws.once('open', () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'nodeterm-relay', version: VERSION } }
        })
      )
    )
    ws.on('message', (raw) => {
      let message: Record<string, any>
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (message.id === 1) {
        if (message.error) return finish({ kind: 'unavailable' })
        ws.send(JSON.stringify({ method: 'initialized' }))
        ws.send(
          JSON.stringify({
            id: 2,
            method: 'thread/read',
            params: { threadId, includeTurns: false }
          })
        )
      } else if (message.id === 2) {
        if (message.error) {
          finish(
            isExplicitThreadAbsent(message.error, threadId)
              ? { kind: 'absent' }
              : { kind: 'unavailable' }
          )
          return
        }
        const thread = message.result?.thread as RelayThread | undefined
        if (
          !thread ||
          thread.id !== threadId ||
          typeof thread.path !== 'string' ||
          !path.isAbsolute(thread.path) ||
          typeof thread.cwd !== 'string' ||
          !path.isAbsolute(thread.cwd)
        ) {
          finish({ kind: 'unavailable' })
          return
        }
        finish({ kind: 'found', thread })
      }
    })
    ws.once('error', () => finish({ kind: 'unavailable' }))
    ws.once('close', () => finish({ kind: 'unavailable' }))
  })
}

export async function readThreadAt(
  socketPath: string,
  threadId: string,
  timeoutMs = 5_000
): Promise<RelayThread> {
  const outcome = await readThreadOutcomeAt(socketPath, threadId, timeoutMs)
  if (outcome.kind !== 'found') throw new Error('Codex source thread is unavailable')
  return outcome.thread
}

async function readAccountAt(
  socketPath: string,
  timeoutMs = 5_000
): Promise<{ email: string | null }> {
  if (!path.isAbsolute(socketPath)) throw new Error('Invalid Codex socket')
  return new Promise((resolve, reject) => {
    let ws: WebSocket
    let settled = false
    const finish = (value?: { email: string | null }, error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      if (error) reject(error)
      else resolve(value ?? { email: null })
    }
    const timer = setTimeout(
      () => finish(undefined, new Error('Codex account read timed out')),
      timeoutMs
    )
    timer.unref?.()
    ws = new WebSocket(`ws+unix://${socketPath}:/rpc`, {
      perMessageDeflate: false
    })
    ws.once('open', () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'nodeterm-relay', version: VERSION } }
        })
      )
    )
    ws.on('message', (raw) => {
      let message: Record<string, any>
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (message.id === 1) {
        if (message.error)
          return finish(undefined, new Error('Codex app-server initialization failed'))
        ws.send(JSON.stringify({ method: 'initialized' }))
        ws.send(JSON.stringify({ id: 2, method: 'account/read', params: {} }))
      } else if (message.id === 2) {
        if (message.error) return finish(undefined, new Error('Codex account read failed'))
        const email =
          typeof message.result?.account?.email === 'string'
            ? message.result.account.email
            : typeof message.result?.email === 'string'
              ? message.result.email
              : null
        finish({ email })
      }
    })
    ws.once('error', () => finish(undefined, new Error('Codex app-server is unavailable')))
    ws.once('close', () =>
      finish(undefined, new Error('Codex app-server closed during account read'))
    )
  })
}

/** Resolve a direct `resume <id>` that did not pass through the merged picker. The selected
 * account wins when it already knows the id. Otherwise exactly one foreign account must expose a
 * valid rollout path; duplicate ids across foreign accounts deliberately remain unresolved. */
export async function resolveForeignThreadAt(
  currentSocketPath: string,
  catalogSocketPaths: string[],
  threadId: string
): Promise<RelayThreadLocation> {
  if (!path.isAbsolute(currentSocketPath) || !SAFE.test(threadId)) return { kind: 'unavailable' }
  const current = await readThreadOutcomeAt(currentSocketPath, threadId)
  if (current.kind === 'found') return { kind: 'native' }
  if (current.kind === 'unavailable') return { kind: 'unavailable' }
  const sockets = [...new Set(catalogSocketPaths)].filter(
    (socketPath) => socketPath !== currentSocketPath && path.isAbsolute(socketPath)
  )
  const outcomes = await Promise.all(
    sockets.map(async (socketPath) => {
      const outcome = await readThreadOutcomeAt(socketPath, threadId)
      if (outcome.kind !== 'found') return outcome
      const thread = outcome.thread
      const name =
        typeof thread.name === 'string' && thread.name.trim() ? thread.name.trim() : undefined
      return {
        kind: 'found' as const,
        thread: {
          socketPath,
          path: thread.path as string,
          cwd: thread.cwd,
          ...(name ? { name } : {})
        }
      }
    })
  )
  if (outcomes.some((outcome) => outcome.kind === 'unavailable')) return { kind: 'unavailable' }
  const matches = outcomes
    .filter(
      (outcome): outcome is { kind: 'found'; thread: RelayForeignThread } =>
        outcome.kind === 'found'
    )
    .map((outcome) => outcome.thread)
  if (matches.length === 0) return { kind: 'unavailable' }
  const canonical = new Map<string, RelayForeignThread>()
  for (const match of matches) {
    const rollout = rolloutIdentity(match.path)
    if (!rollout) return { kind: 'unavailable' }
    canonical.set(rollout, canonical.get(rollout) ?? match)
  }
  if (canonical.size === 1) return { kind: 'foreign', thread: [...canonical.values()][0] }
  return { kind: 'ambiguous' }
}

async function authorizeResume(route: Route, threadId: string): Promise<boolean> {
  const owner = conflictingOwner(threadId)
  if (owner === '' || owner === route.nodeId) return true
  try {
    return (
      (await hookRequest(route, '/codex-thread/authorize', {
        nodeId: route.nodeId,
        threadId,
        accountId: route.accountId ?? ''
      })) === 204
    )
  } catch {
    return false
  }
}

async function notifyElectron(route: Route, threadId: string, name?: string): Promise<boolean> {
  try {
    return (
      (await hookRequest(route, '/codex-thread/observed', {
        nodeId: route.nodeId,
        threadId,
        accountId: route.accountId ?? '',
        name: name ?? ''
      })) === 204
    )
  } catch {
    return false
  }
}

function serve(): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const lock = `${statePath}.serve-lock`
  if (!acquireProcessLock(lock)) return
  const current = readState()
  if (current) {
    try {
      process.kill(current.pid, 0)
      releaseProcessLock(lock)
      return
    } catch {}
  }
  const token = randomUUID()
  const routes = new Map<string, RegisteredRoute>()
  const reservations = new Map<string, symbol>()
  const wss = new WebSocketServer({ noServer: true })
  const server = createServer((req, res) => {
    if (!authOk(req.headers.authorization, token) || req.method !== 'POST') {
      res.writeHead(403).end()
      return
    }
    if (req.url === '/ping') {
      res.writeHead(200).end('ok')
      return
    }
    if (req.url !== '/register') {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => {
      try {
        const route = JSON.parse(Buffer.concat(chunks).toString()) as Route
        // Account id becomes a directory/scope/mapping-file component, so it passes the shared
        // supply-chain predicate (must start alnum — blocks `.`/`..`/leading separator), not just
        // the looser wire charset (GC 7).
        if (
          !SAFE.test(route.nodeId) ||
          !SAFE_NODE_TOKEN.test(route.nodeToken) ||
          (route.accountId && !isSafeAccountId(route.accountId)) ||
          !path.isAbsolute(route.socketPath) ||
          !path.isAbsolute(route.hookEndpoint)
        )
          throw new Error()
        const key = randomUUID()
        const timer = setTimeout(() => routes.delete(key), 60_000)
        timer.unref?.()
        routes.set(key, { route, timer, active: 0 })
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(key)
      } catch {
        res.writeHead(400).end()
      }
    })
  })
  server.on('upgrade', (req, socket, head) => {
    // Codex 0.147 deliberately accepts only `ws://host:port` as --remote; URL paths are rejected
    // before a connection is attempted. Use the already-required per-connection Bearer token as
    // the one-shot route capability while every node still shares this single listener.
    const routeKey = bearerToken(req.headers.authorization)
    const registered = routeKey && routes.get(routeKey)
    if (!registered || !authOk(req.headers.authorization, routeKey)) {
      socket.destroy()
      return
    }
    const route = registered.route
    clearTimeout(registered.timer)
    // Codex TUI opens more than one WebSocket for one invocation (session picker/bootstrap and
    // the main session). The random capability remains scoped to this exact node route while any
    // connection is live, then expires shortly after the final disconnect to allow reconnects.
    registered.active += 1
    wss.handleUpgrade(req, socket, head, (down) => {
      const up = new WebSocket(`ws+unix://${route.socketPath}:/rpc`, {
        perMessageDeflate: false
      })
      const queued: Array<{ data: Buffer; binary: boolean }> = []
      const pending = new Map<string, RelayThreadRequest>()
      const reservationOwner = Symbol(route.nodeId)
      const requestReservations = new Map<string, string>()
      down.on('message', async (data, binary) => {
        let buf = Buffer.from(data as any)
        let message: any
        let foreignName: string | undefined
        try {
          message = JSON.parse(buf.toString())
          if (message.method === 'thread/list' && message.id !== undefined) {
            try {
              const catalog = await hookJsonRequest<{
                accounts: Array<{ accountId?: string; socketPath: string }>
              }>(route, '/codex-thread/catalog')
              const socketPaths = [
                ...new Set([
                  route.socketPath,
                  ...catalog.accounts
                    .map((account) => account.socketPath)
                    .filter((socketPath) => path.isAbsolute(socketPath))
                ])
              ]
              if (socketPaths.length > 1) {
                const params =
                  message.params && typeof message.params === 'object' ? message.params : {}
                const sourceParams = { ...params }
                delete sourceParams.cursor
                const sources = (
                  await Promise.all(
                    socketPaths.map(async (socketPath) => {
                      try {
                        return {
                          socketPath,
                          threads: await listThreadsAt(socketPath, sourceParams)
                        }
                      } catch {
                        return null
                      }
                    })
                  )
                ).filter((source): source is RelayThreadSource => source !== null)
                if (sources.some((source) => source.socketPath === route.socketPath)) {
                  const merged = mergeRelayThreadLists(sources, route.socketPath, params)
                  if (down.readyState === WebSocket.OPEN) {
                    down.send(JSON.stringify({ id: message.id, result: merged.result }))
                  }
                  return
                }
              }
            } catch {
              // Electron may be restarting. Fall through to the selected account's native list.
            }
          }
          if (message.method === 'thread/resume') {
            const selectedThreadId = message.params?.threadId
            const requestId = message.id === undefined ? '' : String(message.id)
            const reservationKey =
              typeof selectedThreadId === 'string' && SAFE.test(selectedThreadId)
                ? relayThreadReservationKey(selectedThreadId)
                : ''
            // Global by thread id and synchronous before catalog/read awaits: neither another
            // account nor a native/foreign routing difference may open the rollout concurrently.
            if (
              !tryReserveRelayThread(
                reservations,
                requestReservations,
                reservationKey,
                requestId,
                reservationOwner
              )
            ) {
              if (message.id !== undefined && down.readyState === WebSocket.OPEN) {
                down.send(
                  JSON.stringify({
                    id: message.id,
                    error: {
                      code: -32001,
                      message: 'Codex thread is already open in another DisTerm node'
                    }
                  })
                )
              }
              return
            }
            try {
              let location: RelayThreadLocation
              try {
                await readThreadAt(route.socketPath, selectedThreadId)
                location = { kind: 'native' }
              } catch {
                const catalog = await hookJsonRequest<{
                  accounts: Array<{ accountId?: string; socketPath: string }>
                }>(route, '/codex-thread/catalog')
                location = await resolveForeignThreadAt(
                  route.socketPath,
                  catalog.accounts.map((account) => account.socketPath),
                  selectedThreadId
                )
              }
              if (
                reservations.get(reservationKey) !== reservationOwner ||
                down.readyState !== WebSocket.OPEN
              )
                return
              if (location.kind === 'ambiguous' || location.kind === 'unavailable')
                throw new Error()
              if (location.kind === 'foreign') {
                const foreign = location.thread
                const cwd =
                  typeof message.params?.cwd === 'string' && path.isAbsolute(message.params.cwd)
                    ? message.params.cwd
                    : foreign.cwd
                foreignName = foreign.name ?? indexedName(foreign.socketPath, selectedThreadId)
                message = retargetRelayResumeByPath(message, selectedThreadId, foreign.path, cwd)
                buf = Buffer.from(JSON.stringify(message))
              }
            } catch {
              if (reservations.get(reservationKey) === reservationOwner)
                reservations.delete(reservationKey)
              requestReservations.delete(requestId)
              if (message.id !== undefined && down.readyState === WebSocket.OPEN) {
                down.send(
                  JSON.stringify({
                    id: message.id,
                    error: {
                      code: -32003,
                      message: 'DisTerm could not uniquely resolve this Codex session'
                    }
                  })
                )
              }
              return
            }
          }
          if (message.method === 'thread/resume' || message.method === 'thread/fork') {
            const threadId = message.params?.threadId
            const requestId = message.id === undefined ? '' : String(message.id)
            const heldReservationKey = requestReservations.get(requestId)
            const reservationKey =
              heldReservationKey ??
              (typeof threadId === 'string' ? `${route.socketPath}\0fork\0${threadId}` : '')
            // Set synchronously BEFORE authorizeResume's first await. Two connections arriving in
            // the same event-loop turn therefore cannot both pass and reach the shared app-server.
            if (
              !requestId ||
              !reservationKey ||
              (!heldReservationKey && reservations.has(reservationKey))
            ) {
              if (message.id !== undefined && down.readyState === WebSocket.OPEN) {
                down.send(
                  JSON.stringify({
                    id: message.id,
                    error: {
                      code: -32001,
                      message: 'Codex thread is already open in another DisTerm node'
                    }
                  })
                )
              }
              return
            }
            if (!heldReservationKey) {
              reservations.set(reservationKey, reservationOwner)
              requestReservations.set(requestId, reservationKey)
            }
            const authorized = await authorizeResume(route, threadId)
            // Close may have run while authorization was pending. It released this reservation;
            // never resurrect it or forward a queued resume after its owning connection is gone.
            if (
              reservations.get(reservationKey) !== reservationOwner ||
              down.readyState !== WebSocket.OPEN
            ) {
              return
            }
            if (!authorized) {
              if (reservations.get(reservationKey) === reservationOwner)
                reservations.delete(reservationKey)
              requestReservations.delete(requestId)
              if (down.readyState === WebSocket.OPEN) {
                down.send(
                  JSON.stringify({
                    id: message.id,
                    error: {
                      code: -32001,
                      message: 'Codex thread is already open in another DisTerm node'
                    }
                  })
                )
              }
              return
            }
          }
          trackRelayThreadRequest(pending, message, foreignName)
        } catch {}
        if (up.readyState === WebSocket.OPEN) up.send(buf, { binary })
        else queued.push({ data: buf, binary })
      })
      up.on('open', () => {
        if (down.readyState !== WebSocket.OPEN) {
          queued.length = 0
          up.close()
          return
        }
        for (const q of queued.splice(0)) up.send(q.data, { binary: q.binary })
      })
      up.on('message', async (data, binary) => {
        const buf = Buffer.from(data as any)
        let outbound = buf
        let reservationKey: string | undefined
        let responseId = ''
        try {
          const message = JSON.parse(buf.toString())
          if (message?.id !== undefined) {
            responseId = String(message.id)
            reservationKey = requestReservations.get(responseId)
          }
          const observed = resolveRelayThreadResponse(pending, message)
          if (observed && !observed.ok) {
            // Distinguish the silent-fork case (-32004) from a plain malformed-id response — see
            // relayThreadResponseError. Both used to be labelled "changed the conversation id".
            outbound = Buffer.from(
              JSON.stringify({ id: message.id, error: relayThreadResponseError(observed) })
            )
          }
          const committed = observed?.ok
            ? await bind(
                route,
                observed.threadId,
                observed.name ?? indexedName(route.socketPath, observed.source)
              ).catch(() => false)
            : true
          if (observed?.ok && !committed) {
            outbound = Buffer.from(
              JSON.stringify({
                id: message.id,
                error: {
                  code: -32002,
                  message: 'DisTerm could not commit Codex thread ownership'
                }
              })
            )
          }
        } catch {}
        if (reservationKey) {
          requestReservations.delete(responseId)
          if (reservations.get(reservationKey) === reservationOwner)
            reservations.delete(reservationKey)
        }
        if (down.readyState === WebSocket.OPEN) down.send(outbound, { binary })
      })
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        for (const key of requestReservations.values())
          if (reservations.get(key) === reservationOwner) reservations.delete(key)
        requestReservations.clear()
        queued.length = 0
        try {
          down.close()
        } catch {}
        try {
          up.close()
        } catch {}
        registered.active = Math.max(0, registered.active - 1)
        if (registered.active === 0) {
          registered.timer = setTimeout(() => {
            if (routes.get(routeKey) === registered && registered.active === 0)
              routes.delete(routeKey)
          }, 5 * 60_000)
          registered.timer.unref?.()
        }
      }
      down.on('close', close)
      down.on('error', close)
      up.on('close', close)
      up.on('error', close)
    })
  })
  const releaseLock = (): void => {
    releaseProcessLock(lock)
  }
  const onListenError = (): void => releaseLock()
  server.once('error', onListenError)
  server.listen(0, '127.0.0.1', () => {
    server.off('error', onListenError)
    const addr = server.address()
    if (!addr || typeof addr === 'string') process.exit(1)
    const tmp = tempNameFor(statePath)
    try {
      writeFileSync(
        tmp,
        JSON.stringify({
          version: VERSION,
          pid: process.pid,
          port: addr.port,
          token
        }),
        { mode: 0o600 }
      )
      renameAtomicSync(tmp, statePath)
    } catch (e) {
      // A unique temp never self-heals the way the old fixed name did; remove it on failure.
      try {
        unlinkSync(tmp)
      } catch {}
      throw e
    }
    releaseLock()
  })
}

async function register(): Promise<void> {
  const [nodeId, accountRaw, socketPath, hookEndpoint] = process.argv.slice(3)
  const nodeToken = process.env.NODETERM_CODEX_NODE_TOKEN ?? ''
  const accountId = accountRaw || undefined
  if (
    !SAFE.test(nodeId) ||
    !SAFE_NODE_TOKEN.test(nodeToken) ||
    (accountId && !isSafeAccountId(accountId)) ||
    !path.isAbsolute(socketPath) ||
    !path.isAbsolute(hookEndpoint)
  )
    throw new Error('invalid relay registration')
  const state = await ensureServer()
  const key = await relayControlPost(state.port, state.token, '/register', {
    nodeId,
    nodeToken,
    accountId,
    socketPath,
    hookEndpoint
  })
  process.stdout.write(`ws://127.0.0.1:${state.port}\n${key}\n`)
}

export type ExposeThreadOutcome = { kind: 'native' } | { kind: 'exposed' }

/**
 * Copy a foreign idle conversation's rollout into the TARGET account and prove the far side can
 * discover it — the "verify then recycle" leg of the cross-machine copy (§4.2a / §6). The node is
 * recycled onto the target account ONLY when this resolves `exposed`.
 *
 * The copy itself is NOT re-implemented here: it is PR 3's atomic, never-overwrite hardlink
 * primitive. `planCodexRolloutExposure` re-confirms the source stays inside its own account
 * `sessions/` and is a regular file; `commitCodexRolloutExposure` links the exact source inode into
 * `<targetHome>/sessions/<same relative path>` (same conversation id), fails closed on a target that
 * already holds a DIFFERENT rollout for the thread, and never writes through a symlinked segment.
 *
 * Then — because a running app-server surfacing the fresh hardlink without a reindex is UNVERIFIED
 * (probe U1) — re-read the TARGET socket: `thread/read` must report this exact id with an absolute
 * path/cwd. If it does not, roll the published link back (only while it still names our source
 * inode, so a concurrent legitimate entry is never deleted) and refuse. A pre-existing idempotent
 * link is never rolled back, because this call did not publish it. The source rollout is a hardlink
 * and is left fully intact throughout.
 */
export async function exposeForeignThread(
  targetSocket: string,
  threadId: string,
  catalogSockets: string[]
): Promise<ExposeThreadOutcome> {
  if (
    !path.isAbsolute(targetSocket) ||
    !SAFE.test(threadId) ||
    catalogSockets.length === 0 ||
    catalogSockets.some((socket) => !path.isAbsolute(socket))
  ) {
    throw new Error('invalid Codex exposure request')
  }
  const resolved = await resolveForeignThreadAt(targetSocket, catalogSockets, threadId)
  if (resolved.kind === 'native') return { kind: 'native' }
  if (resolved.kind !== 'foreign') throw new Error('Codex session id is unavailable or ambiguous')
  const sourceHome = path.dirname(path.dirname(resolved.thread.socketPath))
  const targetHome = path.dirname(path.dirname(targetSocket))
  const plan = planCodexRolloutExposure(sourceHome, targetHome, resolved.thread.path, threadId)
  // Remember whether the target already held the rollout: only a link THIS call publishes may be
  // rolled back on a discovery failure.
  const preExisted = existsSync(plan.targetPath)
  commitCodexRolloutExposure(plan)
  const outcome = await readThreadOutcomeAt(targetSocket, threadId)
  if (outcome.kind === 'found') return { kind: 'exposed' }
  if (!preExisted) rollbackExposedLink(plan)
  throw new Error('Copied Codex rollout was not discoverable on the target account')
}

/** Undo a link this exposure published — but only while the target still names the exact source
 * inode we linked, so a legitimate entry a concurrent process raced into the pathname is untouched
 * (mirrors PR 3's `publishedTargetStillOurs` discipline). */
function rollbackExposedLink(plan: {
  targetPath: string
  sourceDev: number
  sourceIno: number
}): void {
  try {
    const entry = lstatSync(plan.targetPath)
    if (entry.dev === plan.sourceDev && entry.ino === plan.sourceIno) unlinkSync(plan.targetPath)
  } catch {
    /* nothing to roll back */
  }
}

async function exposeThread(): Promise<void> {
  const [targetSocket, threadId, ...catalogSockets] = process.argv.slice(3)
  await exposeForeignThread(targetSocket ?? '', threadId ?? '', catalogSockets)
}

if (process.argv[2] === 'serve') serve()
else if (process.argv[2] === 'register')
  void register().catch((error) => {
    console.error(error instanceof Error ? error.message : 'DisTerm Codex relay unavailable')
    process.exit(69)
  })
else if (process.argv[2] === 'account-read')
  void readAccountAt(process.argv[3] ?? '')
    .then((account) => {
      process.stdout.write(`${JSON.stringify(account)}\n`)
    })
    .catch(() => process.exit(69))
else if (process.argv[2] === 'thread-check')
  void readThreadAt(process.argv[3] ?? '', process.argv[4] ?? '')
    .then(() => process.exit(0))
    .catch(() => process.exit(69))
else if (process.argv[2] === 'expose-thread') void exposeThread().catch(() => process.exit(69))
