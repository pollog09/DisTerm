// Token savers: Claude Code mods DisTerm ships (resources/claude-mods) and the ledger they append to.
// The mods run INSIDE Claude Code (they rewrite tool results and pick subagent models); DisTerm installs
// them, switches them, and draws what they saved. This file is the contract both sides share.
// docs/reference/token-savers.md has the rules and the reasons.

/** The marketplace name DisTerm registers in Claude's settings.json. */
export const TOKEN_SAVERS_MARKETPLACE = 'disterm-token-savers'

/** Lowest Claude Code version whose plugin loader runs function-hook modules. */
export const TOKEN_SAVERS_MIN_CLAUDE = '2.1.287'

export const TOKEN_SAVER_IDS = ['input-router', 'model-router', 'efficient-browser-use'] as const
export type TokenSaverId = (typeof TOKEN_SAVER_IDS)[number]

export const TOKEN_SAVER_INFO: Record<TokenSaverId, { title: string; what: string }> = {
  'input-router': {
    title: 'Input Router',
    what: 'Big file reads and connector results go to Haiku first; Claude gets short notes and the path to the full text.',
  },
  'model-router': {
    title: 'Subagent Model Router',
    what: 'Haiku judges each subagent task and moves easy ones to a cheaper model. Never changes the main chat.',
  },
  'efficient-browser-use': {
    title: 'Efficient Browser Use',
    what: 'Shrinks browser screenshots before Claude reads them.',
  },
}

/** Paths, relative to the home directory. `~/.nodeterm` is the fork's on-disk namespace (CLAUDE.md). */
export const TOKEN_SAVERS_DIR = '.nodeterm/token-savers'
export const TOKEN_SAVERS_SWITCHES = `${TOKEN_SAVERS_DIR}/switches.json`
export const TOKEN_SAVERS_LEDGER = `${TOKEN_SAVERS_DIR}/savings.jsonl`
export const TOKEN_SAVERS_MARKETPLACE_DIR = `${TOKEN_SAVERS_DIR}/marketplace`

/**
 * One ledger line, appended by a mod for each action. `before`/`after` are tokens the main chat would
 * have read and did read. `nodeId` is `NODETERM_NODE_ID` of the session, null outside DisTerm.
 * `usd_saved` is set by a mod that saves dollars rather than tokens (model-router); it can be negative.
 */
export interface LedgerLine {
  ts: string
  session: string | null
  nodeId: string | null
  tool_use_id: string | null
  mod: string
  action: string
  before: number
  after: number
  helper: { model: string; in: number; out: number } | null
  measured: 'real' | 'estimated'
  usd_saved?: number
}

/** Switches file: `{ "<mod>": false }` turns a mod off; a missing key is on. */
export type TokenSaverSwitches = Partial<Record<string, boolean>>

/** A line is "left out" of every total when its numbers are not believable. */
export const LEFT_OUT_MAX_BEFORE = 500_000
export const LEFT_OUT_MAX_RATIO = 1000

/**
 * List prices, dollars per million tokens (input, output), first-party API, from the claude-api
 * skill's model table (cached 2026-11-03). First match wins, so exact generations come before the
 * family fallbacks. Haiku 5.5's price is for prompts up to 100k tokens ($0.50 / $2.50 beyond);
 * a helper prompt above that is under-priced here. A model with no row is priced at nothing.
 */
export const MODEL_PRICES: { match: RegExp; input: number; output: number }[] = [
  { match: /haiku-5-5/i, input: 0.1, output: 0.5 },
  { match: /sonnet-5-5|sonnet-5\b/i, input: 2, output: 10 },
  { match: /opus-5-5/i, input: 4, output: 20 },
  { match: /opus-5\b|opus-4-[678]/i, input: 5, output: 25 },
  { match: /haiku-4-5/i, input: 1, output: 5 },
  { match: /sonnet-4-6/i, input: 3, output: 15 },
  // Bare aliases (`haiku`, `sonnet`, `opus`) resolve to the current generation.
  { match: /^haiku$/i, input: 0.1, output: 0.5 },
  { match: /^sonnet$/i, input: 2, output: 10 },
  { match: /^opus$/i, input: 4, output: 20 }
]

export function priceOf(model: string | null | undefined): { input: number; output: number } | null {
  if (!model) return null
  return MODEL_PRICES.find((p) => p.match.test(model)) ?? null
}

export interface SaverTotals {
  actions: number
  before: number
  after: number
  saved: number
  helperUsd: number
  usdSaved: number
  leftOut: number
}

export interface LedgerRow extends LedgerLine {
  /** Stable id: tool_use_id when present, else the line's position. */
  key: string
  saved: number
  helperUsd: number
  leftOut: string
}

export interface TokenSaversSnapshot {
  /** Install state of the marketplace + plugins in Claude's settings. */
  installed: boolean
  installError: string | null
  switches: Record<TokenSaverId, boolean>
  /** The local calendar day the `today` totals cover, YYYY-MM-DD. */
  day: string
  today: SaverTotals
  all: SaverTotals
  byNode: Record<string, SaverTotals>
  byMod: Record<string, SaverTotals>
  /** Newest first, capped. */
  rows: LedgerRow[]
  /** Lines that were not valid ledger lines. */
  skipped: number
}

export function emptyTotals(): SaverTotals {
  return { actions: 0, before: 0, after: 0, saved: 0, helperUsd: 0, usdSaved: 0, leftOut: 0 }
}

/** Prompt-cache clock for one agent session, derived from its transcript. */
export interface CacheClock {
  /** When the last main-chat reply ended, ms since epoch; 0 before any. */
  lastReplyAt: number
  /** 300000 (5 min) or 3600000 (1 h), from the cache write the reply made. */
  ttlMs: number
  /** Tokens the next request re-sends (the context size). */
  tokens: number
}
