import { beforeEach, describe, expect, it } from 'vitest'
import {
  mayStartWslTerminal,
  paneRunsInWsl,
  useWslTerminals,
  wslShellForNewAgent,
  wslTerminalsForProject
} from './wslTerminals'
import { useProjects } from './projects'

const WINDOWS_PROFILES = [
  { value: '', label: 'System default', kind: 'default' as const },
  { value: 'pwsh', label: 'PowerShell 7', kind: 'windows' as const },
  { value: 'wsl:Ubuntu', label: 'WSL: Ubuntu', kind: 'wsl' as const }
]
const UBUNTU = [{ label: 'WSL: Ubuntu', shell: 'wsl:Ubuntu' }]

function projects(list: Array<Record<string, unknown>>): void {
  useProjects.setState({ projects: list as never, activeProjectId: list[0]?.id as string })
}

describe('the WSL rows every new-terminal surface reads', () => {
  beforeEach(() => useWslTerminals.getState().publish([]))

  it('keeps only the distributions', () => {
    useWslTerminals.getState().publish(WINDOWS_PROFILES)
    expect(useWslTerminals.getState().rows).toEqual(UBUNTU)
  })

  it('offers nothing when the core lists no profiles, which is every core but Windows', () => {
    projects([{ id: 'local', nodes: [] }])
    useWslTerminals.getState().publish([])
    expect(wslTerminalsForProject('local')).toEqual([])
  })

  it('offers them for a project on this machine', () => {
    projects([{ id: 'local', nodes: [] }])
    useWslTerminals.getState().publish(WINDOWS_PROFILES)
    expect(wslTerminalsForProject('local')).toEqual(UBUNTU)
  })

  it('never offers them for another core: an SSH project, a relay tab or an unknown id', () => {
    projects([
      { id: 'ssh', nodes: [], ssh: { server: {}, remoteCwd: '/srv' } },
      { id: 'relay', nodes: [], remote: true }
    ])
    useWslTerminals.getState().publish(WINDOWS_PROFILES)
    expect(wslTerminalsForProject('ssh')).toEqual([])
    expect(wslTerminalsForProject('relay')).toEqual([])
    expect(wslTerminalsForProject('gone')).toEqual([])
    expect(wslTerminalsForProject(undefined)).toEqual([])
  })

  it('refuses a start with no project behind it', () => {
    expect(mayStartWslTerminal(undefined)).toBe(false)
    expect(mayStartWslTerminal(null)).toBe(false)
    expect(mayStartWslTerminal({})).toBe(true)
  })
})

describe('wslShellForNewAgent', () => {
  const local = {}
  it('takes the row the person picked over the default shell', () => {
    expect(wslShellForNewAgent('claude', 'wsl:Debian', 'wsl:Ubuntu', local)).toBe('wsl:Debian')
  })

  it('follows a WSL default shell, which is where the pane starts anyway', () => {
    expect(wslShellForNewAgent('claude', undefined, 'wsl:Ubuntu', local)).toBe('wsl:Ubuntu')
  })

  it('stays on this machine with a Windows default', () => {
    expect(wslShellForNewAgent('claude', undefined, 'pwsh', local)).toBeUndefined()
    expect(wslShellForNewAgent('claude', undefined, '', local)).toBeUndefined()
  })

  it('leaves every other agent as it was: their hooks are not wired in a distribution', () => {
    expect(wslShellForNewAgent('codex', 'wsl:Ubuntu', 'wsl:Ubuntu', local)).toBeUndefined()
  })

  it('honours the project’s own shell over the default, as the spawn does', () => {
    expect(wslShellForNewAgent('claude', undefined, 'wsl:Ubuntu', local, 'pwsh')).toBeUndefined()
    expect(wslShellForNewAgent('claude', undefined, 'pwsh', local, 'wsl:Debian')).toBe('wsl:Debian')
    expect(wslShellForNewAgent('claude', 'wsl:Ubuntu', 'pwsh', local, 'pwsh')).toBe('wsl:Ubuntu')
  })

  it('never applies to a project on another machine', () => {
    expect(wslShellForNewAgent('claude', 'wsl:Ubuntu', undefined, { ssh: {} as never })).toBeUndefined()
    expect(wslShellForNewAgent('claude', undefined, 'wsl:Ubuntu', { remote: {} as never })).toBeUndefined()
    expect(wslShellForNewAgent('claude', undefined, 'wsl:Ubuntu', undefined)).toBeUndefined()
  })
})

describe('paneRunsInWsl', () => {
  it('answers as the spawn resolves it: the node, then the default', () => {
    expect(paneRunsInWsl({ shell: 'wsl:Ubuntu' }, undefined)).toBe(true)
    expect(paneRunsInWsl({}, 'wsl:Ubuntu')).toBe(true)
    expect(paneRunsInWsl({ shell: '' }, 'wsl:Ubuntu')).toBe(true)
    expect(paneRunsInWsl({ shell: 'pwsh' }, 'wsl:Ubuntu')).toBe(false)
    expect(paneRunsInWsl({}, '')).toBe(false)
    expect(paneRunsInWsl(undefined, 'wsl:Ubuntu')).toBe(false)
  })

  it('puts the project’s shell between the node and the default', () => {
    expect(paneRunsInWsl({}, 'wsl:Ubuntu', 'local', 'pwsh')).toBe(false)
    expect(paneRunsInWsl({}, 'pwsh', 'local', 'wsl:Ubuntu')).toBe(true)
    expect(paneRunsInWsl({ shell: 'pwsh' }, 'pwsh', 'local', 'wsl:Ubuntu')).toBe(false)
    expect(paneRunsInWsl({ shell: 'wsl:Ubuntu' }, 'pwsh', 'local', 'pwsh')).toBe(true)
  })

  it('does not read this machine’s default for a node whose pane is elsewhere', () => {
    expect(paneRunsInWsl({ ssh: { host: 'h' } }, 'wsl:Ubuntu')).toBe(false)
    expect(paneRunsInWsl({ sshRemoteTmux: true, shell: 'wsl:Ubuntu' }, 'wsl:Ubuntu')).toBe(false)
    expect(paneRunsInWsl({}, 'wsl:Ubuntu', 'relay')).toBe(false)
    expect(paneRunsInWsl({}, 'wsl:Ubuntu', 'local')).toBe(true)
  })
})
