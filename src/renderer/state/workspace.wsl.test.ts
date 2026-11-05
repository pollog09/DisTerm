import { beforeEach, describe, expect, it } from 'vitest'
import { UNKNOWN_CLAUDE_CLI_CAPS, type ClaudeCliCaps } from '@shared/types'
import { resetClaudeCliCapsForTests, resetWslClaudeCliCapsForTests } from './permissionMode'
import { createAgentNode } from './workspace'

const CAPS: ClaudeCliCaps = { version: '2.1.318', autoPermissionMode: true, fullscreenTui: true, sessionIdFlag: true }
const create = (wslShell?: string) =>
  createAgentNode('claude', 0, '\\\\wsl.localhost\\Ubuntu\\repo', undefined, undefined, undefined, undefined, 'auto', undefined, undefined, undefined, undefined, wslShell)

describe('a Claude node in a distribution', () => {
  beforeEach(() => {
    resetWslClaudeCliCapsForTests()
    resetClaudeCliCapsForTests(UNKNOWN_CLAUDE_CLI_CAPS)
  })

  it('stamps the shell, and mints a session id from the CLI in there', () => {
    resetWslClaudeCliCapsForTests('wsl:Ubuntu', CAPS)
    const node = create('wsl:Ubuntu')
    expect(node.data.shell).toBe('wsl:Ubuntu')
    expect(node.data.agentSessionId).toBeTruthy()
    expect(node.data.initialCommand).toContain('--session-id')
  })

  it('opens the bare line when that CLI has not answered, so a launch never blocks', () => {
    const node = create('wsl:Ubuntu')
    expect(node.data.agentSessionId).toBeUndefined()
    expect(node.data.initialCommand).not.toContain('--session-id')
  })

  it('never takes this machine’s answer for it', () => {
    resetClaudeCliCapsForTests(CAPS)
    expect(create('wsl:Ubuntu').data.agentSessionId).toBeUndefined()
    expect(create().data.agentSessionId).toBeTruthy()
  })

  it('carries no Windows launch plan: the pane reads POSIX', () => {
    resetWslClaudeCliCapsForTests('wsl:Ubuntu', CAPS)
    expect(create('wsl:Ubuntu').data.launchIntent).toBeUndefined()
  })

  it('leaves a Windows node without a shell', () => {
    expect(create().data.shell).toBeUndefined()
  })
})
