// keep-warm: while DisTerm has turned it on for this node (~/.nodeterm/token-savers/keep-warm.json,
// `{ [nodeId]: { until, ttlMs } }`), a chat left idle gets one tiny `$.model.fork` shortly before
// its prompt cache would lapse. The fork re-sends the chat as the main thread last sent it, so the
// API reads it from the cache and the entry's clock starts over: the next real prompt then pays a
// cache read instead of writing the whole chat again.
//
// The fork names no `effort`. On a model that takes effort as a setting of the whole request, a
// level other than the session's would not read the main thread's entry at all: it writes an
// entry of its own (ModelForkRequest), which keeps nothing warm and costs a full write. The
// prompt asks for an instant one-word answer instead.

import type { EngineInterface, Register, Timer } from 'claude-code'
import { helperUsageCached, isModOn, recordSaving, saversPath } from './common'
import { PING_PROMPT, TICK_MS, adoptEntry, initialState, readEntry, shouldPing, type WarmState } from './schedule'

const MOD = 'keep-warm'

// One session per module load, so the state is the module's.
let state: WarmState = initialState()
let timer: Timer | null = null

async function tick($: EngineInterface): Promise<void> {
  if (state.isPinging) return
  if (!(await isModOn($, MOD))) return
  const nodeId = (await $.env.get('NODETERM_NODE_ID')) || ''
  if (!nodeId) return
  const path = await saversPath($, 'keep-warm.json')
  if (!path) return
  const text = await $.fs.read(path).catch(() => null)
  let all: unknown = null
  try {
    all = typeof text === 'string' ? JSON.parse(text) : null
  } catch {
    all = null
  }
  const entry =
    all && typeof all === 'object' && !Array.isArray(all) ? readEntry((all as Record<string, unknown>)[nodeId]) : null
  const now = await $.clock.now()
  state = adoptEntry(state, entry, now)
  if (shouldPing(state, entry, now).kind !== 'ping') return

  state = { ...state, isPinging: true }
  try {
    const reply = await $.model.fork({ prompt: PING_PROMPT })
    const at = await $.clock.now()
    if (!reply.isAnswered) {
      state = { ...state, failures: state.failures + 1 }
      return
    }
    state = { ...state, pings: state.pings + 1, failures: 0, lastAt: at }
    const model = await $.session.model().catch(() => '')
    await recordSaving($, {
      mod: MOD,
      tool_use_id: null,
      action: 'cache ping',
      before: 0,
      after: 0,
      helper: helperUsageCached(model || 'unknown', reply.usage),
      measured: 'real',
    })
  } finally {
    state = { ...state, isPinging: false }
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    timer?.cancel()
    state = initialState()
    timer = $.clock.every(TICK_MS, () => {
      tick($).catch(() => {
        state = { ...state, isPinging: false }
      })
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) state = { ...state, isBusy: true }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // a turn that sent no request (an interrupt before it, an API error) refreshed no cache
      const now = e.usage ? await $.clock.now().catch(() => Date.now()) : null
      state = { ...state, isBusy: false, ...(now !== null && { lastAt: now }) }
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
