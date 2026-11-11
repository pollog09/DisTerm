import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

// The test runtime has timers; the plugin type root declares none.
declare function setTimeout(fn: () => void, ms: number): unknown

const BRIEF = 'Answer: v5 is current.\nKey facts:\n- Released in May [1]\nSources:\n1. Changelog - https://example.org/changelog\nNot confirmed: nothing'
const SUB_USAGE = { input_tokens: 4000, output_tokens: 600, cache_read_input_tokens: 30000, cache_creation_input_tokens: 5000, model: 'claude-haiku-5-5' }
const TOOL = 'mcp__research-router__Research'

interface Opts {
  /** What the subagent answers; null: it never does. */
  answer?: string | null
  switches?: string
  usage?: typeof SUB_USAGE | null
}

function world($: Engine, on: On, opts: Opts = {}) {
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  const spawns: { prompt: string; model?: string; subagentType?: string }[] = []
  const tools: { name: string; isDeferred?: unknown }[] = []
  mock.env(on, { HOME: '/home/u', NODETERM_NODE_ID: 'n1' })
  const clock = mock.clock(on, { now: 5_000_000 })
  on('fs.stat', () =>
    opts.switches === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: 10, mtimeMs: 1, isLink: false } },
  )
  on('fs.read', () => ({ value: opts.switches ?? '{}' }))
  on('process.run', async (_$, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    if (e.argv[0] === 'sleep') {
      // a real sleep, short, so the subagent's timer gets its turn; the mocked clock moves the 2 s
      await new Promise<void>((r) => setTimeout(() => r(), 2))
      await clock.advance(2000)
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.register', (_$, e) => {
    tools.push({ name: e.name, isDeferred: e.isDeferred })
    return { value: { tool: TOOL } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.spawn', (_$, e) => {
    spawns.push({ prompt: e.prompt, model: e.model, subagentType: e.subagentType })
    const answer = opts.answer === undefined ? BRIEF : opts.answer
    if (answer !== null) {
      // the subagent runs on its own: its turn starts with the prompt, then ends with the brief
      setTimeout(async () => {
        await $.turn.start({ text: e.prompt, turnId: 'st1', agentId: 'sub-1' } as never)
        await $.turn.complete({
          answer,
          durationMs: 900,
          isAborted: false,
          turnId: 'st1',
          reason: 'answer',
          agentId: 'sub-1',
          ...(opts.usage !== null && { usage: opts.usage ?? SUB_USAGE }),
        } as never)
      }, 30)
    }
    return { model: e.model ?? 'haiku', agentId: 'ignored' }
  })
  const ledger = () => runs.filter((r) => r.argv.join(' ').includes('cat >>')).map((r) => JSON.parse(r.stdin ?? '{}'))
  return { spawns, tools, ledger }
}

async function ask($: Engine, question: unknown) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return (await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', question } as never)) as { result: string }
}

test('the tool is registered up front, not behind ToolSearch', async ($, on) => {
  const w = world($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(w.tools).toEqual([{ name: 'Research', isDeferred: false }])
})

test('a question goes to a Haiku subagent and its brief is the result', async ($, on) => {
  const w = world($, on)
  const r = await ask($, 'What is the current major version of the foo library?')
  expect(r.result).toBe(BRIEF)
  expect(w.spawns.length).toBe(1)
  expect(w.spawns[0]?.model).toBe('haiku')
  // the engine's default agent type; the test kit hands it on as unset
  expect([undefined, 'general-purpose'].includes(w.spawns[0]?.subagentType)).toBe(true)
  expect(w.spawns[0]?.prompt).toContain('current major version of the foo library')
  const line = w.ledger()[0]
  expect(line.mod).toBe('research-router')
  expect(line.action).toBe('research')
  expect(line.tool_use_id).toBe('tu1')
  expect(line.before).toBe(4000 + 30000 + 5000 + 600)
  expect(line.after).toBe(Math.ceil(BRIEF.length / 4))
  expect(line.helper).toEqual({ model: 'haiku', in: 9000, out: 600, cache_read: 30000 })
  expect(line.measured).toBe('real')
})

test('without usage the saving is an estimate', async ($, on) => {
  const w = world($, on, { usage: null })
  await ask($, 'Which regions does service X run in today?')
  const line = w.ledger()[0]
  expect(line.measured).toBe('estimated')
  expect(line.before).toBe(Math.ceil(BRIEF.length / 4) * 10)
})

test('a subagent that never answers times out and says so', { timeoutMs: 10000 }, async ($, on) => {
  const w = world($, on, { answer: null })
  const r = await ask($, 'Which regions does service X run in today?')
  expect(r.result).toContain('did not finish within 5 minutes')
  expect(w.ledger().length).toBe(0)
})

test('switched off: the tool says so and spawns nothing', async ($, on) => {
  const w = world($, on, { switches: '{"research-router":false}' })
  const r = await ask($, 'Which regions does service X run in today?')
  expect(r.result).toContain('switched off')
  expect(w.spawns.length).toBe(0)
})

test('a call without a question spawns nothing', async ($, on) => {
  const w = world($, on)
  const r = await ask($, '   ')
  expect(r.result).toContain('needs a question')
  expect(w.spawns.length).toBe(0)
})

test('other tools pass through untouched', async ($, on) => {
  world($, on)
  on('tool.call', () => ({ result: { stdout: 'hi' } }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = (await $.tool.call({ tool: 'mcp__other__thing', tool_use_id: 'x' } as never)) as { result: unknown }
  expect(r.result).toEqual({ stdout: 'hi' })
})
