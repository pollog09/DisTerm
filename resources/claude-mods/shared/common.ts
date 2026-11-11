// Helpers the DisTerm token-saver mods share: where their files live, the on/off switches,
// and the savings ledger DisTerm draws from. shared/common.ts is the source; every plugin carries a
// byte-identical copy at hooks/common.ts because a plugin is installed on its own (see README.md).
// The ledger line's shape is the contract in DisTerm's src/shared/token-savers.ts.

import type { EngineInterface, ModelUsage } from 'claude-code'

type Engine = EngineInterface

export type SaverMod =
  | 'input-router'
  | 'model-router'
  | 'efficient-browser-use'
  | 'handoff'
  | 'effort-advisor'
  | 'keep-warm'
  | 'research-router'

export interface SavingLine {
  ts: string
  session: string | null
  nodeId: string | null
  tool_use_id: string | null
  mod: SaverMod
  action: string
  before: number
  after: number
  /** `cache_read` is set only by `helperUsageCached`; `in` then leaves those tokens out. */
  helper: { model: string; in: number; out: number; cache_read?: number } | null
  /** handoff: the absolute path of the file the line is about. */
  file?: string
  measured: 'real' | 'estimated'
  usd_saved?: number
}

export type SavingInput = Omit<SavingLine, 'ts' | 'session' | 'nodeId'>

/** Relative to the home directory; `.nodeterm` is DisTerm's on-disk namespace. */
export const SAVERS_DIR = '.nodeterm/token-savers'

/** A rough token count for text the model reads: four characters a token. */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4))
}

/** JSON with every non-ASCII character escaped, so no shell or console code page can mangle it. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  )
}

/** A file name made only of safe characters (for a tool_use_id). */
export function safeName(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)
  return cleaned || 'unnamed'
}

/** The helper model's cost of one call, as the ledger spells it. */
export function helperUsage(model: string, usage: ModelUsage | undefined): SavingLine['helper'] {
  if (!usage) return null
  const input =
    (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
  return { model, in: input, out: usage.output_tokens || 0 }
}

/**
 * Like `helperUsage`, but with the prompt tokens the cache served counted apart (`cache_read`),
 * which DisTerm prices at a tenth of the input price. For forks and subagents, which read a lot.
 */
export function helperUsageCached(model: string, usage: ModelUsage | undefined): SavingLine['helper'] {
  if (!usage) return null
  return {
    model,
    in: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
    out: usage.output_tokens || 0,
    cache_read: usage.cache_read_input_tokens || 0,
  }
}

/** Every prompt token a call read: fresh, written to the cache and served from it. */
export function promptTokens(usage: ModelUsage | undefined): number {
  if (!usage) return 0
  return (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
}

export async function homeDir($: Engine): Promise<string | null> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return home ? home.replace(/[\\/]+$/, '') : null
}

export async function isWindows($: Engine): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

/** An absolute path under ~/.nodeterm/token-savers, or null when the home directory is unknown. */
export async function saversPath($: Engine, rel: string): Promise<string | null> {
  const home = await homeDir($)
  return home ? `${home}/${SAVERS_DIR}/${rel}` : null
}

let switchesSeen: { path: string; mtimeMs: number; value: Record<string, unknown> } | null = null

/**
 * Whether `mod` is switched on. Read on every event, re-parsed only when the file's mtime moves.
 * No file, an unreadable file or a missing key all mean on: only an explicit `false` turns a mod off.
 */
export async function isModOn($: Engine, mod: SaverMod): Promise<boolean> {
  try {
    const path = await saversPath($, 'switches.json')
    if (!path) return true
    const stat = await $.fs.stat(path).catch(() => null)
    if (!stat || stat.kind !== 'file') {
      switchesSeen = null
      return true
    }
    if (!switchesSeen || switchesSeen.path !== path || switchesSeen.mtimeMs !== stat.mtimeMs) {
      const parsed: unknown = JSON.parse(await $.fs.read(path))
      const value =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
      switchesSeen = { path, mtimeMs: stat.mtimeMs, value }
    }
    return switchesSeen.value[mod] !== false
  } catch {
    return true
  }
}

const POSIX_APPEND = 'mkdir -p "$(dirname "$1")" && cat >> "$1"'
// Stage into a sibling temp file and rename it into place: a write cut short (timeout, full disk)
// leaves the old file whole, never a truncated one.
const POSIX_WRITE = 'mkdir -p "$(dirname "$1")" && t="$1.tmp.$$" && tee "$t" >/dev/null && mv -f "$t" "$1" || { rm -f "$t"; exit 1; }'
const WIN_WRITE =
  '$p = $env:DISTERM_SAVER_PATH; ' +
  'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null; ' +
  '$t = [Console]::In.ReadToEnd(); $enc = New-Object System.Text.UTF8Encoding $false; ' +
  'if ($env:DISTERM_SAVER_MODE -eq "append") { [IO.File]::AppendAllText($p, $t, $enc) } ' +
  'else { [IO.File]::WriteAllText($p, $t, $enc) }'

async function hostWrite($: Engine, path: string, text: string, mode: 'append' | 'write'): Promise<boolean> {
  if (await isWindows($)) {
    const ran = await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', WIN_WRITE], {
      stdin: text,
      env: { DISTERM_SAVER_PATH: path, DISTERM_SAVER_MODE: mode },
      timeoutMs: 15000,
    })
    return ran.exitCode === 0
  }
  const script = mode === 'append' ? POSIX_APPEND : POSIX_WRITE
  const ran = await $.process.run(['sh', '-c', script, 'sh', path], { stdin: text, timeoutMs: 15000 })
  return ran.exitCode === 0
}

/** Writes a whole file of any size: `$.fs.write` first, the host's shell past its 4 MiB limit. */
export async function writeWhole($: Engine, path: string, text: string): Promise<boolean> {
  try {
    await $.fs.write(path, text)
    return true
  } catch {
    try {
      return await hostWrite($, path, text, 'write')
    } catch {
      return false
    }
  }
}

/** Appends one ledger line. Never throws: a ledger that cannot be written costs only the record. */
export async function recordSaving($: Engine, input: SavingInput): Promise<void> {
  try {
    const path = await saversPath($, 'savings.jsonl')
    if (!path) return
    const session = await $.session.id().catch(() => null)
    const nodeId = (await $.env.get('NODETERM_NODE_ID')) || null
    const line: SavingLine = { ts: new Date().toISOString(), session: session || null, nodeId, ...input }
    await hostWrite($, path, asciiJson(line) + '\n', 'append')
  } catch {
    // the saving happened; only its record is lost
  }
}

/** Matches MCP tools that drive a browser or a screen, whose results are mostly screenshots. */
export function isBrowserTool(tool: string): boolean {
  return tool.startsWith('mcp__') && /computer|screenshot|browser|chrome|playwright/i.test(tool)
}
