import { describe, expect, it } from 'vitest'
import { agentGraphNodeSize, layoutAgentGraph, routeMidpoint, routeToPath } from './agentGraphLayout'
import type { GraphEdgeKind, GraphNodeKind } from './agentGraphModel'

const nodes = (...ids: string[]) => ids.map((id) => ({ id, kind: 'stage' as GraphNodeKind }))
const e = (source: string, target: string, kind?: GraphEdgeKind) => ({ id: `${source}>${target}`, source, target, ...(kind ? { kind } : {}) })

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }, size: { width: number; height: number }): boolean {
  return Math.abs(a.x - b.x) < size.width && Math.abs(a.y - b.y) < size.height
}

describe('layoutAgentGraph', () => {
  it('places every node, without overlap, left to right along the flow', () => {
    const { positions } = layoutAgentGraph(nodes('a', 'b', 'c'), [e('a', 'b'), e('b', 'c')])
    expect(positions.size).toBe(3)
    expect(positions.get('a')!.x).toBeLessThan(positions.get('b')!.x)
    expect(positions.get('b')!.x).toBeLessThan(positions.get('c')!.x)
  })

  it('survives a reject loop, keeps the forward order, and routes the back-edge', () => {
    const edges = [e('impl', 'docs'), e('docs', 'review'), e('review', 'impl', 'ship-reject'), e('review', 'docs', 'ship-reject')]
    const { positions, routes } = layoutAgentGraph(nodes('impl', 'docs', 'review'), edges)
    expect(positions.get('impl')!.x).toBeLessThan(positions.get('docs')!.x)
    expect(positions.get('docs')!.x).toBeLessThan(positions.get('review')!.x)
    for (const edge of edges) expect(routes.get(edge.id)!.length, edge.id).toBeGreaterThanOrEqual(2)
    // The back-edge really goes backwards: it starts further right than it ends.
    const back = routes.get('review>impl')!
    expect(back[0].x).toBeGreaterThan(back[back.length - 1].x)
  })

  it('an opener stays left of its station, whichever way the messages went', () => {
    const edges = [e('work', 'orch', 'message'), e('orch', 'work', 'message'), e('orch', 'work', 'opened')].map((x, i) => ({ ...x, id: `${x.id}#${i}` }))
    const { positions, routes } = layoutAgentGraph(nodes('work', 'orch'), edges)
    expect(positions.get('orch')!.x).toBeLessThan(positions.get('work')!.x)
    const reply = routes.get('work>orch#0')!
    expect(reply[0].x).toBeGreaterThan(reply[reply.length - 1].x) // and the reply still runs back
  })

  it('an undeclared cycle still lays out and terminates', () => {
    const { positions } = layoutAgentGraph(nodes('a', 'b', 'c'), [e('a', 'b'), e('b', 'c'), e('c', 'a')])
    expect(positions.size).toBe(3)
  })

  it('no two boxes of a busy graph overlap', () => {
    const ids = Array.from({ length: 16 }, (_, i) => `n${i}`)
    const edges = ids.slice(1).map((id, i) => e(ids[Math.floor(i / 3)], id))
    const { positions } = layoutAgentGraph(nodes(...ids), edges)
    const size = agentGraphNodeSize('stage')
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        expect(overlaps(positions.get(ids[i])!, positions.get(ids[j])!, size), `${ids[i]} / ${ids[j]}`).toBe(false)
      }
    }
  })

  it('parallel lines between one pair each keep their own route', () => {
    const { routes } = layoutAgentGraph(nodes('a', 'b'), [
      { id: 'one', source: 'a', target: 'b' },
      { id: 'two', source: 'a', target: 'b' }
    ])
    expect(routes.get('one')).toBeDefined()
    expect(routes.get('two')).toBeDefined()
  })

  it('an edge to a box that is not drawn invents nothing', () => {
    const { positions, routes } = layoutAgentGraph(nodes('a'), [e('a', 'ghost')])
    expect([...positions.keys()]).toEqual(['a'])
    expect(routes.size).toBe(0)
  })

  it('an empty graph lays out to nothing', () => {
    const { positions, routes } = layoutAgentGraph([], [])
    expect(positions.size).toBe(0)
    expect(routes.size).toBe(0)
  })

  it('the same input gives the same layout, so nothing jumps on a re-render', () => {
    const edges = [e('a', 'b'), e('b', 'a')]
    const one = layoutAgentGraph(nodes('a', 'b'), edges)
    const two = layoutAgentGraph(nodes('a', 'b'), edges)
    expect([...one.positions]).toEqual([...two.positions])
  })
})

describe('routeToPath', () => {
  it('draws straight when there are two points', () => {
    expect(routeToPath([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe('M 0.0 0.0 L 10.0 0.0')
  })

  it('rounds an interior corner', () => {
    const d = routeToPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }])
    expect(d).toContain('Q 100.0 0.0')
    expect(d.endsWith('L 100.0 100.0')).toBe(true)
  })

  it('tolerates a repeated point and an empty route', () => {
    expect(routeToPath([])).toBe('')
    expect(routeToPath([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 2 }])).not.toContain('NaN')
  })
})

describe('routeMidpoint', () => {
  it('is on the line, odd or even', () => {
    expect(routeMidpoint([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }])).toEqual({ x: 5, y: 5 })
    expect(routeMidpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toEqual({ x: 5, y: 0 })
    expect(routeMidpoint([])).toEqual({ x: 0, y: 0 })
  })
})
