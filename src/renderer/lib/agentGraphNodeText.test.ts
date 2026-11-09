import { describe, expect, it } from 'vitest'
import { graphNodeBadges, graphNodeTextLines, sessionGlow } from './agentGraphNodeText'
import type { GraphNode } from './agentGraphModel'

const node = (over: Partial<GraphNode>): GraphNode => ({ id: 'n', kind: 'session', title: 'Worker', ...over })

describe('graphNodeBadges', () => {
  it('says what the box says, in its order', () => {
    expect(graphNodeBadges(node({ agentId: 'claude', state: 'waiting', outcome: 'failed', handedOver: true, machine: { kind: 'ssh', label: 'box' } }), true)).toEqual([
      { text: 'Claude Code' },
      { text: 'box', machine: 'ssh' },
      { text: 'needs you', role: 'state' },
      { text: 'handed work' },
      { text: 'failed', outcome: 'failed' }
    ])
  })

  it('names the machine only when the view asks', () => {
    expect(graphNodeBadges(node({ machine: { kind: 'local', label: 'this computer' } }), false)).toEqual([])
  })

  it('leaves a Harness figure off when the config could not state it', () => {
    expect(graphNodeBadges(node({ kind: 'harness', harness: { sessions: 1, running: 0 }, machine: { kind: 'local', label: 'x' } }), true).map((b) => b.text)).toEqual(['1 session', '0 running'])
    expect(graphNodeBadges(node({ kind: 'harness', harness: { sessions: 2, running: 1, skillsInstalled: 0, mcpConfigured: 3 } }), false).map((b) => b.text)).toEqual([
      '2 sessions',
      '1 running',
      '0 skills installed',
      '3 MCP configured'
    ])
  })

  it('keeps the caveats on the uncertain badges', () => {
    const badges = graphNodeBadges(node({ kind: 'stage', activity: 'stale', reentered: true, maybeRuns: 2, missingAgent: true }), false)
    expect(badges.map((b) => [b.text, b.role])).toEqual([
      ['no recent signal', undefined],
      ['re-entered', 'loop'],
      ['maybe ×2', 'warning'],
      ['no agent file found', 'warning']
    ])
    expect(badges[2].title).toMatch(/not counted/)
    expect(badges[3].title).toMatch(/does not mean it cannot run/)
  })
})

describe('sessionGlow', () => {
  it.each([
    ['working', 'working'],
    ['waiting', 'attention'],
    ['blocked', 'attention'],
    ['done', 'idle'],
    [undefined, undefined]
  ])('a session %s glows %s', (state, glow) => {
    expect(sessionGlow({ kind: 'session', state })).toBe(glow)
  })

  it('only a session has one', () => {
    expect(sessionGlow({ kind: 'subagent', state: 'working' })).toBeUndefined()
  })
})

describe('graphNodeTextLines', () => {
  it('is the title with its runs, the subtitle, the badges and the description', () => {
    expect(graphNodeTextLines(node({ kind: 'stage', title: 'impl', runs: 2, subtitle: 'Ship · /ship-change', reentered: true, description: 'Writes the code' }), false)).toEqual([
      'impl ×2',
      'Ship · /ship-change',
      're-entered',
      'Writes the code'
    ])
  })
})
