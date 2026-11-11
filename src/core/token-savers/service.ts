// The token-savers service, booted by both shells (Electron main and the Server Edition): polls the
// ledger the mods append to, holds the install state and the switches, and pushes one snapshot to
// every UI on change. docs/reference/token-savers.md.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { IPC } from '../../shared/ipc'
import {
  TOKEN_SAVERS_DIR,
  TOKEN_SAVERS_LEDGER,
  TOKEN_SAVERS_SWITCHES,
  TOKEN_SAVER_IDS,
  emptyTotals,
  type TokenSaverId,
  type TokenSaversSnapshot
} from '../../shared/token-savers'
import { platform } from '../platform'
import { claudeSystemConfigDir } from '../agents/hooks/claude'
import { installTokenSavers, installedIn, syncMarketplace, uninstallTokenSavers } from './install'
import { aggregateLedger, localDay } from './ledger'
import { readSwitches, switchesView, writeSwitch } from './switches'

const POLL_MS = 2000
/** Read at most the newest 8 MB of the ledger; older lines fall out of "all time" (stated in the panel). */
export const LEDGER_READ_CAP = 8 * 1024 * 1024

export async function readLedgerTail(file: string, cap = LEDGER_READ_CAP): Promise<{ text: string; partial: boolean }> {
  const fh = await fs.promises.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - cap)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1) // drop the torn first line
    return { text, partial: start > 0 }
  } finally {
    await fh.close()
  }
}

export interface TokenSaversService {
  snapshot(): TokenSaversSnapshot
  refresh(): Promise<void>
  /** Resolves once the first install check and ledger read are done. */
  ready(): Promise<void>
  dispose(): void
}

export interface TokenSaversConsent {
  /** The Server Edition's `installHooks: false`: nothing is written into, or removed from, an agent's
   *  config. A veto touches nothing, so a desktop sharing this home keeps what it installed. */
  veto: boolean
  /** The user's Claude-integration choice (`settings.agentIntegrations.agents.claude`). Install needs
   *  'enabled' (CONTRIBUTING.md § User-owned agent settings, issue #744). Only an explicit 'declined'
   *  removes the mods: undefined is "never asked", which writes nothing and removes nothing. */
  claude: 'enabled' | 'declined' | undefined
}

export const CONSENT_REQUIRED =
  'Turn on the Claude integration first (Settings → Agents): the token savers are installed into Claude Code.'
export const CONSENT_VETOED = 'This server was started with installHooks off, so nothing is installed into Claude Code.'

/** Connector outputs and PDF text input-router saved for Claude to re-read are kept this long. */
export const FULL_OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const PRUNE_EVERY_MS = 60 * 60 * 1000

/** Delete saved full outputs older than `maxAgeMs`. They can hold mail or ticket text. */
export async function pruneFullOutputs(dir: string, now = Date.now(), maxAgeMs = FULL_OUTPUT_MAX_AGE_MS): Promise<number> {
  let n = 0
  const names = await fs.promises.readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    const f = path.join(dir, name)
    const st = await fs.promises.lstat(f).catch(() => null)
    if (st?.isFile() && now - st.mtimeMs > maxAgeMs) {
      await fs.promises.rm(f, { force: true }).catch(() => {})
      n++
    }
  }
  return n
}

export interface TokenSaversDeps {
  home?: string
  consent?: () => TokenSaversConsent
  install?: () => Promise<{ ok: boolean; error: string | null }>
  uninstall?: () => Promise<{ ok: boolean; error: string | null }>
  isInstalled?: () => Promise<boolean>
  sync?: () => Promise<unknown>
  /** Tests drive the poll themselves. */
  noTimers?: boolean
}

