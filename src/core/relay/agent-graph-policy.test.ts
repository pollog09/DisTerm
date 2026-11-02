// The graph's channels at the relay boundary: what a viewer and a project-scoped guest may see of a
// buffer that spans every project of the host, and that neither may read the host's Claude config.
import { describe, expect, it } from 'vitest'
import { IPC } from '../../shared/ipc'
import { decideAccess, filterOutboundEvent, narrowResponseForRole, type AccessContext } from './access-policy'
import { decideScopedAccess, type ScopedGuestDeps } from './scoped-guest-policy'

const ctx = (role: AccessContext['role']): AccessContext => ({
  role,
  sharedProjects: new Set(['P']),
  projectsOfNode: (id) => (id === 'mine' || id === 'mine2' ? ['P'] : id === 'theirs' ? ['Q'] : []),
  nodeOfSession: () => undefined,
  projectCwds: () => ['/srv/app'],
  hostDataDir: '/var/lib/data',
  realpath: (p) => p,
  isFile: () => false
})

const deps: ScopedGuestDeps = {
  projectsOfNode: (id) => (id === 'mine' ? ['P'] : []),
  nodeOfSession: () => undefined,
  projectCwd: () => '/srv/app',
  hostDataDir: '/var/lib/data'
}

const delivery = (from: string, to: string) => ({ kind: 'delivery', id: `${from}-${to}`, ts: 1, from, to, outcome: 'delivered' })
const ev = (payload: unknown): string => JSON.stringify({ t: 'ev', channel: IPC.agentGraphEvent, args: [payload] })

describe('agent graph at the viewer boundary', () => {
  it('a viewer may read a shared project and not another', () => {
    expect(decideAccess('req', IPC.agentGraphSnapshot, ['P'], ctx('viewer')).allow).toBe(true)
    expect(decideAccess('req', IPC.agentGraphSnapshot, ['Q'], ctx('viewer')).allow).toBe(false)
  })

  it('the response is trimmed to events wholly inside the shared nodes', () => {
    const result = {
      events: [
        delivery('mine', 'mine2'),
        delivery('mine', 'theirs'),
        delivery('theirs', 'mine'),
        { kind: 'subagent-start', id: 's1', ts: 1, nodeId: 'mine', subId: 'a' },
        { kind: 'subagent-start', id: 's2', ts: 1, nodeId: 'theirs', subId: 'b' }
      ],
      dropped: 3,
      capacity: 10,
      history: 'board-log',
      historyTruncated: false
    }
    const narrowed = narrowResponseForRole(IPC.agentGraphSnapshot, result, ctx('viewer')) as typeof result
    expect(narrowed.events.map((e) => e.id)).toEqual(['mine-mine2', 's1'])
    expect(narrowed.dropped).toBe(3)
  })

  it('an editor gets the response untouched', () => {
    const result = { events: [delivery('mine', 'theirs')] }
    expect(narrowResponseForRole(IPC.agentGraphSnapshot, result, ctx('editor'))).toBe(result)
  })

  it('a non-array is an empty list, never passed through', () => {
    const narrowed = narrowResponseForRole(IPC.agentGraphSnapshot, { events: 'x' }, ctx('viewer')) as { events: unknown[] }
    expect(narrowed.events).toEqual([])
  })

  it('a live event reaches a viewer only when every node it names is shared', () => {
    expect(filterOutboundEvent(ev(delivery('mine', 'mine2')), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev(delivery('mine', 'theirs')), ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(ev(delivery('theirs', 'mine')), ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(ev({ kind: 'subagent-end', nodeId: 'mine' }), ctx('viewer'))).toBe(true)
    expect(filterOutboundEvent(ev({ kind: 'subagent-end', nodeId: 'theirs' }), ctx('viewer'))).toBe(false)
    expect(filterOutboundEvent(ev({ kind: 'session-reset' }), ctx('viewer'))).toBe(false)
  })

  it('the ship config stays with editors: read, create and subscribe', () => {
    for (const m of [IPC.shipConfigRead, IPC.shipGraphCreate, IPC.shipConfigSubscribe, IPC.shipConfigUnsubscribe]) {
      expect(decideAccess('req', m, ['P'], ctx('viewer')).allow, m).toBe(false)
      expect(decideAccess('req', m, ['P'], ctx('commenter')).allow, m).toBe(false)
      expect(decideAccess('req', m, ['P'], ctx('editor')).allow, m).toBe(true)
    }
    const changed = JSON.stringify({ t: 'ev', channel: IPC.shipConfigChanged('P'), args: ['P'] })
    expect(filterOutboundEvent(changed, ctx('viewer'))).toBe(false)
  })
})

describe('agent graph at the scoped-guest boundary', () => {
  it('reads its own project and no other', () => {
    expect(decideScopedAccess('P', deps, IPC.agentGraphSnapshot, ['P']).allow).toBe(true)
    expect(decideScopedAccess('P', deps, IPC.agentGraphSnapshot, ['Q']).allow).toBe(false)
  })

  it('never reaches the host config', () => {
    for (const m of [IPC.shipConfigRead, IPC.shipGraphCreate, IPC.shipConfigSubscribe, IPC.shipConfigUnsubscribe]) {
      expect(decideScopedAccess('P', deps, m, ['P']).allow, m).toBe(false)
    }
  })
})
