import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 300, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const NOW = 1_700_000_000_000
const LONG = 'Find why the websocket reconnect loop leaks timers and fix it with a test.'

function world(on: On, judge: string | null, opts: { file?: string; node?: string; switches?: string } = {}) {
  const order: string[] = []
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  const writes: { path: string; text: string }[] = []
  mock.env(on, opts.node === '' ? { HOME: '/home/u' } : { HOME: '/home/u', NODETERM_NODE_ID: opts.node ?? 'n1' })
  const clock = mock.clock(on, { now: NOW })
  on('fs.stat', () =>
    opts.switches === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: 10, mtimeMs: 1, isLink: false } },
  )
  on('fs.read', (_$, e) => {
    if (e.path.endsWith('switches.json')) return { value: opts.switches ?? '{}' }
    return opts.file === undefined ? { deny: 'ENOENT' } : { value: opts.file }
  })
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', (_$, e) => {
    order.push('judge')
    expect(e.model).toBe('haiku')
    expect(e.effort).toBe('low')
    return {
      value:
        judge === null
          ? { isAnswered: false, reason: 'aborted', usage: { ...USAGE, input_tokens: 0, output_tokens: 0 } }
          : { isAnswered: true, text: judge, usage: USAGE },
    }
  })
  on('prompt.submit', (_$, e) => {
    order.push('entered')
    return { text: e.text }
  })
  const ledger = () => runs.filter((r) => r.argv.join(' ').includes('cat >>')).map((r) => JSON.parse(r.stdin ?? '{}'))
  return { order, writes, ledger, clock }
}

const submit = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never

test('the prompt enters first; the suggestion lands in effort.json afterwards', async ($, on) => {
  const w = world(on, '{"level":"high","why":"unknown cause across files"}')
  const r = await $.prompt.submit(submit(LONG))
  expect(r.text).toBe(LONG)
  expect(w.order).toEqual(['entered'])
  await w.clock.settle()
  expect(w.order).toEqual(['entered', 'judge'])
  expect(w.writes[0]?.path).toBe('/home/u/.nodeterm/token-savers/effort.json')
  const file = JSON.parse(w.writes[0]?.text ?? '{}')
  expect(file.n1).toEqual({ level: 'high', why: 'unknown cause across files', at: NOW })
  const line = w.ledger()[0]
  expect(line.action).toBe('suggest high')
  expect(line.before).toBe(0)
  expect(line.after).toBe(0)
  expect(line.helper.in).toBe(300)
  expect(line.measured).toBe('real')
})

test('other nodes keep their entries; stale ones are dropped', async ($, on) => {
  const file = JSON.stringify({
    other: { level: 'low', why: 'x', at: NOW - 1000 },
    old: { level: 'max', why: 'y', at: NOW - 25 * 3600 * 1000 },
    n1: { level: 'low', why: 'before', at: NOW - 5000 },
  })
  const w = world(on, '{"level":"medium","why":"ordinary change"}', { file })
  await $.prompt.submit(submit(LONG))
  await w.clock.settle()
  const out = JSON.parse(w.writes[0]?.text ?? '{}')
  expect(Object.keys(out).sort()).toEqual(['n1', 'other'])
  expect(out.n1.level).toBe('medium')
})

test('short prompts and slash commands are not judged', async ($, on) => {
  const w = world(on, '{"level":"low","why":"x"}')
  await $.prompt.submit(submit('yes go on'))
  await $.prompt.submit(submit('/compact please keep the test plan in mind'))
  await w.clock.settle()
  expect(w.order).toEqual(['entered', 'entered'])
  expect(w.writes.length).toBe(0)
})

test('outside DisTerm (no node id) nothing is judged', async ($, on) => {
  const w = world(on, '{"level":"low","why":"x"}', { node: '' })
  await $.prompt.submit(submit(LONG))
  await w.clock.settle()
  expect(w.order).toEqual(['entered'])
})

test('a failed or unreadable judge writes nothing and the prompt still entered', async ($, on) => {
  const w = world(on, 'I think it is fairly hard')
  const r = await $.prompt.submit(submit(LONG))
  await w.clock.settle()
  expect(r.text).toBe(LONG)
  expect(w.writes.length).toBe(0)
  expect(w.ledger().length).toBe(0)
})

test('switched off: no judge call', async ($, on) => {
  const w = world(on, '{"level":"low","why":"x"}', { switches: '{"effort-advisor":false}' })
  await $.prompt.submit(submit(LONG))
  await w.clock.settle()
  expect(w.order).toEqual(['entered'])
})
