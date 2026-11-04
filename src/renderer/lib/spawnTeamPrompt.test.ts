import { describe, it, expect } from 'vitest'
import { conductorPrompt, MAX_TEAM_ROLES } from './spawnTeamPrompt'

describe('conductorPrompt', () => {
  it('leads with the skill trigger phrase — the orchestration doctrine hangs off it', () => {
    const p = conductorPrompt({ task: 'build a REST API', worktrees: true })
    expect(p.startsWith('Build with DisTerm orchestration: ')).toBe(true)
    expect(p).toContain('build a REST API')
  })

  it('carries the worktree decision, which is the dialog checkbox, not the conductor', () => {
    expect(conductorPrompt({ task: 't', worktrees: true })).toContain('open-worktree')
    const off = conductorPrompt({ task: 't', worktrees: false })
    expect(off).toContain('Do not create git worktrees')
    expect(off).not.toContain('open-worktree ')
  })

  it('flattens whitespace — the launch argv collapses it anyway, so mangling must not depend on input shape', () => {
    const p = conductorPrompt({ task: '  line one\n\n  line two\t end  ', worktrees: false })
    expect(p).toContain('line one line two end')
    expect(p).not.toMatch(/\n|\t| {2}/)
  })

  it('team cap matches the spawn-team handler cap', () => {
    expect(MAX_TEAM_ROLES).toBe(8)
  })
})
