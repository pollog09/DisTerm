import { beforeEach, describe, expect, it } from 'vitest'
import { mayStartWslTerminal, useWslTerminals, wslTerminalsForProject } from './wslTerminals'
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
