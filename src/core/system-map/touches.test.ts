import { describe, expect, it } from 'vitest'
import { AgentGraphLog } from '../agent-graph/event-log'
import { compileSystemMap, parseSystemMap, type CompiledSystemMap } from '../../shared/system-map'
import type { AgentGraphMapTouchEvent } from '../../shared/agent-graph'
import { SystemMapTouches } from './touches'

function compiled(parts: Array<{ id: string; files: string[] }>): CompiledSystemMap {
  const r = parseSystemMap(JSON.stringify({ version: 1, title: 'T', parts: parts.map((p) => ({ ...p, label: p.id, kind: 'service' })) }))
  if (!r.ok) throw new Error(r.problems.join('\n'))
  return compileSystemMap(r.map)
}

const MAP = compiled([
  { id: 'api', files: ['src/api/**'] },
  { id: 'db', files: ['src/db/**'] }
])

function setup() {
  const log = new AgentGraphLog()
  const touches = new SystemMapTouches(log)
  const rows = (): AgentGraphMapTouchEvent[] => log.snapshot().events.filter((e): e is AgentGraphMapTouchEvent => e.kind === 'map-touch')
  return { log, touches, rows }
}

describe('SystemMapTouches', () => {
  it('an edit a part owns is a row naming that part', () => {
    const { touches, rows } = setup()
    touches.set('P', ['/repo'], MAP)
    touches.recordEdit('n1', { path: '/repo/src/api/server.go' }, 100)
    expect(rows()).toEqual([{ kind: 'map-touch', id: 'map-touch:P:n1::api', ts: 100, projectId: 'P', nodeId: 'n1', partId: 'api', count: 1 }])
  })

  it('an edit inside the root that no part owns is a row with no part', () => {
    const { touches, rows } = setup()
    touches.set('P', ['/repo'], MAP)
    touches.recordEdit('n1', { path: '/repo/scripts/tool.sh' }, 1)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).not.toHaveProperty('partId')
    expect(rows()[0].id).toBe('map-touch:P:n1::')
  })

  it('an edit outside every root records nothing', () => {
    const { touches, rows } = setup()
    touches.set('P', ['/repo'], MAP)
    touches.recordEdit('n1', { path: '/elsewhere/src/api/x.go' }, 1)
    touches.recordEdit('n1', { path: '/repo2/src/api/x.go' }, 1)
    touches.recordEdit('n1', { path: '/repo/../etc/src/api/x' }, 1)
    expect(rows()).toEqual([])
  })

  it('a relative path is resolved against an absolute cwd, and dropped without one', () => {
    const { touches, rows } = setup()
    touches.set('P', ['/repo'], MAP)
    touches.recordEdit('n1', { path: 'src/db/schema.sql', cwd: '/repo' }, 1)
    touches.recordEdit('n1', { path: 'x/../src/db/a.sql', cwd: '/repo' }, 2)
    touches.recordEdit('n1', { path: 'src/api/a.go' }, 3)
    touches.recordEdit('n1', { path: 'src/api/a.go', cwd: 'repo' }, 4)
    expect(rows().map((r) => [r.partId, r.count])).toEqual([['db', 2]])
  })

  it('editing the map file itself is not a touch', () => {
    const { touches, rows } = setup()
    touches.set('P', ['/repo'], compiled([{ id: 'docs', files: ['docs/**'] }]))
    touches.recordEdit('n1', { path: '/repo/docs/system-map.json' }, 1)
    expect(rows()).toEqual([])
    touches.recordEdit('n1', { path: '/repo/docs/other.md' }, 1)
    expect(rows().map((r) => r.partId)).toEqual(['docs'])
  })

  it('matches under the realpath, the second root', () => {
    const { touches, rows } = setup()
    touches.set('P', ['/home/me/link', '/data/real'], MAP)
    touches.recordEdit('n1', { path: '/data/real/src/api/a.go' }, 1)
    touches.recordEdit('n1', { path: '/home/me/link/src/db/a.sql' }, 2)
    expect(rows().map((r) => r.partId)).toEqual(['api', 'db'])
  })

  it('a Windows root: backslashes and case in the prefix do not matter, the glob stays case-sensitive', () => {
    const { touches, rows } = setup()
    touches.set('P', ['C:\\Users\\me\\Repo'], MAP)
    touches.recordEdit('n1', { path: 'c:\\users\\me\\repo\\src\\api\\a.go' }, 1)
    touches.recordEdit('n1', { path: 'C:\\Users\\me\\Repo\\SRC\\API\\b.go' }, 2)
    touches.recordEdit('n1', { path: 'src\\db\\a.sql', cwd: 'C:\\Users\\me\\Repo' }, 3)
    expect(rows().map((r) => [r.partId ?? null, r.count])).toEqual([['api', 1], [null, 1], ['db', 1]])
  })

  it('two projects that both contain the path both get a row', () => {
    const { touches, rows } = setup()
    touches.set('outer', ['/w'], compiled([{ id: 'inner', files: ['repo/**'] }]))
    touches.set('inner', ['/w/repo'], MAP)
    touches.recordEdit('n1', { path: '/w/repo/src/api/a.go' }, 1)
    expect(rows().map((r) => [r.projectId, r.partId])).toEqual([['outer', 'inner'], ['inner', 'api']])
  })

  it('carries the subagent', () => {
    const { touches, rows } = setup()
    touches.set('P', ['/repo'], MAP)
    touches.recordEdit('n1', { path: '/repo/src/db/a.sql', subId: 'a404fab851c0d8e25', subType: 'general-purpose' }, 1)
    expect(rows()[0]).toMatchObject({ subId: 'a404fab851c0d8e25', subType: 'general-purpose', partId: 'db' })
  })

  it('set replaces the previous entry; drop stops recording', () => {
    const { touches, rows } = setup()
    touches.set('P', ['/old'], MAP)
    touches.set('P', ['/repo'], MAP)
    expect(touches.projectIds()).toEqual(['P'])
    touches.recordEdit('n1', { path: '/old/src/api/a.go' }, 1)
    expect(rows()).toEqual([])
    touches.drop('P')
    expect(touches.projectIds()).toEqual([])
    touches.recordEdit('n1', { path: '/repo/src/api/a.go' }, 2)
    expect(rows()).toEqual([])
  })

  it('no path in any recorded event', () => {
    const { log, touches } = setup()
    touches.set('P', ['/secret-root'], MAP)
    const seen: unknown[] = []
    log.onEvent((e) => seen.push(e))
    touches.recordEdit('n1', { path: '/secret-root/src/api/server.go' }, 1)
    touches.recordEdit('n1', { path: '/secret-root/scripts/tool.sh' }, 2)
    touches.recordEdit('n1', { path: 'src/db/schema.sql', cwd: '/secret-root' }, 3)
    const text = JSON.stringify([log.snapshot(), seen])
    for (const s of ['secret-root', 'server.go', 'tool.sh', 'schema.sql', 'src/']) expect(text).not.toContain(s)
    expect(seen).toHaveLength(3)
  })
})

describe('SystemMapTouches: an owner lookup over budget (Revision 1)', () => {
  // 2000 legal globs whose one wild name is costly against long names: the fixed owner budget runs out.
  const costly = compiled(
    Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, files: Array.from({ length: 50 }, (_, k) => `**/*${'?'.repeat(150)}z${k}`) }))
  )
  const deep = `/repo/${Array(16).fill('a'.repeat(250)).join('/')}`

  it('records nothing for that project, not even the unmatched row, and still records for a cheap one', () => {
    const { touches, rows } = setup()
    touches.set('costly', ['/repo'], costly)
    touches.set('cheap', ['/repo'], MAP)
    touches.recordEdit('n1', { path: deep }, 1)
    expect(rows().map((r) => [r.projectId, r.partId ?? null])).toEqual([['cheap', null]])
    touches.recordEdit('n1', { path: '/repo/src/api/a.go' }, 2)
    expect(rows().map((r) => [r.projectId, r.partId ?? null])).toEqual([
      ['cheap', null],
      ['costly', null],
      ['cheap', 'api']
    ])
  })
})
