import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 400, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function world(on: On, judge: string | null) {
  const spawned: { model?: string; parentModel?: string }[] = []
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  let asked = 0
  mock.env(on, { HOME: '/home/u' })
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', () => {
    asked++
    return {
      value:
        judge === null
          ? { isAnswered: false, reason: 'aborted', usage: { ...USAGE, input_tokens: 0, output_tokens: 0 } }
          : { isAnswered: true, text: judge, usage: USAGE },
    }
  })
  on('agent.spawn', (_$, e) => {
    spawned.push({ model: e.model, parentModel: e.parentModel })
    return { model: e.model ?? e.parentModel ?? 'claude-opus-5-5', agentId: 'a1' }
  })
  return { spawned, runs, asked: () => asked }
}

const TASK = { parentModel: 'claude-opus-5-5', prompt: 'List the files under src/ and say which are tests.', description: 'List files', subagentType: 'general-purpose' }

test('a confident easy verdict moves the subagent to the light model', async ($, on) => {
  const w = world(on, '{"tier":"light","confidence":0.9,"why":"lookup"}')
  await $.agent.spawn(TASK as never)
  const parent = w.spawned[0]?.parentModel ?? ''
  expect(parent).toMatch(/opus|sonnet/i)
  expect(w.spawned[0]?.model).toBe('claude-haiku-5-5')
  const line = JSON.parse(w.runs.find((r) => r.argv.join(' ').includes('cat >>'))?.stdin ?? '{}')
  expect(line.mod).toBe('model-router')
  expect(line.before).toBe(0)
  expect(line.helper.in).toBe(400)
  expect(w.asked()).toBe(1)
})

test('an unsure easy verdict does not move it down', async ($, on) => {
  const w = world(on, '{"tier":"light","confidence":0.4}')
  await $.agent.spawn(TASK as never)
  expect(w.spawned[0]?.model).toBe(undefined)
})

test('a verdict with no confidence never moves it down', async ($, on) => {
  const w = world(on, '{"tier":"light"}')
  await $.agent.spawn(TASK as never)
  expect(w.spawned[0]?.model).toBe(undefined)
})

test('a model the Agent call chose is left alone, and the judge is not asked', async ($, on) => {
  const w = world(on, '{"tier":"light","confidence":0.99}')
  await $.agent.spawn({ ...TASK, model: 'sonnet' } as never)
  expect(w.spawned[0]?.model).toBe('sonnet')
  expect(w.asked()).toBe(0)
})

test('a judge that fails leaves the spawn as it was and writes nothing', async ($, on) => {
  const w = world(on, null)
  await $.agent.spawn(TASK as never)
  expect(w.spawned[0]?.model).toBe(undefined)
  expect(w.runs.length).toBe(0)
})

test('the configured light model is the one used', { options: { lightModel: 'my-haiku' } }, async ($, on) => {
  const w = world(on, '{"tier":"light","confidence":0.95}')
  await $.agent.spawn(TASK as never)
  const parent = w.spawned[0]?.parentModel ?? ''
  expect(parent).toMatch(/opus|sonnet/i)
  expect(w.spawned[0]?.model).toBe('my-haiku')
})

test('a hard task on a standard parent moves up at the lower bar', async ($, on) => {
  const w = world(on, '{"tier":"heavy","confidence":0.35}')
  await $.agent.spawn({ ...TASK, parentModel: 'claude-sonnet-5-5' } as never)
  expect(w.spawned[0]?.model).toBe('claude-opus-5-5')
})

test('an agent with its own definition is never routed: it may name its own model', async ($, on) => {
  const w = world(on, '{"tier":"light","confidence":0.99,"why":"lookup"}')
  await $.agent.spawn({ ...TASK, subagentType: 'Explore' } as never)
  expect(w.asked()).toBe(0)
  expect(w.spawned[0]?.model).toBeUndefined()
})
