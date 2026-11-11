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
import { PING_PROMPT, TICK_MS, adoptEntry, initialState, pingFoundLapse, readEntry, shouldPing, type WarmState } from './schedule'

const MOD = 'keep-warm'

// One session per module load, so the state is the module's.
let state: WarmState = initialState()
let timer: Timer | null = null
let turnStartedAt = 0

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
    // The cache entry's clock restarts when the request READS it, i.e. when it is sent, so the time
    // is taken before the fork: a slow reply must not push the next ping past the lapse.
    const sentAt = await $.clock.now()
    const reply = await $.model.fork({ prompt: PING_PROMPT })
    if (!reply.isAnswered) {
      state = { ...state, failures: state.failures + 1 }
      return
    }
    state = { ...state, pings: state.pings + 1, failures: 0, lastAt: sentAt, isLapsed: pingFoundLapse(reply.usage) }
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
    if (e.agentId === undefined) {
      turnStartedAt = await $.clock.now().catch(() => Date.now())
      state = { ...state, isBusy: true }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Each main-thread request reads the cache as it is SENT: stamp the time there, not when the turn
  // completes, which can be a minute later for a long answer.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const now = await $.clock.now().catch(() => Date.now())
      state = { ...state, lastAt: now }
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // A turn whose requests raised no `turn.step` (a host that does not stream steps) still used
      // the cache if it reports usage: stamp it now, late but better than not at all.
      const unstamped = !!e.usage && state.lastAt < turnStartedAt
      const now = unstamped ? await $.clock.now().catch(() => Date.now()) : 0
      state = { ...state, isBusy: false, ...(unstamped && { lastAt: now }) }
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
