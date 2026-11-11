import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import { initialState, shouldPing } from '../hooks/schedule'

const TTL = 300_000
const T0 = 1_000_000
const USAGE = { input_tokens: 12, output_tokens: 2, cache_read_input_tokens: 60000, cache_creation_input_tokens: 0 }
const MAIN_USAGE = { ...USAGE, model: 'claude-opus-5-5' }

type Fork = 'ok' | 'fail' | 'lapse'

function world(on: On, opts: { entry?: unknown; fork?: Fork; switches?: string } = {}) {
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  const forks: { prompt: string; effort?: string }[] = []
  let entry: unknown = opts.entry === undefined ? { until: T0 + 10 * 3600_000, ttlMs: TTL } : opts.entry
  mock.env(on, { HOME: '/home/u', NODETERM_NODE_ID: 'n1' })
  const clock = mock.clock(on, { now: T0 })
  on('fs.stat', () =>
    opts.switches === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: 10, mtimeMs: 1, isLink: false } },
  )
  on('fs.read', (_$, e) => {
    if (e.path.endsWith('switches.json')) return { value: opts.switches ?? '{}' }
    expect(e.path).toBe('/home/u/.nodeterm/token-savers/keep-warm.json')
    return { value: JSON.stringify({ n1: entry }) }
  })
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.fork', (_$, e) => {
    forks.push({ prompt: e.prompt, effort: e.effort })
    return {
      value: (opts.fork === 'fail'
        ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }
        : opts.fork === 'lapse'
          ? { isAnswered: true, text: 'OK', usage: { ...USAGE, cache_read_input_tokens: 0, cache_creation_input_tokens: 60000 } }
          : { isAnswered: true, text: 'OK', usage: USAGE }) as never,
    }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const ledger = () => runs.filter((r) => r.argv.join(' ').includes('cat >>')).map((r) => JSON.parse(r.stdin ?? '{}'))
  return { forks, ledger, clock, setEntry: (v: unknown) => (entry = v) }
}

async function chatReplied($: Engine, turnId = 't1') {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId } as never)
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId, reason: 'answer', usage: MAIN_USAGE } as never)
}

test('an idle chat gets one ping just before its cache would lapse', async ($, on) => {
  const w = world(on)
  await chatReplied($)
  await w.clock.advance(240_000)
  expect(w.forks.length).toBe(0)
  await w.clock.advance(15_000) // 255 s: inside the last 45 s
  expect(w.forks.length).toBe(1)
  expect(w.forks[0]?.effort).toBe(undefined)
  const line = w.ledger()[0]
  expect(line.mod).toBe('keep-warm')
  expect(line.action).toBe('cache ping')
  expect(line.before).toBe(0)
  expect(line.helper.cache_read).toBe(60000)
  expect(line.measured).toBe('real')
  await w.clock.advance(240_000) // the ping restarted the clock
  expect(w.forks.length).toBe(1)
  await w.clock.advance(15_000)
  expect(w.forks.length).toBe(2)
})

test('no ping while a turn is running', async ($, on) => {
  const w = world(on)
  await chatReplied($)
  await $.turn.start({ text: 'long job', turnId: 't2' } as never)
  await w.clock.advance(600_000)
  expect(w.forks.length).toBe(0)
})

test('no ping for a node that is not turned on', async ($, on) => {
  const w = world(on, { entry: null })
  await chatReplied($)
  await w.clock.advance(600_000)
  expect(w.forks.length).toBe(0)
})

test('a cache that already lapsed is not pinged', async ($, on) => {
  const w = world(on, { entry: null })
  await chatReplied($)
  await w.clock.advance(300_000)
  w.setEntry({ until: T0 + 10 * 3600_000, ttlMs: TTL }) // turned on after the cache went cold
  await w.clock.advance(300_000)
  expect(w.forks.length).toBe(0)
})

test('three failed pings in a row end the opt-in', async ($, on) => {
  const w = world(on, { fork: 'fail' })
  await chatReplied($)
  await w.clock.advance(299_000)
  expect(w.forks.length).toBe(3)
  expect(w.ledger().length).toBe(0)
})

test('the opt-in ends at its until', async ($, on) => {
  const w = world(on, { entry: { until: T0 + 200_000, ttlMs: TTL } })
  await chatReplied($)
  await w.clock.advance(600_000)
  expect(w.forks.length).toBe(0)
})

test('switched off: no ping', async ($, on) => {
  const w = world(on, { switches: '{"keep-warm":false}' })
  await chatReplied($)
  await w.clock.advance(600_000)
  expect(w.forks.length).toBe(0)
})

test('shouldPing: the window, the caps', () => {
  const entry = { until: 1e12, ttlMs: TTL }
  const s = { ...initialState(), lastAt: 1000, optIn: entry.until, optInSeenAt: 1000 }
  expect(shouldPing(s, entry, 1000 + 200_000).kind).toBe('wait')
  expect(shouldPing(s, entry, 1000 + 256_000).kind).toBe('ping')
  expect(shouldPing(s, entry, 1000 + 300_000).kind).toBe('wait')
  expect(shouldPing({ ...s, pings: 30 }, entry, 1000 + 256_000).kind).toBe('done')
  expect(shouldPing({ ...s, failures: 3 }, entry, 1000 + 256_000).kind).toBe('done')
  expect(shouldPing({ ...s, isBusy: true }, entry, 1000 + 256_000).kind).toBe('wait')
  expect(shouldPing(s, { ...entry, until: 500 }, 1000).kind).toBe('done')
  expect(shouldPing({ ...s, optInSeenAt: 0 }, entry, 2 * 3600_000).kind).toBe('done')
  expect(shouldPing(s, null, 1000 + 256_000).kind).toBe('wait')
})

test('a ping that finds the cache lapsed ends the opt-in: it would only re-write the chat again', async ($, on) => {
  const w = world(on, { fork: 'lapse' })
  await chatReplied($)
  await w.clock.advance(255_000)
  expect(w.forks.length).toBe(1)
  await w.clock.advance(600_000)
  expect(w.forks.length).toBe(1)
})
