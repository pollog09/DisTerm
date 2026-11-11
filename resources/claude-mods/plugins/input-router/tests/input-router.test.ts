import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const BIG = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}: ${'x'.repeat(30)}`).join('\n')
const NOTES = 'A list of 2000 numbered lines. L1-L2000 all hold x.'
const USAGE = { input_tokens: 9000, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function readResult(content: string) {
  return {
    result: {
      type: 'text',
      file: { filePath: '/p/big.txt', content, numLines: 2000, startLine: 1, totalLines: 2000 },
    },
  }
}

/** The world beneath the plugin: a home, a shell that records what it is given, a Haiku. */
function world(on: On, opts: { haiku?: 'ok' | 'fail'; switches?: string } = {}) {
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  const asks: string[] = []
  const writes: string[] = []
  mock.env(on, { HOME: '/home/u' })
  on('fs.stat', () =>
    opts.switches === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file', size: 10, mtimeMs: 1, isLink: false } },
  )
  on('fs.read', () => ({ value: opts.switches ?? '' }))
  on('fs.write', (_$, e) => {
    writes.push(e.path)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', (_$, e) => {
    asks.push(e.prompt)
    return {
      value:
        opts.haiku === 'fail'
          ? { isAnswered: false, reason: 'empty-reply', usage: USAGE }
          : { isAnswered: true, text: NOTES, usage: USAGE },
    }
  })
  return { runs, asks, writes }
}

test('a large whole-file Read comes back as notes and a pointer', async ($, on) => {
  const w = world(on)
  on('tool.call', () => readResult(BIG))
  const r = (await $.tool.call({ tool: 'Read', file_path: '/p/big.txt' })) as { result: { file: { content: string } } }
  expect(r.result.file.content).toContain('[input-router]')
  expect(r.result.file.content).toContain('offset and limit')
  expect(w.asks.length).toBe(1)
  expect(w.asks[0]).toContain('1| line 1:')
  const ledger = w.runs.find((run) => run.argv.join(' ').includes('cat >>'))
  expect(ledger?.argv[4]).toBe('/home/u/.nodeterm/token-savers/savings.jsonl')
  const line = JSON.parse(ledger?.stdin ?? '{}')
  expect(line.mod).toBe('input-router')
  expect(line.helper.model).toBe('haiku')
  expect(line.before > line.after).toBe(true)
})

test('a Read that asked for a slice passes untouched', async ($, on) => {
  const w = world(on)
  on('tool.call', () => readResult(BIG))
  const r = (await $.tool.call({ tool: 'Read', file_path: '/p/big.txt', offset: 10, limit: 50 })) as {
    result: { file: { content: string } }
  }
  expect(r.result.file.content).toBe(BIG)
  expect(w.asks.length).toBe(0)
})

test('a small file passes untouched', async ($, on) => {
  const w = world(on)
  on('tool.call', () => readResult('short'))
  const r = (await $.tool.call({ tool: 'Read', file_path: '/p/big.txt' })) as { result: { file: { content: string } } }
  expect(r.result.file.content).toBe('short')
  expect(w.asks.length).toBe(0)
})

test('when Haiku fails the tool result is returned as it was', async ($, on) => {
  const w = world(on, { haiku: 'fail' })
  on('tool.call', () => readResult(BIG))
  const r = (await $.tool.call({ tool: 'Read', file_path: '/p/big.txt' })) as { result: { file: { content: string } } }
  expect(r.result.file.content).toBe(BIG)
  expect(w.runs.length).toBe(0)
})

test('switched off, the mod does nothing', async ($, on) => {
  const w = world(on, { switches: '{"input-router": false}' })
  on('tool.call', () => readResult(BIG))
  const r = (await $.tool.call({ tool: 'Read', file_path: '/p/big.txt' })) as { result: { file: { content: string } } }
  expect(r.result.file.content).toBe(BIG)
  expect(w.asks.length).toBe(0)
})

test('a large connector result is saved whole and answered with notes', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: [{ type: 'text', text: BIG }] }))
  const r = (await $.tool.call({ tool: 'mcp__docs__fetch', id: 1 })) as { result: { type: string; text: string }[] }
  expect(r.result.length).toBe(1)
  expect(r.result[0]?.text).toContain('/home/u/.nodeterm/token-savers/full/')
  expect(r.result[0]?.text).toContain(NOTES)
  expect(w.writes.length).toBe(1)
})

test('a plain cat of a large file comes back as notes', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: { stdout: BIG, stderr: '', interrupted: false } }))
  const r = (await $.tool.call({ tool: 'Bash', command: 'cat /p/big.txt' })) as { result: { stdout: string } }
  expect(r.result.stdout).toContain('[input-router]')
  expect(r.result.stdout).toContain(NOTES)
})

test('a cat in a pipeline is not touched', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { stdout: BIG, stderr: '', interrupted: false } }))
  const r = (await $.tool.call({ tool: 'Bash', command: 'cat /p/big.txt | head' })) as { result: { stdout: string } }
  expect(r.result.stdout).toBe(BIG)
  expect(w.asks.length).toBe(0)
})

test('/input-router full lets the next large read through whole, once', async ($, on) => {
  const w = world(on)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => readResult(BIG))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const said = await $.command.run({ command: 'input-router', args: 'full' } as never)
  expect(said.text).toContain('whole')
  const first = (await $.tool.call({ tool: 'Read', file_path: '/p/big.txt' })) as { result: { file: { content: string } } }
  expect(first.result.file.content).toBe(BIG)
  const second = (await $.tool.call({ tool: 'Read', file_path: '/p/big.txt' })) as { result: { file: { content: string } } }
  expect(second.result.file.content).toContain('[input-router]')
  expect(w.asks.length).toBe(1)
})
