// Install / remove the token-saver mods in Claude Code. The mods ship inside DisTerm as text
// (bundled.generated.ts, built from resources/claude-mods by scripts/bundle-claude-mods.mjs) and are
// written to a STABLE folder, ~/.nodeterm/token-savers/marketplace: a packaged app's resources path
// moves with every update (and an AppImage's with every launch), and Claude reads a directory
// marketplace from the folder itself. Registration goes through Claude's own `claude plugin` CLI,
// never a hand edit of settings.json: Claude owns that schema, and shared settings are user data
// (docs/reference/agent-hooks.md, issue #851). See docs/reference/token-savers.md § Install.
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { supportsTokenSavers } from '../../shared/agents/config'
import {
  TOKEN_SAVERS_MARKETPLACE,
  TOKEN_SAVERS_MARKETPLACE_DIR,
  TOKEN_SAVERS_MIN_CLAUDE,
  TOKEN_SAVER_IDS
} from '../../shared/token-savers'
import { claudeSystemConfigDir } from '../agents/hooks/claude'
import { claudeCliCaps } from '../claude-cli'
import { claudeAccountsSnapshot, claudeConfigDirFor } from '../claude-config-dir'
import { directExecutableInvocation, findInLoginPath } from '../exec-path'
import { writeFileAtomic } from '../fs-atomic'
import { BUNDLED_MODS } from './bundled.generated'

const execFileP = promisify(execFile)
const CLI_TIMEOUT_MS = 60_000
const STAMP = '.bundle-hash'

export const marketplaceDir = (home = os.homedir()): string => path.join(home, TOKEN_SAVERS_MARKETPLACE_DIR)

export function bundleHash(files: Readonly<Record<string, string>> = BUNDLED_MODS): string {
  const h = createHash('sha256')
  for (const k of Object.keys(files).sort()) h.update(k).update('\0').update(files[k]).update('\0')
  return h.digest('hex')
}

/**
 * Write the bundled mods into `dir` when its stamp differs from this build's. Files the bundle no
 * longer has are removed, so a mod file deleted upstream does not linger and get imported.
 * Returns true when anything was written.
 */
export async function syncMarketplace(
  dir: string = marketplaceDir(),
  files: Readonly<Record<string, string>> = BUNDLED_MODS
): Promise<boolean> {
  const hash = bundleHash(files)
  const stamp = await fs.promises.readFile(path.join(dir, STAMP), 'utf8').catch(() => '')
  if (stamp.trim() === hash) return false
  for (const [rel, text] of Object.entries(files)) {
    if (rel.split('/').some((p) => p === '..' || p === '')) throw new Error(`Bad bundled path: ${rel}`)
    const target = path.join(dir, ...rel.split('/'))
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await writeFileAtomic(target, text)
  }
  await removeStale(dir, new Set(Object.keys(files)))
  await writeFileAtomic(path.join(dir, STAMP), `${hash}\n`)
  return true
}

async function removeStale(dir: string, keep: ReadonlySet<string>, rel = ''): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (r === STAMP) continue
    if (e.isDirectory()) await removeStale(dir, keep, r)
    else if (!keep.has(r)) await fs.promises.rm(path.join(dir, r), { force: true })
  }
}

/** Every local Claude config dir a session can run under: the default one and each managed or
 *  linked account's. Deduped; a pending or remote account has no local dir to install into. */
export function claudeConfigDirs(): string[] {
  const out = [claudeSystemConfigDir()]
  for (const a of claudeAccountsSnapshot()) {
    if (a.host || a.pending) continue
    try {
      const d = claudeConfigDirFor(a.id)
      if (!out.includes(d)) out.push(d)
    } catch {
      /* invalid account id: skip it */
    }
  }
  return out
}

const pluginKey = (id: string): string => `${id}@${TOKEN_SAVERS_MARKETPLACE}`

/** Installed in a config dir = every mod is enabled there, as Claude records it in settings.json. */
export async function installedIn(configDir: string): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(path.join(configDir, 'settings.json'), 'utf8')
    const enabled = (JSON.parse(raw) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {}
    return TOKEN_SAVER_IDS.every((id) => enabled[pluginKey(id)] === true)
  } catch {
    return false
  }
}

