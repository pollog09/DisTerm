import { describe, expect, it } from 'vitest'
import { parseSystemMap, type SystemMap } from '@shared/system-map'
import { MAP3D_COLUMN_DEPTH, MAP3D_COLUMN_X, MAP3D_ROW_Y, PART_3D_KIND, systemMapLineText, systemMapPartText, systemMapTo3d } from './systemMap3d'
import { buildSystemMapPicture, systemMapPlaySteps, type SystemMapBox } from './systemMapModel'

function mapOf(doc: unknown): SystemMap {
  const r = parseSystemMap(JSON.stringify(doc))
  if (!r.ok) throw new Error(r.problems.join('\n'))
  return r.map
}

const MAP = mapOf({
  version: 1,
  title: 'T',
  parts: [
    { id: 'web', label: 'Web', kind: 'caller', files: [] },
    { id: 'api', label: 'API', subtitle: 'Go', kind: 'service', files: ['src/**'] },
    { id: 'jobs', label: 'Jobs', kind: 'service', files: ['jobs/**'] },
    { id: 'db', label: 'DB', kind: 'store', files: [] }
  ],
  links: [{ from: 'web', to: 'api', label: 'REST' }, { from: 'api', to: 'db' }],
  flows: [{ id: 'f', name: 'F', group: 'G', steps: [{ from: 'web', to: 'api', label: 'go' }, { from: 'db', to: 'api', label: 'back' }, { from: 'jobs', to: 'db', label: 'write' }] }]
})

const NOW = 50_000_000
const picture = buildSystemMapPicture({
  map: MAP,
  emptyParts: ['jobs'],
  events: [
    { kind: 'map-touch', id: 'a', ts: NOW - 120_000, projectId: 'P', nodeId: 'n1', partId: 'api', count: 1 },
    { kind: 'map-touch', id: 'b', ts: NOW - 10_000, projectId: 'P', nodeId: 'n1', subId: 's1', subType: 'impl', partId: 'api', count: 1 }
  ],
  projectId: 'P',
  sessions: new Map([['n1', 'Backend']]),
  now: NOW
})

describe('PART_3D_KIND', () => {
  it('maps each part kind to a planet the 3D view already draws', () => {
    expect(PART_3D_KIND).toEqual({ caller: 'note', service: 'session', store: 'skill', worker: 'stage', external: 'ghost' })
  })
})

describe('systemMapTo3d', () => {
  const steps = systemMapPlaySteps(MAP, picture.lines, { kind: 'flow', flowId: 'f' })

  it('one node per part with its kind and text; a lit part runs its touchers as live satellites', () => {
    const { nodes } = systemMapTo3d(picture, [], 0)
    expect(nodes.map((n) => [n.id, n.kind, n.title])).toEqual([
      ['part:web', 'note', 'Web'],
      ['part:api', 'session', 'API'],
      ['part:jobs', 'session', 'Jobs'],
      ['part:db', 'skill', 'DB']
    ])
    const api = nodes.find((n) => n.id === 'part:api')!
    expect(api.subtitle).toBe('Go')
    expect(api.activity).toBe('running')
    expect(api.live).toEqual([
      { id: 'n1:s1', type: 'Backend › impl', startedAt: NOW - 10_000 },
      { id: 'n1:', type: 'Backend', startedAt: NOW - 120_000 }
    ])
    const web = nodes.find((n) => n.id === 'part:web')!
    expect(web).not.toHaveProperty('activity')
    expect(web).not.toHaveProperty('live')
  })

  it('pins columns across x, receding in depth, each column centred in y', () => {
    const { pinned } = systemMapTo3d(picture, [], 0)
    // columns: caller, service, store -> 3 columns, centre index 1
    expect(pinned.get('part:web')).toEqual({ x: -MAP3D_COLUMN_X, y: 0, z: -0 })
    expect(pinned.get('part:api')).toEqual({ x: 0, y: MAP3D_ROW_Y / 2, z: -MAP3D_COLUMN_DEPTH })
    expect(pinned.get('part:jobs')).toEqual({ x: 0, y: -MAP3D_ROW_Y / 2, z: -MAP3D_COLUMN_DEPTH })
    expect(pinned.get('part:db')).toEqual({ x: MAP3D_COLUMN_X, y: 0, z: -2 * MAP3D_COLUMN_DEPTH })
  })

  it('edges are observed lines between part ids; a playing one gets the play time', () => {
    const { edges } = systemMapTo3d(picture, steps[0], 777)
    expect(edges.map((e) => [e.id, e.source, e.target, e.kind])).toEqual([
      ['line:web>api', 'part:web', 'part:api', 'observed'],
      ['line:api>db', 'part:api', 'part:db', 'observed'],
      ['line:jobs>db', 'part:jobs', 'part:db', 'observed']
    ])
    expect(edges[0].lastEventTs).toBe(777)
    expect(edges[0]).not.toHaveProperty('flow')
    expect(edges[1]).not.toHaveProperty('lastEventTs')
  })

  it('a reversed step flows the other way', () => {
    const { edges } = systemMapTo3d(picture, steps[1], 5)
    const e = edges.find((x) => x.id === 'line:api>db')!
    expect(e.lastEventTs).toBe(5)
    expect(e.flow).toBe('reverse')
  })
})

describe('hover text', () => {
  const api = picture.boxes.find((b) => b.id === 'api')!
  const jobs = picture.boxes.find((b) => b.id === 'jobs')!

  it('part text: label, subtitle, kind, no files, and who is editing it', () => {
    expect(systemMapPartText(api, NOW)).toEqual(['API', 'Go', 'Service part', 'Edited by Backend › impl, just now', 'Edited by Backend, 2 min ago'])
    expect(systemMapPartText(jobs, NOW)).toEqual(['Jobs', 'Service part', 'No files match its globs'])
    const ext: SystemMapBox = { id: 'x', label: 'X', kind: 'external', column: 0, row: 0, noFiles: false, touchers: [] }
    expect(systemMapPartText(ext, NOW)[1]).toMatch(/part$/)
  })

  it('line text: its label, or from → to, and the implied note', () => {
    const [rest, apiDb, implied] = picture.lines
    expect(systemMapLineText(rest, picture.boxes)).toEqual(['REST'])
    expect(systemMapLineText(apiDb, picture.boxes)).toEqual(['API → DB'])
    expect(systemMapLineText(implied, picture.boxes)).toEqual(['Jobs → DB', 'Drawn for a flow step; the file declares no link here.'])
  })
})
