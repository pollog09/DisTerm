import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

const DOC = '# Handoff\n## Goal\nShip the parser.\n## Next steps\n1. Run the tests.'
const USAGE = { input_tokens: 50, output_tokens: 900, cache_read_input_tokens: 80000, cache_creation_input_tokens: 2000 }

type Fork = { isAnswered: true; text: string; usage: typeof USAGE } | { isAnswered: false; reason: string; usage?: typeof USAGE }

function world(on: On, fork: Fork, opts: { switches?: string; node?: string } = {}) {
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  const writes: { path: string; text: string }[] = []
  const forks: { prompt: string; effort?: string }[] = []
  mock.env(on, opts.node === undefined ? { HOME: '/home/u', NODETERM_NODE_ID: 'node-7' } : { HOME: '/home/u' })
  mock.clock(on, { now: 1_700_000_000_000 })
  on('fs.stat', () =>
    opts.switches === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: 10, mtimeMs: 1, isLink: false } },
  )
  on('fs.read', () => ({ value: opts.switches ?? '' }))
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.fork', (_$, e) => {
    forks.push({ prompt: e.prompt, effort: e.effort })
    return { value: fork as never }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const ledger = () => runs.filter((r) => r.argv.join(' ').includes('cat >>')).map((r) => JSON.parse(r.stdin ?? '{}'))
  return { writes, forks, ledger }
}

async function runHandoff($: Engine) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return $.command.run({ command: 'handoff', args: '' } as never)
}

test('/handoff writes the fork\'s document and records it', async ($, on) => {
  const w = world(on, { isAnswered: true, text: DOC, usage: USAGE })
  const said = await runHandoff($)
  expect(w.forks.length).toBe(1)
  expect(w.forks[0]?.effort).toBeUndefined() // the session's own level keeps the cache entry
  expect(w.writes.length).toBe(1)
  const path = '/home/u/.nodeterm/token-savers/handoffs/node-7-1700000000000.md'
  expect(w.writes[0]?.path).toBe(path)
  expect(w.writes[0]?.text).toContain('Ship the parser.')
  expect(said.text).toContain(path)
  expect(said.text).toContain('new agent node')
  const line = w.ledger()[0]
  expect(line.mod).toBe('handoff')
  expect(line.action).toBe('handoff')
  expect(line.before).toBe(82050)
  expect(line.after).toBe(Math.ceil((DOC.length + 1) / 4))
  expect(line.file).toBe(path)
  expect(line.helper.cache_read).toBe(80000)
  expect(line.helper.in).toBe(2050)
  expect(line.measured).toBe('estimated')
})

test('nothing to fork: says so and writes nothing', async ($, on) => {
  const w = world(on, { isAnswered: false, reason: 'nothing-to-fork' })
  const said = await runHandoff($)
  expect(said.text).toContain('nothing to summarize')
  expect(w.writes.length).toBe(0)
  expect(w.ledger().length).toBe(0)
})

test('an API error: says so and writes nothing', async ($, on) => {
  const w = world(on, { isAnswered: false, reason: 'api-error', usage: USAGE })
  const said = await runHandoff($)
  expect(said.text).toContain('failed')
  expect(w.writes.length).toBe(0)
  expect(w.ledger().length).toBe(0)
})

test('switched off: the command says so and forks nothing', async ($, on) => {
  const w = world(on, { isAnswered: true, text: DOC, usage: USAGE }, { switches: '{"handoff":false}' })
  const said = await runHandoff($)
  expect(said.text).toContain('switched off')
  expect(w.forks.length).toBe(0)
  expect(w.writes.length).toBe(0)
})

test('outside DisTerm the file is named after the session', async ($, on) => {
  const w = world(on, { isAnswered: true, text: DOC, usage: USAGE }, { node: '' })
  await runHandoff($)
  const path = w.writes[0]?.path ?? ''
  expect(path.startsWith('/home/u/.nodeterm/token-savers/handoffs/')).toBe(true)
  expect(path.includes('node-7')).toBe(false)
  expect(path.endsWith('-1700000000000.md')).toBe(true)
})
