import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/claude/file-edit-hook-payloads.json'
import { FILE_EDIT_PATH_MAX, FILE_EDIT_TOOLS, claudeFileEdit } from './file-edit'

const events = fixture.scenarios.edit_write_subagent.events as Array<Record<string, unknown>>

describe('claudeFileEdit over the real 2.1.322 capture', () => {
  it('the capture holds Pre and Post of each Edit/Write call', () => {
    expect(events).toHaveLength(8)
    expect(events.map((e) => `${e.hook_event_name}:${e.tool_name}`)).toEqual([
      'PreToolUse:Write',
      'PostToolUse:Write',
      'PreToolUse:Edit',
      'PostToolUse:Edit',
      'PreToolUse:Write',
      'PostToolUse:Write',
      'PreToolUse:Write',
      'PostToolUse:Write'
    ])
  })

  it('reads the path of every PostToolUse, with the subagent on its own event', () => {
    expect(events.map((e) => claudeFileEdit(e))).toEqual([
      null,
      { path: '/fixture-repo/src/api/server.go', cwd: '/fixture-repo' },
      null,
      { path: '/fixture-repo/src/api/server.go', cwd: '/fixture-repo' },
      null,
      { path: '/fixture-repo/scripts/tool.sh', cwd: '/fixture-repo' },
      null,
      { path: '/fixture-repo/src/db/schema.sql', cwd: '/fixture-repo', subId: 'a404fab851c0d8e25', subType: 'general-purpose' }
    ])
  })

  it('PreToolUse is the same call again, never a second edit', () => {
    const pre = events.filter((e) => e.hook_event_name === 'PreToolUse')
    expect(pre).toHaveLength(4)
    expect(pre.map((e) => claudeFileEdit(e))).toEqual([null, null, null, null])
  })
})

const post = (tool_name: string, tool_input: unknown, extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name,
  tool_input,
  ...extra
})

describe('claudeFileEdit on hostile input', () => {
  it('only Edit and Write', () => {
    expect([...FILE_EDIT_TOOLS].sort()).toEqual(['Edit', 'Write'])
    for (const tool of ['NotebookEdit', 'MultiEdit', 'Read', 'Bash', 'edit', 'mcp__fs__write']) {
      expect(claudeFileEdit(post(tool, { file_path: '/r/a' }))).toBeNull()
    }
    expect(claudeFileEdit(post('Edit', { file_path: '/r/a' }))).toEqual({ path: '/r/a' })
  })

  it('a missing, non-string, empty, over-long or NUL path is no edit', () => {
    expect(claudeFileEdit(post('Write', {}))).toBeNull()
    expect(claudeFileEdit(post('Write', null))).toBeNull()
    expect(claudeFileEdit(post('Write', 'file_path'))).toBeNull()
    expect(claudeFileEdit(post('Write', { file_path: 7 }))).toBeNull()
    expect(claudeFileEdit(post('Write', { file_path: ['/a'] }))).toBeNull()
    expect(claudeFileEdit(post('Write', { file_path: '' }))).toBeNull()
    expect(claudeFileEdit(post('Write', { file_path: `/${'a'.repeat(FILE_EDIT_PATH_MAX)}` }))).toBeNull()
    expect(claudeFileEdit(post('Write', { file_path: `/${'a'.repeat(FILE_EDIT_PATH_MAX - 1)}` }))).toEqual({ path: `/${'a'.repeat(FILE_EDIT_PATH_MAX - 1)}` })
    expect(claudeFileEdit(post('Write', { file_path: '/r/a\0b' }))).toBeNull()
  })

  it('a non-object payload, or no tool name, is null', () => {
    expect(claudeFileEdit(null)).toBeNull()
    expect(claudeFileEdit('PostToolUse')).toBeNull()
    expect(claudeFileEdit({ hook_event_name: 'PostToolUse', tool_input: { file_path: '/a' } })).toBeNull()
  })

  it('a bad cwd is left out, the path is kept', () => {
    expect(claudeFileEdit(post('Write', { file_path: 'a' }, { cwd: 7 }))).toEqual({ path: 'a' })
    expect(claudeFileEdit(post('Write', { file_path: 'a' }, { cwd: '' }))).toEqual({ path: 'a' })
    expect(claudeFileEdit(post('Write', { file_path: 'a' }, { cwd: '/r\0x' }))).toEqual({ path: 'a' })
    expect(claudeFileEdit(post('Write', { file_path: 'a' }, { cwd: '/r' }))).toEqual({ path: 'a', cwd: '/r' })
  })

  it('a bad agent_id gives no subagent', () => {
    expect(claudeFileEdit(post('Write', { file_path: '/a' }, { agent_id: '../x', agent_type: 'general-purpose' }))).toEqual({ path: '/a' })
    expect(claudeFileEdit(post('Write', { file_path: '/a' }, { agent_id: 42 }))).toEqual({ path: '/a' })
    expect(claudeFileEdit(post('Write', { file_path: '/a' }, { agent_id: 'a404fab851c0d8e25' }))).toEqual({ path: '/a', subId: 'a404fab851c0d8e25' })
  })
})
