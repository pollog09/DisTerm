import { describe, expect, it } from 'vitest'
import type { AgentGraphEvent, AgentGraphMapTouchEvent } from '@shared/agent-graph'
import { WORKING_STALE_MS } from '@shared/agents/stale'
import { parseSystemMap, type SystemMap } from '@shared/system-map'
import {
  SYSTEM_MAP_SPEEDS,
  SYSTEM_MAP_STEP_MS,
  buildSystemMapPicture,
  systemMapPlaySteps,
  systemMapStepMs,
  systemMapStructureKey,
  type SystemMapPictureInput
} from './systemMapModel'

function mapOf(doc: unknown): SystemMap {
  const r = parseSystemMap(JSON.stringify(doc))
  if (!r.ok) throw new Error(r.problems.join('\n'))
  return r.map
}

const MAP = mapOf({
  version: 1,
  title: 'Shop',
  parts: [
    { id: 'db', label: 'Postgres', kind: 'store', files: ['db/**'] },
    { id: 'web', label: 'Web', kind: 'caller', files: ['web/**'] },
    { id: 'api', label: 'API', subtitle: 'Go', kind: 'service', files: ['src/api/**'] },
    { id: 'cli', label: 'CLI', kind: 'caller', files: ['cmd/**'] },
    { id: 'stripe', label: 'Stripe', kind: 'external', files: [] }
  ],
  links: [
    { from: 'web', to: 'api', label: 'REST' },
    { from: 'api', to: 'db' }
  ],
  flows: [
    {
      id: 'login',
      name: 'Log in',
      group: 'Auth',
      steps: [
        { from: 'web', to: 'api', label: 'POST /login' },
        { from: 'api', to: 'db', label: 'check', mark: 'guard' },
        { from: 'api', to: 'web', label: 'cookie' }
      ]
    },
    { id: 'pay', name: 'Pay', group: 'Billing', steps: [{ from: 'api', to: 'stripe', label: 'charge' }, { from: 'stripe', to: 'api', label: 'webhook' }] },
    { id: 'logout', name: 'Log out', group: 'Auth', steps: [{ from: 'cli', to: 'api', label: 'DELETE /session', mark: 'refusal' }] }
  ]
})

const NOW = 10_000_000
const touch = (over: Partial<AgentGraphMapTouchEvent>): AgentGraphMapTouchEvent => ({
  kind: 'map-touch',
  id: `map-touch:${over.projectId ?? 'P'}:${over.nodeId ?? 'n1'}:${over.subId ?? ''}:${over.partId ?? ''}`,
  ts: NOW - 1000,
  projectId: 'P',
  nodeId: 'n1',
  count: 1,
  ...over
})

const input = (over: Partial<SystemMapPictureInput> = {}): SystemMapPictureInput => ({
  map: MAP,
  emptyParts: [],
  events: [],
  projectId: 'P',
  sessions: new Map([['n1', 'Backend'], ['n2', '']]),
  now: NOW,
  ...over
})

