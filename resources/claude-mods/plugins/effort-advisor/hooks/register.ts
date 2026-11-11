// effort-advisor: each prompt the person sends is rated by Haiku for the effort level it needs,
// and the latest rating for this node goes to ~/.nodeterm/token-savers/effort.json, where
// DisTerm's context meter offers the switch. The mod never changes the effort itself.
//
// The prompt is never held up: it is passed on first (`next(e)`), and the rating runs afterwards
// on a timer of its own, so a slow or failed judge costs nothing but the suggestion.

import type { EngineInterface, Register } from 'claude-code'
import { asciiJson, helperUsage, isModOn, recordSaving, saversPath, writeWhole } from './common'
import {
  JUDGE_MAX_TOKENS,
  JUDGE_SYSTEM,
  JUDGE_TIMEOUT_MS,
  isJudged,
  judgePrompt,
  mergeSuggestions,
  parseSuggestion,
} from './advice'

const MOD = 'effort-advisor'
const JUDGE = 'haiku'

async function rate($: EngineInterface, text: string, nodeId: string): Promise<void> {
  if (!(await isModOn($, MOD))) return
  const reply = await $.model.complete({
    model: JUDGE,
    system: JUDGE_SYSTEM,
    prompt: judgePrompt(text),
    maxTokens: JUDGE_MAX_TOKENS,
    effort: 'low',
    timeoutMs: JUDGE_TIMEOUT_MS,
  })
  if (!reply.isAnswered) return
  const now = await $.clock.now()
  const suggestion = parseSuggestion(reply.text, now)
  if (!suggestion) return

  const path = await saversPath($, 'effort.json')
  if (!path) return
  const previous = await $.fs.read(path).catch(() => null)
  const merged = mergeSuggestions(typeof previous === 'string' ? previous : null, nodeId, suggestion, now)
  if (!(await writeWhole($, path, asciiJson(merged) + '\n'))) return

  await recordSaving($, {
    mod: MOD,
    tool_use_id: null,
    action: `suggest ${suggestion.level}`,
    before: 0,
    after: 0,
    helper: helperUsage(JUDGE, reply.usage),
    measured: 'real',
  })
}

export const register: Register = (on) => {
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop !== undefined) return entered
    if (!isJudged(e.text, { isCommand: e.command !== undefined, isMeta: e.isMeta === true })) return entered
    const nodeId = (await $.env.get('NODETERM_NODE_ID').catch(() => undefined)) || ''
    if (!nodeId) return entered
    const text = e.text
    $.clock.after(0, () => {
      rate($, text, nodeId).catch(() => undefined)
    })
    return entered
  }).catch(($, e, next) => next(e)) // the prompt goes on whatever the advisor did
}
