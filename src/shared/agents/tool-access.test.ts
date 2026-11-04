import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/claude/tool-access-hook-payloads.json'
import { claudeToolAccess } from './tool-access'

const events = fixture.scenarios.skill_mcp_subagent_typed.events as Array<Record<string, unknown>>

describe('claudeToolAccess over the real 2.1.318 capture', () => {
  it('reads exactly the calls the capture holds, once each, and nothing else', () => {
    const got = events.map((e) => claudeToolAccess(e))
    expect(got.filter(Boolean)).toEqual([
      { target: 'skill', name: 'demo-skill' },
      { target: 'mcp', name: 'demo', tool: 'echo_it' },
      { target: 'mcp', name: 'demo', tool: 'echo_it', subId: 'aeb451d35b610d56d', subType: 'general-purpose' },
      { target: 'skill', name: 'demo-skill', subId: 'aeb451d35b610d56d', subType: 'general-purpose' },
      { target: 'skill', name: 'demo-skill', typed: true }
    ])
  })

  it('counts PreToolUse only: the PostToolUse of the same call is not a second access', () => {
    const post = events.filter((e) => e.hook_event_name === 'PostToolUse')
    expect(post.length).toBe(7)
    expect(post.map((e) => claudeToolAccess(e))).toEqual([null, null, null, null, null, null, null])
  })

  it('ignores ToolSearch, which only loads an MCP tool', () => {
    const search = events.find((e) => e.tool_name === 'ToolSearch' && e.hook_event_name === 'PreToolUse')!
    expect(claudeToolAccess(search)).toBeNull()
  })
})

const pre = (tool_name: string, tool_input: unknown = {}, extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_input,
  ...extra
})

describe('claudeToolAccess on hostile input', () => {
  it('keeps a plugin skill name as written', () => {
    expect(claudeToolAccess(pre('Skill', { skill: 'plugin:skill' }))).toEqual({ target: 'skill', name: 'plugin:skill' })
  })

  it('drops a name outside the alphabet whole instead of repairing it', () => {
    expect(claudeToolAccess(pre('Skill', { skill: '../../etc/passwd' }))).toBeNull()
    expect(claudeToolAccess(pre('Skill', { skill: 'a b' }))).toBeNull()
    expect(claudeToolAccess(pre('Skill', { skill: 'x\u001b[31m' }))).toBeNull()
    expect(claudeToolAccess(pre('Skill', { skill: 'x'.repeat(65) }))).toBeNull()
    expect(claudeToolAccess(pre('Skill', { skill: 7 }))).toBeNull()
    expect(claudeToolAccess(pre('Skill', null))).toBeNull()
  })

  it('takes the longest name that fits', () => {
    expect(claudeToolAccess(pre('Skill', { skill: 'x'.repeat(64) }))).toEqual({ target: 'skill', name: 'x'.repeat(64) })
  })

  it('drops an MCP server or tool outside the alphabet', () => {
    expect(claudeToolAccess(pre('mcp__a b__c'))).toBeNull()
    expect(claudeToolAccess(pre('mcp__a__c d'))).toBeNull()
    expect(claudeToolAccess(pre('mcp__a'))).toBeNull()
    expect(claudeToolAccess(pre('mcp____c'))).toBeNull()
    expect(claudeToolAccess(pre(`mcp__${'s'.repeat(65)}__t`))).toBeNull()
  })

  it('splits at the first separator, so a tool with underscores keeps them', () => {
    expect(claudeToolAccess(pre('mcp__claude_ai_Notion__notion-search'))).toEqual({ target: 'mcp', name: 'claude_ai_Notion', tool: 'notion-search' })
  })

  it('never carries tool arguments or the prompt', () => {
    const got = claudeToolAccess(pre('mcp__demo__echo_it', { text: 'ghp_SECRET' }))
    expect(JSON.stringify(got)).not.toContain('ghp_SECRET')
    const typed = claudeToolAccess({ hook_event_name: 'UserPromptSubmit', prompt: '/demo-skill my token is ghp_SECRET' })
    expect(typed).toEqual({ target: 'skill', name: 'demo-skill', typed: true })
  })

  it('reads a typed slash command only when the prompt starts with a name', () => {
    expect(claudeToolAccess({ hook_event_name: 'UserPromptSubmit', prompt: '/etc/passwd' })).toBeNull()
    expect(claudeToolAccess({ hook_event_name: 'UserPromptSubmit', prompt: ' /demo' })).toBeNull()
    expect(claudeToolAccess({ hook_event_name: 'UserPromptSubmit', prompt: 'please run /demo' })).toBeNull()
    expect(claudeToolAccess({ hook_event_name: 'UserPromptSubmit', prompt: `/${'x'.repeat(65)}` })).toBeNull()
    expect(claudeToolAccess({ hook_event_name: 'UserPromptSubmit', prompt: '/plugin:skill args' })).toEqual({
      target: 'skill',
      name: 'plugin:skill',
      typed: true
    })
  })

  it('drops a subagent id that is not a token, but keeps the access', () => {
    expect(claudeToolAccess(pre('Skill', { skill: 'a' }, { agent_id: '../x', agent_type: 'general-purpose' }))).toEqual({ target: 'skill', name: 'a' })
  })

  it('bounds the subagent type to one short line', () => {
    const got = claudeToolAccess(pre('Skill', { skill: 'a' }, { agent_id: 'abc123', agent_type: `line\nbreak${'y'.repeat(100)}` }))
    expect(got!.subType).toHaveLength(64)
    expect(got!.subType).not.toContain('\n')
  })

  it('ignores everything that is not an object or another event', () => {
    expect(claudeToolAccess(null)).toBeNull()
    expect(claudeToolAccess('Skill')).toBeNull()
    expect(claudeToolAccess({ hook_event_name: 'Stop', tool_name: 'Skill', tool_input: { skill: 'a' } })).toBeNull()
  })
})
