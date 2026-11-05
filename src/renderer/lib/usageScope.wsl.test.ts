import { describe, expect, it } from 'vitest'
import type { Project, ProviderUsage, RemoteAccountUsage } from '@shared/types'
import { projectWslShell, scopeFromKey, scopeUsage, usagePillScopeKey, usageScopeKey } from './usageScope'

const project = (over: Partial<Project> = {}): Project => ({ id: 'p', name: 'p', nodes: [], ...over }) as Project
const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

describe('projectWslShell', () => {
  it.each([
    ['\\\\wsl.localhost\\Ubuntu\\home\\me', 'wsl:Ubuntu'],
    ['\\\\wsl$\\Debian\\srv', 'wsl:Debian'],
    ['//wsl.localhost/Ubuntu/home/me', 'wsl:Ubuntu'],
    ['\\\\WSL.LOCALHOST\\Ubuntu-22.04', 'wsl:Ubuntu-22.04']
  ])('reads the distribution from a project folder %s', (cwd, expected) => {
    expect(projectWslShell(project({ cwd }), undefined)).toBe(expected)
  })

  it('takes the folder over the default shell', () => {
    expect(projectWslShell(project({ cwd: UNC }), 'wsl:Debian')).toBe('wsl:Ubuntu')
  })

  it('then a Claude node stamped to run in one, not a plain WSL terminal', () => {
    const agent = { id: 'a', agentId: 'claude', shell: 'wsl:Debian' }
    const plain = { id: 'b', shell: 'wsl:Debian' }
    expect(projectWslShell(project({ nodes: [plain, agent] as never }), 'wsl:Ubuntu')).toBe('wsl:Debian')
    expect(projectWslShell(project({ nodes: [plain] as never }), undefined)).toBeNull()
  })

  it('then the default shell, for a project with no folder', () => {
    expect(projectWslShell(project(), 'wsl:Ubuntu')).toBe('wsl:Ubuntu')
    expect(projectWslShell(project({ cwd: 'C:\\repo' }), 'wsl:Ubuntu')).toBe('wsl:Ubuntu')
  })

  it('stays on this machine for a Windows folder and a Windows shell', () => {
    expect(projectWslShell(project({ cwd: 'C:\\repo' }), 'pwsh')).toBeNull()
    expect(projectWslShell(project(), '')).toBeNull()
  })

  it('leaves a project whose new sessions use a managed account on this machine', () => {
    expect(projectWslShell(project({ cwd: UNC, defaultAccountId: 'work' }), undefined)).toBeNull()
  })

  it('agrees with the spawn when a WSL default shell puts that account’s sessions in the distribution', () => {
    expect(projectWslShell(project({ defaultAccountId: 'work' }), 'wsl:Ubuntu')).toBe('wsl:Ubuntu')
  })

  it('lets the project’s own shell say first, either way', () => {
    expect(projectWslShell(project({ cwd: 'C:\\repo' }), 'pwsh', 'wsl:Debian')).toBe('wsl:Debian')
    expect(projectWslShell(project({ cwd: UNC }), 'wsl:Ubuntu', 'pwsh')).toBeNull()
    expect(projectWslShell(project(), 'wsl:Ubuntu', 'pwsh')).toBeNull()
  })

  it('still follows a Claude stamped into a distribution in a Windows-shell project', () => {
    const nodes = [{ id: 'a', agentId: 'claude', shell: 'wsl:Debian' }] as never
    expect(projectWslShell(project({ nodes }), undefined, 'pwsh')).toBe('wsl:Debian')
  })

  it('never claims an SSH project, a relay tab or no project', () => {
    const ssh = { server: { host: 'h', user: 'u', port: 22 }, remoteCwd: '/' }
    expect(projectWslShell(project({ cwd: UNC, ssh }), undefined)).toBeNull()
    expect(projectWslShell(project({ cwd: UNC, remote: {} as never }), undefined)).toBeNull()
    expect(projectWslShell(undefined, 'wsl:Ubuntu')).toBeNull()
  })

  it('refuses a malformed default rather than reading it as a distribution', () => {
    expect(projectWslShell(project(), 'wsl:-d')).toBeNull()
  })
})

describe('the pill key', () => {
  it('reads a distribution, while the session-memory key stays this machine', () => {
    const p = project({ cwd: UNC })
    expect(usagePillScopeKey(p, undefined)).toBe('wsl:Ubuntu')
    expect(usageScopeKey(p)).toBe('')
  })

  it('round-trips to its scope', () => {
    expect(scopeFromKey('wsl:Ubuntu')).toEqual({ kind: 'wsl', hostKey: 'wsl:Ubuntu' })
    expect(scopeFromKey('u@a')).toEqual({ kind: 'ssh', hostKey: 'u@a' })
    expect(scopeFromKey('')).toEqual({ kind: 'local' })
  })
})

describe('scopeUsage in a distribution', () => {
  const limit = { kind: 'weekly_all', group: 'weekly', usedPercent: 1, severity: null, resetsAt: null, windowMinutes: null, scopeLabel: null, isActive: false }
  const row: RemoteAccountUsage = {
    hostKey: 'wsl:Ubuntu',
    accountId: null,
    label: 'WSL: Ubuntu',
    usage: { limits: [limit], session: null, weekly: null, email: null, updatedAt: 1, status: 'ok' }
  }
  const cursor: ProviderUsage = { provider: 'cursor', limits: [limit], account: null, updatedAt: 1, status: 'ok' }
  const windows = { limits: [], session: null, weekly: null, email: null, updatedAt: 1, status: 'unavailable' as const }

  it('replaces this machine’s Claude and keeps the other providers', () => {
    const out = scopeUsage({
      scope: { kind: 'wsl', hostKey: 'wsl:Ubuntu' },
      claude: windows,
      accounts: [],
      providers: [cursor],
      remote: [row, { ...row, hostKey: 'wsl:Debian' }]
    })
    expect(out.claude).toBeNull()
    expect(out.remote).toEqual([row])
    expect(out.providers).toEqual([cursor])
    expect(out.pillLimits).toEqual([limit])
  })

  it('leaves an SSH host’s scope as it was, with no local providers', () => {
    const out = scopeUsage({
      scope: { kind: 'ssh', hostKey: 'wsl:Ubuntu' },
      claude: windows,
      accounts: [],
      providers: [cursor],
      remote: [row]
    })
    expect(out.providers).toEqual([])
  })
})
