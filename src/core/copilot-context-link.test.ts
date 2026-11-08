// copilot's leg of context-link: the locator, the events.jsonl parser, and the capability.
//
// FIXTURE PROVENANCE: `__fixtures__/copilot/events.jsonl` is cut from a REAL copilot 1.0.105 session
// (2026-10-31): 22 lines chosen to cover every event family the journal holds (session.start,
// user/assistant messages, tool start/complete with a success and a denied call, turn markers,
// usage, notifications, shutdown). Home paths, project names, session and message UUIDs were
// redacted, long strings truncated and reasoning/usage payloads dropped; no key was invented. The
// one hand-added line is a truncated assistant.message, to exercise the malformed-line counter.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { canContextLink } from '../shared/agents/config'
import { linesFromCopilot, renderContextLink, renderTranscriptLines } from './context-link-render'
import { locateCopilot } from './handoff/locate'
import { testTmpDir } from './test-tmp'
import type { LinkDoc } from './context-link-core'

const fixture = fs.readFileSync(path.join(__dirname, '__fixtures__/copilot/events.jsonl'), 'utf8')
const SID = '11111111-2222-4333-8444-555555555555'

describe('canContextLink', () => {
  it('copilot is context-link capable', () => {
    expect(canContextLink('copilot')).toBe(true)
  })
})

describe('locateCopilot', () => {
  let home = ''
  beforeEach(() => {
    home = testTmpDir('copilot-link-')
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('COPILOT_HOME', path.join(home, '.copilot'))
  })
  afterEach(() => vi.unstubAllEnvs())

  const write = (id: string): string => {
    const dir = path.join(home, '.copilot', 'session-state', id)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'events.jsonl')
    fs.writeFileSync(p, fixture)
    return p
  }

  it('resolves the session\'s own events.jsonl and no other session\'s', async () => {
    const mine = write(SID)
    write('99999999-2222-4333-8444-555555555555')
    expect(await locateCopilot(SID)).toBe(mine)
  })

  it('is undefined for a session with no journal yet', async () => {
    expect(await locateCopilot(SID)).toBeUndefined()
  })

  it('refuses ids that could leave session-state, even when the target file exists', async () => {
    write(SID)
    fs.mkdirSync(path.join(home, '.copilot', 'escape'), { recursive: true })
    fs.writeFileSync(path.join(home, '.copilot', 'escape', 'events.jsonl'), fixture)
    for (const bad of ['../escape', `../${SID}`, `${SID}/../${SID}`, '/etc/passwd', '..', '.', '', 'a\0b', `${SID}\n`]) {
      expect(await locateCopilot(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})

describe('linesFromCopilot over a real events.jsonl', () => {
  const lines = linesFromCopilot(fixture)

  it('renders the prompt as typed, assistant text, tool calls and their results in file order', () => {
    expect(lines[0]).toBe('user: Read the incident file and fix the export helper.')
    expect(lines[1]).toMatch(/^assistant: Voy a leer el incidente/)
    expect(lines[2]).toMatch(/^ {2}\$ bash cat /)
    expect(lines[3]).toBe('  = Permission to run this tool was denied due to the following rules: `shell`')
    expect(lines.filter((l) => l.startsWith('  $ view '))).toHaveLength(2)
    expect(lines.some((l) => l.startsWith('  $ grep '))).toBe(true)
  })

  it('does not echo tool calls twice (toolRequests repeats tool.execution_start)', () => {
    expect(lines.filter((l) => l.startsWith('  $ bash'))).toHaveLength(1)
  })

  it('renders nothing for the system prompt, notifications, usage or shutdown events', () => {
    const text = lines.join('\n')
    expect(text).not.toContain('system prompt omitted')
    expect(text).not.toContain('Discovered instruction')
    expect(text).not.toContain('totalPremiumRequests')
  })

  it('skips an unreadable line without throwing and counts it', () => {
    expect(linesFromCopilot.skipped(fixture)).toBe(1)
  })

  it('is tolerant of junk, wrong shapes and unknown events', () => {
    const junk = [
      '',
      'not json',
      '[]',
      'null',
      '42',
      '{"type":"user.message"}',
      '{"type":"user.message","data":null}',
      '{"type":"assistant.message","data":{"content":{"x":1}}}',
      '{"type":"tool.execution_start","data":{"arguments":null}}',
      '{"type":"tool.execution_complete","data":{"result":"oops","error":7}}',
      '{"type":"future.event","data":{"content":"ignored"}}'
    ].join('\n')
    expect(() => linesFromCopilot(junk)).not.toThrow()
    expect(linesFromCopilot(junk)).toEqual(['  $ tool'])
  })

  it('hides sub-agent events and user messages the CLI timeline hides', () => {
    const buf = [
      '{"type":"user.message","data":{"content":"typed"}}',
      '{"type":"user.message","data":{"content":"skill body","source":"skill-foo"}}',
      '{"type":"assistant.message","data":{"content":"from child","parentToolCallId":"t1"}}',
      '{"type":"assistant.message","agentId":"a1","data":{"content":"from child 2"}}',
      '{"type":"assistant.message","data":{"content":"main"}}'
    ].join('\n')
    expect(linesFromCopilot(buf)).toEqual(['user: typed', 'assistant: main'])
  })

  it('renderTranscriptLines routes agent "copilot" to this parser', () => {
    expect(renderTranscriptLines('copilot', fixture)).toEqual(lines)
  })
})

describe('renderContextLink for a copilot node', () => {
  const doc: LinkDoc = {
    self: { id: 'me' },
    links: [{ id: 'cp', title: 'Copilot', cwd: '/home/user/project', transcriptPath: '/x/events.jsonl', tmux: '', agent: 'copilot', sessionId: SID }],
    tmuxBin: null,
    tmuxSocket: 's'
  }
  const fetch = { transcript: async () => fixture, terminal: async () => '', opencodeExport: async () => null }

  it('summary and transcript carry the conversation', async () => {
    const summary = await renderContextLink(doc, 'summary', { node: 'cp' }, fetch)
    expect(summary).toContain('user: Read the incident file')
    const full = await renderContextLink(doc, 'transcript', { node: 'cp' }, fetch)
    expect(full).toContain('assistant: Voy a leer el incidente')
  })
})
