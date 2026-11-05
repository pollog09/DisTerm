import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNKNOWN_CLAUDE_CLI_CAPS, type ClaudeCliCaps } from '@shared/types'
import { ensureWslClaudeCliCaps, resetWslClaudeCliCapsForTests, wslClaudeCliCapsNow } from './permissionMode'
import { resetProjectLaunchInfoForTests, ensureProjectLaunchInfo, trustedProjectShell } from './projectLaunchInfo'

const CAPS: ClaudeCliCaps = { version: '2.1.318', autoPermissionMode: true, fullscreenTui: true, sessionIdFlag: true }

function stub(api: Record<string, unknown>): void {
  vi.stubGlobal('window', { nodeTerminal: api })
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetWslClaudeCliCapsForTests()
  resetProjectLaunchInfoForTests()
})

describe('ensureWslClaudeCliCaps', () => {
  beforeEach(() => resetWslClaudeCliCapsForTests())

  it('asks once for many callers at once, and remembers a found CLI', async () => {
    const wslCliCaps = vi.fn(async () => CAPS)
    stub({ claude: { wslCliCaps } })
    await Promise.all(Array.from({ length: 20 }, () => ensureWslClaudeCliCaps('wsl:Ubuntu')))
    expect(wslCliCaps).toHaveBeenCalledTimes(1)
    await ensureWslClaudeCliCaps('wsl:Ubuntu')
    expect(wslCliCaps).toHaveBeenCalledTimes(1)
    expect(wslClaudeCliCapsNow('wsl:Ubuntu')).toEqual(CAPS)
  })

  it('never lets a must-not-boot ask stand in for one that may boot', async () => {
    const wslCliCaps = vi.fn(async () => UNKNOWN_CLAUDE_CLI_CAPS)
    stub({ claude: { wslCliCaps } })
    await Promise.all([ensureWslClaudeCliCaps('wsl:Ubuntu', { ifRunning: true }), ensureWslClaudeCliCaps('wsl:Ubuntu')])
    expect(wslCliCaps).toHaveBeenCalledTimes(2)
  })

  it('asks again after a miss, since the distribution may not have been up', async () => {
    const wslCliCaps = vi.fn(async () => UNKNOWN_CLAUDE_CLI_CAPS)
    stub({ claude: { wslCliCaps } })
    await ensureWslClaudeCliCaps('wsl:Ubuntu')
    await ensureWslClaudeCliCaps('wsl:Ubuntu')
    expect(wslCliCaps).toHaveBeenCalledTimes(2)
  })

  it('resolves to the unknown when the call rejects', async () => {
    stub({ claude: { wslCliCaps: async () => { throw new Error('nope') } } })
    await expect(ensureWslClaudeCliCaps('wsl:Ubuntu')).resolves.toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
  })
})

describe('trustedProjectShell', () => {
  const load = async (shell: unknown, trusted: boolean): Promise<void> => {
    stub({
      projectSettings: {
        launchInfo: async () => ({
          resolved: { terminal: { shell }, agents: {}, setup: {} },
          trusted: { agents: true, shell: trusted }
        })
      }
    })
    await ensureProjectLaunchInfo('p')
  }

  it('answers a local value whatever the shared trust says', async () => {
    await load({ value: 'wsl:Ubuntu', source: 'local' }, false)
    expect(trustedProjectShell('p')).toBe('wsl:Ubuntu')
  })

  it('answers a shared value only once it is trusted, as the spawn does', async () => {
    await load({ value: 'wsl:Ubuntu', source: 'shared' }, false)
    expect(trustedProjectShell('p')).toBeUndefined()
    resetProjectLaunchInfoForTests()
    await load({ value: 'wsl:Ubuntu', source: 'shared' }, true)
    expect(trustedProjectShell('p')).toBe('wsl:Ubuntu')
  })

  it('has nothing to say before the info is warm, or for no project', () => {
    expect(trustedProjectShell('p')).toBeUndefined()
    expect(trustedProjectShell(undefined)).toBeUndefined()
  })
})
