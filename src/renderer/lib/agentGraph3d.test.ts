import { describe, expect, it } from 'vitest'
import {
  graph3dEngineSettings,
  graph3dLinkLook,
  graph3dLoopShouldRun,
  graph3dNodeLook,
  parseCssColor,
  rgbaString,
  rgbHex,
  toGraph3dData,
  type Graph3dLoopInput
} from './agentGraph3d'
import type { GraphEdge, GraphNode } from './agentGraphModel'

const session = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({ id, kind: 'session', title: id, ...over })
const edge = (id: string, source: string, target: string, over: Partial<GraphEdge> = {}): GraphEdge => ({ id, source, target, kind: 'message', ...over })

describe('toGraph3dData', () => {
  it('maps the same nodes and lines, with their ids and kinds', () => {
    const data = toGraph3dData({
      nodes: [session('session:a'), { id: 'harness:local:x', kind: 'harness', title: 'Harness' }, { id: 'skill:grill', kind: 'skill', title: 'grill' }],
      edges: [
        edge('h:a', 'harness:local:x', 'session:a', { kind: 'harness', flow: 'reverse' }),
        edge('u:a:grill', 'session:a', 'skill:grill', { kind: 'uses-skill', traversals: 2 })
      ]
    })
    expect(data.nodes).toEqual([
      { id: 'session:a', kind: 'session' },
      { id: 'harness:local:x', kind: 'harness' },
      { id: 'skill:grill', kind: 'skill' }
    ])
    expect(data.links).toEqual([
      { id: 'h:a', source: 'harness:local:x', target: 'session:a', kind: 'harness' },
      { id: 'u:a:grill', source: 'session:a', target: 'skill:grill', kind: 'uses-skill' }
    ])
    expect(data.key).toBe('[["session:a","harness:local:x","skill:grill"],["h:a","u:a:grill"]]')
  })

  it('drops a line to a node that is not drawn, as the 2D layout does', () => {
    const data = toGraph3dData({ nodes: [session('a')], edges: [edge('m', 'a', 'gone')] })
    expect(data.links).toEqual([])
  })

  it('returns the very same result while only content changes, so the layout keeps going', () => {
    const first = toGraph3dData({ nodes: [session('a'), session('b')], edges: [edge('m', 'a', 'b', { counts: { delivered: 1, queued: 0, failed: 0, refused: 0 } })] })
    const next = toGraph3dData(
      { nodes: [session('a', { state: 'working' }), session('b', { title: 'renamed' })], edges: [edge('m', 'a', 'b', { counts: { delivered: 5, queued: 0, failed: 0, refused: 1 }, lastEventTs: 9 })] },
      first
    )
    expect(next).toBe(first)
  })

  it('keeps each surviving node object, with what the layout wrote on it, when the structure changes', () => {
    const first = toGraph3dData({ nodes: [session('a'), session('b')], edges: [edge('m', 'a', 'b')] })
    // The force layout writes positions onto the objects and swaps link ends for node objects.
    Object.assign(first.nodes[0], { x: 10, y: -4, z: 2 })
    first.links[0].source = first.nodes[0]
    first.links[0].target = first.nodes[1]
    const next = toGraph3dData({ nodes: [session('a'), session('b'), session('c')], edges: [edge('m', 'a', 'b'), edge('n', 'b', 'c')] }, first)
    expect(next).not.toBe(first)
    expect(next.nodes[0]).toBe(first.nodes[0])
    expect(next.nodes[1]).toBe(first.nodes[1])
    expect(next.nodes[0]).toMatchObject({ x: 10, y: -4, z: 2 })
    expect(next.nodes[2]).toEqual({ id: 'c', kind: 'session' })
    expect(next.links[0]).toBe(first.links[0])
    expect(next.links[1]).toEqual({ id: 'n', source: 'b', target: 'c', kind: 'message' })
  })

  it('does not keep an object whose kind or ends changed under the same id', () => {
    const first = toGraph3dData({ nodes: [session('a'), session('b')], edges: [edge('m', 'a', 'b')] })
    const next = toGraph3dData({ nodes: [{ id: 'a', kind: 'note', title: 'a' }, session('b'), session('c')], edges: [edge('m', 'a', 'c')] }, first)
    expect(next.nodes[0]).not.toBe(first.nodes[0])
    expect(next.nodes[0]).toEqual({ id: 'a', kind: 'note' })
    expect(next.links[0]).not.toBe(first.links[0])
    expect(next.links[0]).toEqual({ id: 'm', source: 'a', target: 'c', kind: 'message' })
  })
})

