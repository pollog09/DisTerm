/**
 * The `browser` verb's RETRY table, for the agent-facing docs — the same discipline the messaging
 * verbs get from `RETRYABLE` (`src/core/agents/agent-message-decide.ts`): whether an outcome is
 * worth retrying is DATA, not prose the skill text re-types by hand and lets drift.
 *
 * WHERE THE REFUSALS ACTUALLY LIVE. The driving refusal STRINGS are decided main-side, in
 * `src/main/browser-drive.ts` (the gate), `src/main/browser-actions.ts` (per-action outcomes) and
 * `src/server/control-unsupported.ts` (the Server Edition). This file does not restate those strings
 * — it classifies the OUTCOMES an agent can hit into "retry can clear this" vs "terminal", so
 * `buildCanvasSkillBody` / `buildCanvasControlInstructions` render the guidance from the table and
 * `canvas-control-core.test.ts` reddens if a new bucket is documented without landing here first.
 * It is `src/core` (no electron, both shells compile it), so the doc generator stays electron-free.
 *
 * The classification is honest about what a language model should DO, not about HTTP shape: a switch
 * the agent cannot flip is terminal even though a human could change it, and a discarded page is
 * "retryable" only in the sense that a small act (bring it on screen, open a new one) clears it — the
 * label says which act, so the retry is directed rather than blind.
 */
export type BrowserOutcomeKind =
  // --- worth retrying: a transient or lifecycle state a retry, or a small named act, clears ---
  | 'canvasSlow'
  | 'pageDiscarded'
  | 'staleRef'
  | 'offScreen'
  | 'didNotAppear'
  // --- terminal: the cause will not clear by re-sending the same call ---
  | 'notVerified'
  | 'switchOff'
  | 'notDrivable'
  | 'userStopped'
  | 'unsupportedEdition'

/**
 * `Record<BrowserOutcomeKind, boolean>` makes the table exhaustive BY THE TYPE: a new outcome kind
 * fails to compile until it is classified here, which is what keeps the rendered doc complete.
 */
export const BROWSER_RETRYABLE: Record<BrowserOutcomeKind, boolean> = {
  canvasSlow: true,
  pageDiscarded: true,
  staleRef: true,
  offScreen: true,
  didNotAppear: true,
  notVerified: false,
  switchOff: false,
  notDrivable: false,
  userStopped: false,
  unsupportedEdition: false
}

/**
 * The human phrase the doc renders for each outcome. Every retryable one names the act that clears
 * it, so an agent retries with a plan rather than hammering the identical call.
 */
export const BROWSER_OUTCOME_LABEL: Record<BrowserOutcomeKind, string> = {
  canvasSlow: 'the canvas was slow to answer — send the same call again',
  pageDiscarded: 'the page was released to save memory while hidden — bring the node on screen, or open a new one',
  staleRef: 'a @ref went stale after a navigation — re-read the map and use the new refs',
  offScreen: 'the target is off-screen — scroll it into view first',
  didNotAppear: 'a --wait target has not appeared yet — wait again or raise --timeout',
  notVerified: 'the caller is not identity-verified (`Browser control refused.`)',
  switchOff: 'browser control is off for this project — you cannot turn it on, ask the user',
  notDrivable: 'the node is not a browser node you opened this run — open one with `open-browser` first',
  userStopped: 'the user stopped agent control of this node — it stays stopped until they re-enable it',
  unsupportedEdition: 'there is no browser control on the DisTerm Server Edition — permanent, never retry'
}
