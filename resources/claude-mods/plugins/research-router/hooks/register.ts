// research-router: gives the main model a `Research` tool. A call starts a general-purpose
// subagent on Haiku that searches, reads the pages and writes a short brief; the brief is the
// tool's result, so the main chat reads a few hundred tokens instead of every page.
//
// The model is named explicitly (`haiku`), so model-router leaves the spawn alone.
//
// Waiting for the answer. `$.agent.spawn` resolves once the subagent started; its answer is its
// own `turn.complete`. A hook's time budget (10 s) runs while it awaits a promise of its own, and
// stops only while a `$` call is in flight, a `$.clock` wait excepted. So the tool waits by
// polling: a short host `sleep` per round, the answer checked between rounds. The run is told
// apart by `agentId`, and by a tag in its prompt that its first `turn.start` carries.

import type { EngineInterface, ModelUsage, Register } from 'claude-code'
import { estimateTokens, helperUsageCached, isModOn, isWindows, promptTokens, recordSaving } from './common'
import {
  INPUT_SCHEMA,
  NESTED_TEXT,
  OFF_TEXT,
  POLL_SECONDS,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  WAIT_MS,
  cleanQuestion,
  failedText,
  researchPrompt,
  resultText,
  runTag,
  timeoutText,
} from './brief'

const MOD = 'research-router'
const HELPER = 'haiku'

interface Run {
  tag: string
  agentId: string | null
  answer: string | null
  isAborted: boolean
  usage: ModelUsage | null
}

// One session per module load, so these are the module's.
let toolName = `mcp__${MOD}__${TOOL_NAME}`
let runCount = 0
const runs = new Map<string, Run>() // by tag
const runOfAgent = new Map<string, string>() // agentId -> tag

/** Waits one polling round on the host: a `$` call, so it does not run down the hook's budget. */
async function nap($: EngineInterface): Promise<boolean> {
  const argv = (await isWindows($))
    ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', `Start-Sleep -Seconds ${POLL_SECONDS}`]
    : ['sleep', String(POLL_SECONDS)]
  const ran = await $.process.run(argv, { timeoutMs: POLL_SECONDS * 1000 + 10000 }).catch(() => null)
  // A sleep that exits non-zero (missing, refused) did not wait: count it as a failed nap, so the
  // loop gives up instead of spinning until the deadline.
  return ran !== null && ran.exitCode === 0
}

async function waitForAnswer($: EngineInterface, run: Run, signal: AbortSignal): Promise<'answered' | 'timeout' | 'aborted'> {
  const deadline = (await $.clock.now()) + WAIT_MS
  let failedNaps = 0
  for (;;) {
    if (run.answer !== null) return 'answered'
    if (signal.aborted) return 'aborted'
    if ((await $.clock.now()) >= deadline) return 'timeout'
    if (!(await nap($))) {
      failedNaps++
      if (failedNaps >= 3) return 'timeout'
    }
  }
}

async function research($: EngineInterface, question: string, toolUseId: string, signal: AbortSignal): Promise<string> {
  const tag = runTag(await $.clock.now(), ++runCount)
  const run: Run = { tag, agentId: null, answer: null, isAborted: false, usage: null }
  runs.set(tag, run)
  try {
    const started = await $.agent.spawn({
      prompt: researchPrompt(question, tag),
      description: 'Research a question',
      subagentType: 'general-purpose',
      model: HELPER,
    })
    if (started.deny !== undefined) return failedText(started.deny)
    if (started.agentId) {
      run.agentId = started.agentId
      runOfAgent.set(started.agentId, tag)
    }

    const outcome = await waitForAnswer($, run, signal)
    if (outcome === 'timeout') return timeoutText(Math.round(WAIT_MS / 60000))
    if (outcome === 'aborted') return resultText('', true)

    const brief = resultText(run.answer ?? '', run.isAborted)
    if (run.answer && run.answer.trim()) {
      const used = run.usage ? promptTokens(run.usage) + (run.usage.output_tokens || 0) : 0
      await recordSaving($, {
        mod: MOD,
        tool_use_id: toolUseId || null,
        action: 'research',
        before: used > 0 ? used : estimateTokens(brief.length) * 10,
        after: estimateTokens(brief.length),
        helper: helperUsageCached(HELPER, run.usage ?? undefined),
        measured: used > 0 ? 'real' : 'estimated',
      })
    }
    return brief
  } finally {
    runs.delete(tag)
    if (run.agentId) runOfAgent.delete(run.agentId)
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const done = await $.tool
      .register({ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
      .catch(() => null)
    if (done?.tool) toolName = done.tool
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (String(e.tool) !== toolName) return next(e)
    if (!(await isModOn($, MOD))) return { result: OFF_TEXT }
    if (e.agentId && runOfAgent.has(e.agentId)) return { result: NESTED_TEXT }
    const question = cleanQuestion((e as Record<string, unknown>).question)
    if (!question) return { result: 'Research needs a question: { "question": "..." }.' }
    return { result: await research($, question, e.tool_use_id, next.signal) }
  }).catch(($, e, next) =>
    String(e.tool) === toolName ? { result: failedText('the tool failed') } : next(e),
  )

  on('turn.start', ($, e, next) => {
    if (e.agentId && !runOfAgent.has(e.agentId)) {
      for (const run of runs.values()) {
        if (run.agentId === null && e.text.includes(run.tag)) {
          run.agentId = e.agentId
          runOfAgent.set(e.agentId, run.tag)
          break
        }
      }
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    const tag = e.agentId ? runOfAgent.get(e.agentId) : undefined
    const run = tag ? runs.get(tag) : undefined
    if (run && run.answer === null) {
      run.answer = e.answer
      run.isAborted = e.isAborted
      run.usage = e.usage ?? null
    }
    return next(e)
  })
}
