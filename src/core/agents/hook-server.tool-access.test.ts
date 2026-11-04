// A claude POST naming a skill or an MCP server reaches the agent graph's log, from the one place
// both shells share, and reaches nothing else. The payloads are the real 2.1.318 capture.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fixture from '../../shared/agents/__fixtures__/claude/tool-access-hook-payloads.json'
import { agentGraphLog } from '../agent-graph/event-log'
import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { testTmpDir } from '../test-tmp'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'

const events = fixture.scenarios.skill_mcp_subagent_typed.events as Array<Record<string, unknown>>
const at = (i: number): Record<string, unknown> => events[i]
let normalized: NormalizedAgentEvent[] = []

function post(agent: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/${agent}`, {
    method: 'POST',
    headers: { 'X-Nodeterm-Hook-Token': hookServer.getToken(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
  })
}
const send = (agent: string, payload: Record<string, unknown>, extra: Record<string, string> = {}) =>
  post(agent, { nodeId: 'term-a', payload: JSON.stringify(payload), ...extra })
const access = () => agentGraphLog.snapshot().events.filter((e) => e.kind === 'access')

beforeAll(async () => {
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: testTmpDir('hooksrv-access-') }))
  await hookServer.start()
  hookServer.setListener((e) => { normalized.push(e) })
  hookServer.setPaneTtyResolver(async () => '/dev/pts/3')
})
afterAll(() => {
  hookServer.setPaneTtyResolver(undefined)
  hookServer.stop()
})
beforeEach(() => {
  normalized = []
  agentGraphLog.clear()
  hookServer.forgetPaneOrigin('term-a')
})

describe('skill and MCP accesses on the hook route', () => {
  it('a claude Skill call and an MCP call reach the log, once each, with their names', async () => {
    await send('claude', at(1))
    await send('claude', at(2)) // the PostToolUse of the same call
    await send('claude', at(5))
    expect(access()).toMatchObject([
      { id: 'access:term-a::skill:demo-skill', nodeId: 'term-a', target: 'skill', name: 'demo-skill', count: 1 },
      { id: 'access:term-a::mcp:demo', target: 'mcp', name: 'demo', tool: 'echo_it', count: 1 }
    ])
  })

  it('a child event reaches the log with its subagent AND still produces no agent-status event', async () => {
    await send('claude', at(11)) // mcp__demo__echo_it from the subagent
    expect(access()).toMatchObject([{ subId: 'aeb451d35b610d56d', subType: 'general-purpose', target: 'mcp', name: 'demo' }])
    expect(normalized).toEqual([])
  })

  it('a typed /name is a skill access and still an ordinary prompt for the mirror', async () => {
    await send('claude', at(16))
    expect(access()).toMatchObject([{ target: 'skill', name: 'demo-skill', typed: true }])
    expect(normalized.map((e) => e.kind)).toEqual(['state'])
  })

  it('a non-claude agent records nothing', async () => {
    await send('codex', at(1))
    await send('gemini', at(5))
    expect(access()).toEqual([])
  })

  it('a claude that only inherited the node id (gate drops it) counts for nobody', async () => {
    await send('claude', at(1), { nodeterm_claude_pid: '777', nodeterm_claude_fg: '0', nodeterm_claude_tty: '' })
    expect(access()).toEqual([])
  })

  it('the pane\'s own claude counts', async () => {
    await send('claude', at(1), { nodeterm_claude_pid: '100', nodeterm_claude_fg: '1', nodeterm_claude_tty: 'pts/3' })
    expect(access()).toHaveLength(1)
  })

  it('a hostile name is dropped, and the POST still ends 204', async () => {
    const res = await send('claude', { hook_event_name: 'PreToolUse', tool_name: 'mcp__a b__c', tool_input: { token: 'ghp_SECRET' } })
    expect(res.status).toBe(204)
    expect(access()).toEqual([])
  })

  it('no argument value ever reaches the log', async () => {
    await send('claude', { hook_event_name: 'PreToolUse', tool_name: 'mcp__demo__echo_it', tool_input: { text: 'ghp_SECRET' } })
    expect(JSON.stringify(agentGraphLog.snapshot())).not.toContain('ghp_SECRET')
  })
})