describe('graph3dNodeLook', () => {
  it.each([
    ['a Claude session, working', session('s', { agentId: 'claude', state: 'working' }), { shape: 'sphere', radius: 7, color: '#d97757', glow: 'working', glowColor: 'var(--state-working)', label: 's' }],
    ['a Codex session that needs you', session('s', { agentId: 'codex', state: 'waiting' }), { shape: 'sphere', radius: 7, color: '#10a37f', glow: 'attention', glowColor: 'var(--state-attention)', label: 's' }],
    ['an idle session of an unknown agent', session('s', { agentId: 'custom:x', state: 'done' }), { shape: 'sphere', radius: 7, color: '#888888', glow: 'idle', glowColor: 'var(--state-success)', label: 's' }],
    ['a session with no signal yet', session('s'), { shape: 'sphere', radius: 7, color: '#888888', label: 's' }],
    ['a running stage with a colour and runs', { id: 'st', kind: 'stage', title: 'impl', color: 'blue', activity: 'running', runs: 2 } as GraphNode, { shape: 'dodecahedron', radius: 5, color: 'var(--sys-blue)', glow: 'working', glowColor: 'var(--state-working)', label: 'impl ×2' }],
    ['a skill', { id: 'k', kind: 'skill', title: 'grill', runs: 3 } as GraphNode, { shape: 'octahedron', radius: 4.5, color: 'var(--sys-teal)', label: 'grill ×3' }],
    ['an MCP server', { id: 'm', kind: 'mcp', title: 'demo' } as GraphNode, { shape: 'box', radius: 4, color: 'var(--sys-indigo)', label: 'demo' }],
    ['the harness', { id: 'h', kind: 'harness', title: 'Harness' } as GraphNode, { shape: 'icosahedron', radius: 8, color: 'rgba(var(--tint-rgb), 0.45)', label: 'Harness' }],
    ['a note', { id: 'n', kind: 'note', title: 'Plan' } as GraphNode, { shape: 'tetrahedron', radius: 4, color: 'var(--state-automation)', label: 'Plan' }],
    ['a ghost', { id: 'g', kind: 'ghost', title: 'Outside' } as GraphNode, { shape: 'sphere', radius: 3.5, color: 'rgba(var(--tint-rgb), 0.45)', faded: true, label: 'Outside' }]
  ])('%s', (_name, node, look) => {
    expect(graph3dNodeLook(node)).toEqual(look)
  })
})

describe('graph3dLinkLook', () => {
  it.each([
    ['a delivered message', edge('m', 'a', 'b', { latest: 'delivered' }), { color: 'var(--state-success)', width: 0.45, dashed: false, arrow: true, reverse: false }],
    ['a refused message', edge('m', 'a', 'b', { latest: 'refused' }), { color: 'var(--state-error)', width: 0.45, dashed: false, arrow: true, reverse: false }],
    ['the harness line', edge('h', 'h', 'a', { kind: 'harness', flow: 'reverse' }), { color: 'rgba(var(--tint-rgb), 0.28)', width: 0.45, dashed: false, arrow: false, reverse: true }],
    ['a re-entry', edge('r', 'a', 'b', { kind: 'ship-reject', loop: true, traversals: 1 }), { color: 'var(--state-attention)', width: 1.1, dashed: true, arrow: true, reverse: false }],
    ['a context link', edge('c', 'a', 'b', { kind: 'context' }), { color: 'var(--state-automation)', width: 0.45, dashed: true, arrow: true, reverse: false }],
    ['a skill call', edge('u', 'a', 'k', { kind: 'uses-skill' }), { color: 'var(--sys-teal)', width: 0.45, dashed: false, arrow: true, reverse: false }]
  ])('%s', (_name, e, look) => {
    expect(graph3dLinkLook(e)).toEqual(look)
  })
})

describe('parseCssColor', () => {
  it.each([
    ['#d97757', { r: 217, g: 119, b: 87, a: 1 }],
    ['#fff', { r: 255, g: 255, b: 255, a: 1 }],
    ['#00000080', { r: 0, g: 0, b: 0, a: 128 / 255 }],
    ['rgb(48, 209, 88)', { r: 48, g: 209, b: 88, a: 1 }],
    ['rgba(255, 255, 255, 0.28)', { r: 255, g: 255, b: 255, a: 0.28 }],
    ['rgb(10 20 30 / 50%)', { r: 10, g: 20, b: 30, a: 0.5 }],
    ['color(srgb 1 0.5 0 / 0.6)', { r: 255, g: 128, b: 0, a: 0.6 }],
    ['color(srgb 0 0 1)', { r: 0, g: 0, b: 255, a: 1 }]
  ])('%s', (text, rgba) => {
    expect(parseCssColor(text)).toEqual(rgba)
  })

  it.each(['', 'var(--text)', 'red', 'color(display-p3 1 0 0)', 'rgb(1, 2)', '#12345'])('%s is not read', (text) => {
    expect(parseCssColor(text)).toBeNull()
  })

  it('writes the forms the library reads', () => {
    expect(rgbaString({ r: 1, g: 2, b: 3, a: 0.5 })).toBe('rgba(1, 2, 3, 0.5)')
    expect(rgbHex({ r: 217, g: 119, b: 7, a: 1 })).toBe('#d97707')
  })
})

describe('graph3dLoopShouldRun', () => {
  const idle: Graph3dLoopInput = { shown: true, watched: true, engineRunning: false, particlesInFlight: false, pointerInside: false, busyUntil: 0, now: 1000 }
  it.each<[string, Partial<Graph3dLoopInput>, boolean]>([
    ['a settled graph nobody points at', {}, false],
    ['the layout still moving', { engineRunning: true }, true],
    ['a particle in flight', { particlesInFlight: true }, true],
    ['the pointer over it', { pointerInside: true }, true],
    ['a camera move asked for', { busyUntil: 1500 }, true],
    ['a camera move that is over', { busyUntil: 1000 }, false],
    ['covered by the terminal modal', { shown: false, engineRunning: true, pointerInside: true }, false],
    ['a window nobody is looking at', { watched: false, engineRunning: true, particlesInFlight: true, pointerInside: true, busyUntil: 9999 }, false]
  ])('%s', (_name, over, run) => {
    expect(graph3dLoopShouldRun({ ...idle, ...over })).toBe(run)
  })
})

describe('graph3dEngineSettings', () => {
  it('under reduced motion, computes the layout up front and never animates it', () => {
    expect(graph3dEngineSettings(true)).toEqual({ warmupTicks: 300, cooldownTicks: 0, cooldownTime: 0 })
  })
  it('otherwise settles on screen and stops', () => {
    expect(graph3dEngineSettings(false)).toEqual({ warmupTicks: 0, cooldownTicks: 300, cooldownTime: 4000 })
  })
})
