// model-router: before a subagent starts, Haiku judges how capable a model its task needs, and an
// easy task moves to a cheaper model (a hard one to a stronger one). It works only at
// `agent.spawn`, so the main conversation's model is never touched.
//
// The model a spawn "would run on" is taken as the parent's: the event does not say whether the
// agent's own definition names a model, and setting `model` here overrides that definition the
// way the Agent tool's own `model` parameter does. No dollar figure is written: what a subagent
// costs is known only after it ran, and an estimate up front would not be honest.

import type { Register } from 'claude-code'
import { helperUsage, isModOn, recordSaving } from './common'
import { JUDGE_SYSTEM, actionText, configFrom, decide, isRoutable, judgePrompt, parseVerdict } from './policy'

const MOD = 'model-router'
const JUDGE = 'haiku'

export const register: Register = (on, options) => {
  const cfg = configFrom(options)

  on('agent.spawn', async ($, e, next) => {
    if (!isRoutable(e)) return next(e)
    if (!(await isModOn($, MOD))) return next(e)

    const current = e.parentModel
    const reply = await $.model.complete({
      model: JUDGE,
      system: JUDGE_SYSTEM,
      prompt: judgePrompt(e),
      maxTokens: 200,
      timeoutMs: cfg.timeoutMs,
    })
    const verdict = reply.isAnswered ? parseVerdict(reply.text) : null
    const decision = decide(current, verdict, cfg)

    const started = await next(decision.model ? { ...e, model: decision.model } : e)
    if (started.deny === undefined && (reply.isAnswered || reply.usage.input_tokens > 0)) {
      await recordSaving($, {
        mod: MOD,
        tool_use_id: e.tool_use_id || null,
        action: actionText(current, decision),
        before: 0,
        after: 0,
        helper: helperUsage(JUDGE, reply.usage),
        measured: 'real',
      })
    }
    return started
  }).catch(($, e, next) => next(e)) // a failed judge leaves the spawn as the Agent call made it
}