describe('buildSystemMapPicture: structure', () => {
  const p = buildSystemMapPicture(input({ emptyParts: ['db'] }))

  it('columns only for the kinds present, in kind order', () => {
    expect(p.columns).toEqual(['caller', 'service', 'store', 'external'])
    expect(p.title).toBe('Shop')
  })

  it('boxes in file order, with column by kind and row by order within the kind', () => {
    expect(p.boxes.map((b) => [b.id, b.column, b.row, b.noFiles])).toEqual([
      ['db', 2, 0, true],
      ['web', 0, 0, false],
      ['api', 1, 0, false],
      ['cli', 0, 1, false],
      ['stripe', 3, 0, false]
    ])
    expect(p.boxes[2]).toMatchObject({ label: 'API', subtitle: 'Go', kind: 'service', touchers: [] })
  })

  it('lines: the links in file order, then one implied line per step pair with no link either way', () => {
    expect(p.lines).toEqual([
      { id: 'line:web>api', from: 'web', to: 'api', label: 'REST', implied: false },
      { id: 'line:api>db', from: 'api', to: 'db', implied: false },
      { id: 'line:api>stripe', from: 'api', to: 'stripe', implied: true },
      { id: 'line:cli>api', from: 'cli', to: 'api', implied: true }
    ])
  })

  it('groups in first-seen order, flows in file order with their step counts', () => {
    expect(p.groups).toEqual([
      { group: 'Auth', flows: [{ id: 'login', name: 'Log in', steps: 3 }, { id: 'logout', name: 'Log out', steps: 1 }] },
      { group: 'Billing', flows: [{ id: 'pay', name: 'Pay', steps: 2 }] }
    ])
  })

  it('no touches: nothing lit, no counter, no fade', () => {
    expect(p.unmatchedEdits).toBe(0)
    expect(p).not.toHaveProperty('nextFadeAt')
  })
})

describe('buildSystemMapPicture: touches', () => {
  const build = (events: AgentGraphEvent[], over: Partial<SystemMapPictureInput> = {}) => buildSystemMapPicture(input({ events, ...over }))
  const lit = (events: AgentGraphEvent[]) => Object.fromEntries(build(events).boxes.filter((b) => b.touchers.length).map((b) => [b.id, b.touchers.map((t) => t.title)]))

  it('lights a part for a known node of this project', () => {
    const p = build([touch({ partId: 'api', ts: NOW - 5000 })])
    expect(p.boxes.find((b) => b.id === 'api')!.touchers).toEqual([{ key: 'n1:', nodeId: 'n1', title: 'Backend', ts: NOW - 5000 }])
  })

  it('ignores another project and an unknown node', () => {
    expect(lit([touch({ partId: 'api', projectId: 'Q' }), touch({ partId: 'api', nodeId: 'stranger' })])).toEqual({})
  })

  it('newest first, one per session or subagent, with the subagent in the title', () => {
    const p = build([
      touch({ partId: 'api', nodeId: 'n1', ts: NOW - 9000 }),
      touch({ partId: 'api', nodeId: 'n1', subId: 'a1', subType: 'general-purpose', ts: NOW - 1000 }),
      touch({ partId: 'api', nodeId: 'n1', subId: 'a2', ts: NOW - 5000 }),
      touch({ partId: 'api', nodeId: 'n2', ts: NOW - 3000 })
    ])
    expect(p.boxes.find((b) => b.id === 'api')!.touchers.map((t) => [t.key, t.title])).toEqual([
      ['n1:a1', 'Backend › general-purpose'],
      ['n2:', 'Session'],
      ['n1:a2', 'Backend › subagent'],
      ['n1:', 'Backend']
    ])
  })

  it('a duplicate key keeps the newest time', () => {
    const p = build([touch({ partId: 'api', ts: NOW - 100 }), { ...touch({ partId: 'api', ts: NOW - 9000 }), id: 'other-copy' }])
    expect(p.boxes.find((b) => b.id === 'api')!.touchers).toEqual([expect.objectContaining({ key: 'n1:', ts: NOW - 100 })])
  })

  it('a stale touch is not lit; one just inside the window is', () => {
    expect(lit([touch({ partId: 'api', ts: NOW - WORKING_STALE_MS })])).toEqual({})
    expect(lit([touch({ partId: 'api', ts: NOW - WORKING_STALE_MS + 1 })])).toEqual({ api: ['Backend'] })
  })

  it('a part that no longer exists is ignored', () => {
    const p = build([touch({ partId: 'cache' })])
    expect(p.boxes.every((b) => b.touchers.length === 0)).toBe(true)
    expect(p.unmatchedEdits).toBe(0)
  })

  it('unmatched edits are summed over this project\'s known nodes only', () => {
    const p = build([
      touch({ count: 3 }),
      touch({ nodeId: 'n2', count: 2 }),
      touch({ projectId: 'Q', count: 10 }),
      touch({ nodeId: 'stranger', count: 10 }),
      touch({ partId: 'api', count: 7 })
    ])
    expect(p.unmatchedEdits).toBe(5)
  })

  it('nextFadeAt is the earliest lit touch plus the window', () => {
    const p = build([touch({ partId: 'api', ts: NOW - 1000 }), touch({ partId: 'db', nodeId: 'n2', ts: NOW - 4000 }), touch({ partId: 'web', ts: NOW - WORKING_STALE_MS - 1 })])
    expect(p.nextFadeAt).toBe(NOW - 4000 + WORKING_STALE_MS)
  })

  it('other event kinds are ignored', () => {
    const p = build([{ kind: 'turn-start', id: 't', ts: NOW, nodeId: 'n1' } as AgentGraphEvent])
    expect(p.unmatchedEdits).toBe(0)
  })

  it('the structure key does not change with touches', () => {
    const plain = build([])
    const touched = build([touch({ partId: 'api' }), touch({ count: 4 })])
    expect(systemMapStructureKey(touched)).toBe(systemMapStructureKey(plain))
    const other = buildSystemMapPicture(input({ map: { ...MAP, links: [...MAP.links, { from: 'web', to: 'db' }] } }))
    expect(systemMapStructureKey(other)).not.toBe(systemMapStructureKey(plain))
  })
})