export function startTokenSaversService(deps: TokenSaversDeps = {}): TokenSaversService {
  const consent = deps.consent ?? ((): TokenSaversConsent => ({ veto: false, claude: undefined }))
  const install = deps.install ?? (() => installTokenSavers())
  const uninstall = deps.uninstall ?? (() => uninstallTokenSavers())
  const isInstalled = deps.isInstalled ?? (() => installedIn(claudeSystemConfigDir()))
  const sync = deps.sync ?? (() => syncMarketplace())
  const home = deps.home ?? os.homedir()
  const ledgerFile = path.join(home, TOKEN_SAVERS_LEDGER)
  const switchesFile = path.join(home, TOKEN_SAVERS_SWITCHES)
  const fullDir = path.join(home, TOKEN_SAVERS_DIR, 'full')

  let snap: TokenSaversSnapshot = {
    installed: false,
    installError: null,
    switches: switchesView({}),
    day: localDay(Date.now()),
    today: emptyTotals(),
    all: emptyTotals(),
    byNode: {},
    byMod: {},
    rows: [],
    skipped: 0
  }
  let ledgerKey = ''
  let busy = false
  /** One removal attempt per decline: a failed removal is not retried every poll, only after the
   *  consent changes again (or the user presses Remove). */
  let declineHandled = false
  /** Bumped by every switch write, so a poll that read the file before the write drops its value. */
  let switchWrites = 0

  const publish = (): void => platform().broadcast(IPC.tokenSaversUpdate, snap)

  const checkInstalled = async (): Promise<void> => {
    const installed = await isInstalled().catch(() => false)
    if (installed !== snap.installed) {
      snap = { ...snap, installed }
      publish()
    }
    // A DisTerm update ships new mod files: refresh the folder Claude reads them from.
    if (installed) await Promise.resolve(sync()).catch(() => {})
  }

  const enforceConsent = async (): Promise<void> => {
    const c = consent()
    if (c.veto || c.claude !== 'declined') {
      declineHandled = false
      return
    }
    if (declineHandled || !snap.installed) return
    declineHandled = true
    const r = await uninstall().catch((e: Error) => ({ ok: false, error: e.message }))
    snap = { ...snap, installError: r.error }
    await checkInstalled()
    publish()
  }

  const readAll = async (force: boolean): Promise<void> => {
    if (busy) return
    busy = true
    try {
      let changed = force
      const writesBefore = switchWrites
      const switches = switchesView(await readSwitches(switchesFile))
      if (writesBefore === switchWrites && TOKEN_SAVER_IDS.some((id) => switches[id] !== snap.switches[id])) {
        snap = { ...snap, switches }
        changed = true
      }
      const st = await fs.promises.stat(ledgerFile).catch(() => null)
      const key = st ? `${st.size}:${st.mtimeMs}:${localDay(Date.now())}` : `none:${localDay(Date.now())}`
      if (key !== ledgerKey || force) {
        ledgerKey = key
        const text = st ? (await readLedgerTail(ledgerFile).catch(() => ({ text: '' }))).text : ''
        snap = { ...snap, ...aggregateLedger(text, Date.now()) }
        changed = true
      }
      if (changed) publish()
    } finally {
      busy = false
    }
    await enforceConsent()
  }

  const ready = checkInstalled().then(() => readAll(true))
  const timers: ReturnType<typeof setInterval>[] = []
  if (!deps.noTimers) {
    timers.push(setInterval(() => void readAll(false), POLL_MS))
    void pruneFullOutputs(fullDir)
    timers.push(setInterval(() => void pruneFullOutputs(fullDir), PRUNE_EVERY_MS))
    for (const t of timers) t.unref?.()
  }

  const p = platform()
  p.handle(IPC.tokenSaversGet, () => snap)
  p.handle(IPC.tokenSaversInstall, async () => {
    const c = consent()
    const refusal = c.veto ? CONSENT_VETOED : c.claude !== 'enabled' ? CONSENT_REQUIRED : null
    const r = refusal ? { ok: false, error: refusal } : await install().catch((e: Error) => ({ ok: false, error: e.message }))
    snap = { ...snap, installError: r.error }
    await checkInstalled()
    publish()
    return snap
  })
  p.handle(IPC.tokenSaversUninstall, async () => {
    // Removing is never gated: the user asking for less in their config is always honoured,
    // except under the veto, which promises this server touches nothing.
    const r = consent().veto
      ? { ok: false, error: CONSENT_VETOED }
      : await uninstall().catch((e: Error) => ({ ok: false, error: e.message }))
    snap = { ...snap, installError: r.error }
    await checkInstalled()
    publish()
    return snap
  })
  p.handle(IPC.tokenSaversSetSwitch, async (id: unknown, on: unknown) => {
    if (!TOKEN_SAVER_IDS.includes(id as TokenSaverId) || typeof on !== 'boolean') throw new Error('Bad switch')
    // The answer is built from what was written, not from a re-read a running poll may skip.
    switchWrites++
    const written = await writeSwitch(switchesFile, id as TokenSaverId, on)
    snap = { ...snap, switches: switchesView(written) }
    publish()
    return snap
  })

  return {
    snapshot: () => snap,
    refresh: () => readAll(true),
    ready: () => ready,
    dispose: () => timers.forEach(clearInterval)
  }
}