export type CliRunner = (args: string[], configDir: string) => Promise<{ ok: boolean; out: string }>

/** Run `claude <args>` against one config dir. The default dir runs with the inherited env, so a
 *  user's own CLAUDE_CONFIG_DIR keeps meaning what it means in their shell. */
export async function runClaudeCli(args: string[], configDir: string): Promise<{ ok: boolean; out: string }> {
  const bin = await findInLoginPath('claude')
  if (!bin) return { ok: false, out: 'The claude command was not found on PATH.' }
  const inv = directExecutableInvocation(bin, args)
  if (!inv) return { ok: false, out: 'The claude command cannot be run from here.' }
  const env = { ...process.env }
  if (configDir !== claudeSystemConfigDir()) env.CLAUDE_CONFIG_DIR = configDir
  try {
    const r = await execFileP(inv.executable, inv.args, { ...inv.options, env, timeout: CLI_TIMEOUT_MS })
    return { ok: true, out: `${r.stdout}${r.stderr}` }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || (err.message ?? 'failed') }
  }
}

export interface InstallDeps {
  run?: CliRunner
  dirs?: () => string[]
  version?: () => Promise<string | null>
  marketplace?: string
}

const lastLine = (s: string): string => s.trim().split('\n').filter(Boolean).pop() ?? ''

/** Register the marketplace and install every mod, in every local config dir. Idempotent: an
 *  already-added marketplace or installed plugin is re-affirmed, not duplicated. */
export async function installTokenSavers(deps: InstallDeps = {}): Promise<{ ok: boolean; error: string | null }> {
  const run = deps.run ?? runClaudeCli
  const version = await (deps.version ?? (async () => (await claudeCliCaps()).version))()
  if (!supportsTokenSavers(version)) {
    return {
      ok: false,
      error: `Token savers need Claude Code ${TOKEN_SAVERS_MIN_CLAUDE} or newer (found ${version ?? 'none'}). Run \`claude update\`.`
    }
  }
  const dir = deps.marketplace ?? marketplaceDir()
  if (!deps.marketplace) await syncMarketplace(dir)
  for (const configDir of (deps.dirs ?? claudeConfigDirs)()) {
    const added = await run(['plugin', 'marketplace', 'add', dir, '--scope', 'user'], configDir)
    if (!added.ok && !/already/i.test(added.out)) return { ok: false, error: `Adding the marketplace failed: ${lastLine(added.out)}` }
    for (const id of TOKEN_SAVER_IDS) {
      const r = await run(['plugin', 'install', pluginKey(id), '--scope', 'user'], configDir)
      if (!r.ok && !/already/i.test(r.out)) return { ok: false, error: `Installing ${id} failed: ${lastLine(r.out)}` }
    }
  }
  return { ok: true, error: null }
}

/** Uninstall every mod and drop the marketplace. Errors for a mod that is not installed are ignored:
 *  removal is "make it absent", not "it must have been there". The ledger and switches stay. */
export async function uninstallTokenSavers(deps: InstallDeps = {}): Promise<{ ok: boolean; error: string | null }> {
  const run = deps.run ?? runClaudeCli
  let error: string | null = null
  for (const configDir of (deps.dirs ?? claudeConfigDirs)()) {
    for (const id of TOKEN_SAVER_IDS) {
      const r = await run(['plugin', 'uninstall', pluginKey(id), '--scope', 'user'], configDir)
      if (!r.ok && !/not (installed|found)/i.test(r.out)) error ??= `Removing ${id} failed: ${lastLine(r.out)}`
    }
    const m = await run(['plugin', 'marketplace', 'remove', TOKEN_SAVERS_MARKETPLACE], configDir)
    if (!m.ok && !/not found|no marketplace/i.test(m.out)) error ??= `Removing the marketplace failed: ${lastLine(m.out)}`
  }
  return { ok: error === null, error }
}