describe('systemMapPlaySteps', () => {
  const lines = buildSystemMapPicture(input()).lines

  it('a flow: one step per index, on its line, a link used backwards reversed', () => {
    const steps = systemMapPlaySteps(MAP, lines, { kind: 'flow', flowId: 'login' })
    expect(steps).toEqual([
      [{ flowId: 'login', flowName: 'Log in', index: 0, from: 'web', to: 'api', label: 'POST /login', lineId: 'line:web>api', reverse: false }],
      [{ flowId: 'login', flowName: 'Log in', index: 1, from: 'api', to: 'db', label: 'check', mark: 'guard', lineId: 'line:api>db', reverse: false }],
      [{ flowId: 'login', flowName: 'Log in', index: 2, from: 'api', to: 'web', label: 'cookie', lineId: 'line:web>api', reverse: true }]
    ])
  })

  it('a step on an implied line runs on it, reversed when it goes the other way to the one drawn', () => {
    const steps = systemMapPlaySteps(MAP, lines, { kind: 'flow', flowId: 'pay' })
    expect(steps.map((s) => [s[0].lineId, s[0].reverse])).toEqual([
      ['line:api>stripe', false],
      ['line:api>stripe', true]
    ])
  })

  it('all: step i of every flow that has one, flows in file order, as long as the longest flow', () => {
    const steps = systemMapPlaySteps(MAP, lines, { kind: 'all' })
    expect(steps).toHaveLength(3)
    expect(steps.map((at) => at.map((s) => `${s.flowId}:${s.index}`))).toEqual([
      ['login:0', 'pay:0', 'logout:0'],
      ['login:1', 'pay:1'],
      ['login:2']
    ])
    expect(steps[0][2]).toMatchObject({ mark: 'refusal', lineId: 'line:cli>api' })
  })

  it('an unknown flow plays nothing', () => {
    expect(systemMapPlaySteps(MAP, lines, { kind: 'flow', flowId: 'nope' })).toEqual([])
  })
})

describe('speeds', () => {
  it('0.5x, 1x and 2x are 3200, 1600 and 800 ms a step', () => {
    expect(SYSTEM_MAP_SPEEDS).toEqual([0.5, 1, 2])
    expect(SYSTEM_MAP_STEP_MS).toBe(1600)
    expect(SYSTEM_MAP_SPEEDS.map(systemMapStepMs)).toEqual([3200, 1600, 800])
  })
})
