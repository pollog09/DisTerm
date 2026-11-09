import { describe, expect, it } from 'vitest'
import { forceCenter, forceLink, forceManyBody, forceSimulation, type Force, type LinkForce, type SimNode } from 'd3-force-3d'
import {
  compositeOver,
  GRAPH3D_CHARGE,
  graph3dLayoutForces,
  graph3dEngineSettings,
  graph3dHasLiveMotion,
  graph3dLinkLook,
  graph3dLoopShouldRun,
  graph3dNodeLook,
  graph3dNodeMotion,
  graph3dPixelScale,
  graph3dPlanetPose,
  graph3dSeed,
  graph3dShownLabels,
  MAX_SATELLITES,
  parseCssColor,
  rgbaString,
  rgbHex,
  toGraph3dData,
  type Graph3dLabelBox,
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

  // The layout swaps a line's ends for node objects and keeps an end that is already an object, so a
  // kept line whose end object was replaced would stay pinned to a node nobody simulates any more.
  const laidOut = (data: ReturnType<typeof toGraph3dData>) => {
    const byId = new Map(data.nodes.map((n) => [n.id, n]))
    for (const l of data.links) {
      l.source = byId.get(l.source as string)!
      l.target = byId.get(l.target as string)!
    }
    return data
  }

  it('rebuilds a line whose end node was replaced, and keeps one whose ends survived', () => {
    const first = laidOut(toGraph3dData({ nodes: [session('x'), session('y'), session('z')], edges: [edge('m:x:y', 'x', 'y'), edge('m:y:z', 'y', 'z')] }))
    // x closes and becomes a ghost under the same id, and a line is added in the same update.
    const next = toGraph3dData(
      { nodes: [{ id: 'x', kind: 'ghost', title: 'x' }, session('y'), session('z')], edges: [edge('m:x:y', 'x', 'y'), edge('m:y:z', 'y', 'z'), edge('m:z:x', 'z', 'x')] },
      first
    )
    const ghost = next.nodes[0]
    expect(ghost).not.toBe(first.nodes[0])
    expect(ghost).toEqual({ id: 'x', kind: 'ghost' })
    expect(next.links[0]).not.toBe(first.links[0])
    expect(next.links[0]).toEqual({ id: 'm:x:y', source: 'x', target: 'y', kind: 'message' })
    expect(next.links[0].source).not.toBe(first.nodes[0])
    expect(next.links[1]).toBe(first.links[1])
    expect([next.links[1].source, next.links[1].target]).toEqual([next.nodes[1], next.nodes[2]])
    expect(next.links[2]).toEqual({ id: 'm:z:x', source: 'z', target: 'x', kind: 'message' })
  })

  it('the same holds the other way, a ghost turning back into a session', () => {
    const first = laidOut(toGraph3dData({ nodes: [{ id: 'x', kind: 'ghost', title: 'x' }, session('y')], edges: [edge('m:x:y', 'x', 'y')] }))
    const next = toGraph3dData({ nodes: [session('x'), session('y'), session('w')], edges: [edge('m:x:y', 'x', 'y'), edge('m:y:w', 'y', 'w')] }, first)
    expect(next.nodes[0]).toEqual({ id: 'x', kind: 'session' })
    expect(next.links[0]).toEqual({ id: 'm:x:y', source: 'x', target: 'y', kind: 'message' })
  })

  it('a kind that changes with nothing else changing still gets a new object, and so a new shape', () => {
    const first = laidOut(toGraph3dData({ nodes: [{ id: 'x', kind: 'ghost', title: 'x' }, session('y')], edges: [edge('m:x:y', 'x', 'y')] }))
    const next = toGraph3dData({ nodes: [session('x'), session('y')], edges: [edge('m:x:y', 'x', 'y')] }, first)
    expect(next).not.toBe(first)
    expect(next.key).toBe(first.key)
    expect(next.nodes[0]).toEqual({ id: 'x', kind: 'session' })
    expect(next.nodes[1]).toBe(first.nodes[1])
    expect(next.links[0]).toEqual({ id: 'm:x:y', source: 'x', target: 'y', kind: 'message' })
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
  const planet = (surface: string, id: string, extra: { ring?: boolean; atmosphere?: boolean } = {}) => ({ surface, ring: false, atmosphere: false, ...extra, seed: graph3dSeed(id) })
  it.each([
    ['a Claude session, working', session('s', { agentId: 'claude', state: 'working' }), { planet: planet('gas', 's', { atmosphere: true }), radius: 7, color: '#d97757', glow: 'working', glowColor: 'var(--state-working)', label: 's', labelRank: 0 }],
    ['a Codex session that needs you', session('s', { agentId: 'codex', state: 'waiting' }), { planet: planet('gas', 's', { atmosphere: true }), radius: 7, color: '#10a37f', glow: 'attention', glowColor: 'var(--state-attention)', label: 's', labelRank: 0 }],
    ['an idle session of an unknown agent', session('s', { agentId: 'custom:x', state: 'done' }), { planet: planet('gas', 's', { atmosphere: true }), radius: 7, color: '#888888', glow: 'idle', glowColor: 'var(--state-success)', label: 's', labelRank: 0 }],
    ['a session with no signal yet', session('s'), { planet: planet('gas', 's', { atmosphere: true }), radius: 7, color: '#888888', label: 's', labelRank: 0 }],
    ['a running stage with a colour and runs', { id: 'st', kind: 'stage', title: 'impl', color: 'blue', activity: 'running', runs: 2 } as GraphNode, { planet: planet('rock', 'st'), radius: 5, color: 'var(--sys-blue)', glow: 'working', glowColor: 'var(--state-working)', label: 'impl ×2', labelRank: 2 }],
    ['a skill', { id: 'k', kind: 'skill', title: 'grill', runs: 3 } as GraphNode, { planet: planet('ice', 'k'), radius: 4.5, color: 'var(--sys-teal)', label: 'grill ×3', labelRank: 3 }],
    ['an MCP server', { id: 'm', kind: 'mcp', title: 'demo' } as GraphNode, { planet: planet('ice', 'm', { ring: true }), radius: 4, color: 'var(--sys-indigo)', label: 'demo', labelRank: 3 }],
    ['the harness', { id: 'h', kind: 'harness', title: 'Harness' } as GraphNode, { planet: planet('gas', 'h', { ring: true }), radius: 6, color: 'rgba(var(--tint-rgb), 0.45)', label: 'Harness', labelRank: 1 }],
    ['a note', { id: 'n', kind: 'note', title: 'Plan' } as GraphNode, { planet: planet('asteroid', 'n'), radius: 4, color: 'var(--state-automation)', label: 'Plan', labelRank: 4 }],
    ['a ghost', { id: 'g', kind: 'ghost', title: 'Outside' } as GraphNode, { planet: planet('rock', 'g'), radius: 3.5, color: 'rgba(var(--tint-rgb), 0.45)', faded: true, label: 'Outside', labelRank: 5 }]
  ])('%s', (_name, node, look) => {
    expect(graph3dNodeLook(node)).toEqual(look)
  })
})

describe('graph3dSeed and graph3dPlanetPose', () => {
  it('the same id is always the same world, and two ids are not', () => {
    expect(graph3dSeed('session:a')).toBe(graph3dSeed('session:a'))
    expect(graph3dSeed('session:a')).not.toBe(graph3dSeed('session:b'))
    expect(graph3dSeed('')).toBe(0x811c9dc5)
  })

  it('a world leans no more than about 23 degrees and may show any face', () => {
    const poses = Array.from({ length: 200 }, (_, i) => graph3dPlanetPose(graph3dSeed(`node:${i}`)))
    expect(Math.max(...poses.map((p) => Math.abs(p.tilt)))).toBeLessThanOrEqual(0.4)
    expect(Math.min(...poses.map((p) => p.turn))).toBeGreaterThanOrEqual(0)
    expect(Math.max(...poses.map((p) => p.turn))).toBeLessThan(Math.PI * 2)
    expect(new Set(poses.map((p) => p.turn.toFixed(2))).size).toBeGreaterThan(120)
  })
})

describe('graph3dLinkLook', () => {
  it.each([
    ['a delivered message', edge('m', 'a', 'b', { latest: 'delivered' }), { color: 'var(--state-success)', width: 0.7, dashed: false, arrowLength: 4.5, reverse: false }],
    ['a refused message', edge('m', 'a', 'b', { latest: 'refused' }), { color: 'var(--state-error)', width: 0.7, dashed: false, arrowLength: 4.5, reverse: false }],
    ['the harness line', edge('h', 'h', 'a', { kind: 'harness', flow: 'reverse' }), { color: 'rgba(var(--tint-rgb), 0.28)', width: 0.7, dashed: false, arrowLength: 0, reverse: true }],
    ['a re-entry', edge('r', 'a', 'b', { kind: 'ship-reject', loop: true, traversals: 1 }), { color: 'var(--state-attention)', width: 1.6, dashed: true, arrowLength: 4.5, reverse: false }],
    ['a context link', edge('c', 'a', 'b', { kind: 'context' }), { color: 'var(--state-automation)', width: 0.7, dashed: true, arrowLength: 4.5, reverse: false }],
    ['a skill call', edge('u', 'a', 'k', { kind: 'uses-skill' }), { color: 'var(--sys-teal)', width: 0.7, dashed: false, arrowLength: 4.5, reverse: false }]
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
  const idle: Graph3dLoopInput = { shown: true, watched: true, engineRunning: false, particlesInFlight: false, liveMotion: false, pointerInside: false, busyUntil: 0, now: 1000 }
  it.each<[string, Partial<Graph3dLoopInput>, boolean]>([
    ['a settled graph nobody points at', {}, false],
    ['the layout still moving', { engineRunning: true }, true],
    ['a particle in flight', { particlesInFlight: true }, true],
    ['the pointer over it', { pointerInside: true }, true],
    ['a camera move asked for', { busyUntil: 1500 }, true],
    ['something running', { liveMotion: true }, true],
    ['a camera move that is over', { busyUntil: 1000 }, false],
    ['covered by the terminal modal', { shown: false, engineRunning: true, pointerInside: true }, false],
    ['a window nobody is looking at', { watched: false, engineRunning: true, particlesInFlight: true, liveMotion: true, pointerInside: true, busyUntil: 9999 }, false],
    ['a covered view with something running', { shown: false, liveMotion: true }, false]
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

describe('graph3dNodeMotion', () => {
  const sub = (over: Partial<GraphNode> = {}): GraphNode => ({ id: 'sub:p:Explore', kind: 'subagent', title: 'Explore', ...over })
  const live = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, type: 'Explore', startedAt: i }))

  it('a settled box does not move', () => {
    expect(graph3dNodeMotion(sub({ activity: 'done' }))).toEqual({ spin: false, breathe: false, satellites: [] })
    expect(graph3dNodeMotion(session('session:a', { state: 'waiting' }))).toEqual({ spin: false, breathe: false, satellites: [] })
  })

  it('a running subagent turns, breathes and carries a satellite per live run, the newest kept', () => {
    const m = graph3dNodeMotion(sub({ activity: 'running', live: live(MAX_SATELLITES + 2) }))
    expect(m.spin).toBe(true)
    expect(m.breathe).toBe(true)
    expect(m.satellites).toHaveLength(MAX_SATELLITES)
    expect(m.satellites.at(-1)).toBe(`r${MAX_SATELLITES + 1}`)
  })

  it('a session that is only working keeps still; one with live subagents breathes and does not turn', () => {
    expect(graph3dNodeMotion(session('session:a', { state: 'working' }))).toEqual({ spin: false, breathe: false, satellites: [] })
    expect(graph3dNodeMotion(session('session:a', { live: live(1) }))).toMatchObject({ spin: false, satellites: ['r0'] })
  })
})

describe('graph3dHasLiveMotion', () => {
  it('only something happening keeps frames', () => {
    expect(graph3dHasLiveMotion([session('session:a', { state: 'done' })], [edge('m', 'a', 'b', { latest: 'delivered', lastEventTs: 0 })], 60_000)).toBe(false)
    expect(graph3dHasLiveMotion([session('session:a', { state: 'working' })], [], 0)).toBe(false)
    expect(graph3dHasLiveMotion([session('session:a', { live: [{ id: 'r', type: 'Explore', startedAt: 0 }] })], [], 0)).toBe(true)
    expect(graph3dHasLiveMotion([], [edge('m', 'a', 'b', { latest: 'delivered', lastEventTs: 1000 })], 2000)).toBe(true)
    expect(graph3dHasLiveMotion([], [edge('m', 'a', 'b', { latest: 'queued', lastEventTs: 1000 })], 2000)).toBe(false)
  })
})

describe('graph3dLayoutForces', () => {
  // The picture that was reported: sessions on a Harness with a subagent, and a ship template's three
  // stages beside them with no line between the two, plus notes on their own. The library's own forces,
  // then the view's, from several start orders.
  const kinds: Record<string, GraphNode['kind']> = {
    claude: 'session', redesign: 'session', startup: 'session', harness: 'harness', shipit: 'subagent',
    implementer: 'stage', writer: 'stage', reviewer: 'stage', n1: 'note', n2: 'note', n3: 'note', n4: 'note'
  }
  const lines = [['harness', 'claude'], ['harness', 'redesign'], ['harness', 'startup'], ['startup', 'shipit'], ['implementer', 'writer'], ['writer', 'reviewer'], ['reviewer', 'implementer']]
  const ids = Object.keys(kinds)
  // A node's halo, which any glowing kind can wear, and room for the name above it.
  const clearance = (id: string): number => graph3dNodeLook({ id, kind: kinds[id], title: id }).radius * 1.55 + 4

  const settle = (forces: () => Record<string, Force>, start: number) => {
    const nodes: SimNode[] = [...ids.slice(start), ...ids.slice(0, start)].map((id) => ({ id }))
    const sim = forceSimulation()
      .numDimensions(3)
      .stop()
      .force('link', forceLink().id((n) => n.id as string))
      .force('charge', forceManyBody().strength(GRAPH3D_CHARGE))
      .force('center', forceCenter())
      .nodes(nodes)
    ;(sim.force('link') as LinkForce).links(lines.map(([source, target]) => ({ source, target })))
    for (const [name, force] of Object.entries(forces())) sim.force(name, force)
    sim.tick(300)
    const at = new Map(nodes.map((n) => [n.id as string, [n.x ?? 0, n.y ?? 0, n.z ?? 0]]))
    const p = (id: string): number[] => at.get(id)!
    const dist = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    const middle = (group: string[]): number[] => [0, 1, 2].map((k) => group.reduce((sum, id) => sum + p(id)[k], 0) / group.length)
    const meanLine = lines.reduce((sum, [a, b]) => sum + dist(p(a), p(b)), 0) / lines.length
    const spread = (k: number): number => Math.max(...ids.map((id) => p(id)[k])) - Math.min(...ids.map((id) => p(id)[k]))
    return {
      gapInLines: dist(middle(['claude', 'redesign', 'startup', 'harness', 'shipit']), middle(['implementer', 'writer', 'reviewer'])) / meanLine,
      // The first view looks down z, so what overlaps on screen is what is close in x and y.
      onScreen: Math.min(...ids.flatMap((a, i) => ids.slice(i + 1).map((b) => Math.hypot(p(a)[0] - p(b)[0], p(a)[1] - p(b)[1]) / (clearance(a) + clearance(b))))),
      depth: spread(2) / Math.max(spread(0), spread(1))
    }
  }
  const starts = [0, 1, 2, 3, 4, 5, 6, 7]
  const before = starts.map((s) => settle(() => ({}), s))
  const after = starts.map((s) => settle(graph3dLayoutForces, s))
  const worst = (runs: typeof after, key: 'gapInLines' | 'onScreen'): number => (key === 'gapInLines' ? Math.max : Math.min)(...runs.map((r) => r[key]))
  const mean = (runs: typeof after): number => runs.reduce((sum, r) => sum + r.depth, 0) / runs.length

  it('keeps two parts with no line between them close: about two line lengths, not eight', () => {
    expect(worst(before, 'gapInLines')).toBeGreaterThan(6)
    expect(worst(after, 'gapInLines')).toBeLessThan(3)
  })

  it('shows every node clear of the others in the first view, halo and name included', () => {
    expect(worst(before, 'onScreen')).toBeLessThan(0.3)
    expect(worst(after, 'onScreen')).toBeGreaterThan(0.75)
  })

  it('stays a 3D graph: flatter in depth than across, never flat', () => {
    expect(mean(before)).toBeGreaterThan(0.9)
    expect(mean(after)).toBeGreaterThan(0.1)
    expect(mean(after)).toBeLessThan(0.3)
  })
})

describe('graph3dShownLabels', () => {
  const box = (id: string, left: number, top: number, over: Partial<Graph3dLabelBox> = {}): Graph3dLabelBox => ({ id, left, top, width: 100, height: 22, depth: 0.5, rank: 2, ...over })

  it('shows every name when none covers another', () => {
    expect([...graph3dShownLabels([box('a', 0, 0), box('b', 0, 30), box('c', 120, 0)])].sort()).toEqual(['a', 'b', 'c'])
  })

  it('a session keeps its name over a stage it would cover, wherever either sits', () => {
    expect([...graph3dShownLabels([box('stage', 0, 0, { depth: 0.1 }), box('session', 40, 10, { rank: 0, depth: 0.9 })])]).toEqual(['session'])
  })

  it('within a rank the nearer name wins', () => {
    expect([...graph3dShownLabels([box('far', 0, 0, { depth: 0.9 }), box('near', 50, 5, { depth: 0.2 })])]).toEqual(['near'])
  })

  it('names closer than the gap count as covering', () => {
    expect([...graph3dShownLabels([box('a', 0, 0), box('b', 0, 24)])]).toEqual(['a'])
    expect([...graph3dShownLabels([box('a', 0, 0), box('b', 0, 26)])].sort()).toEqual(['a', 'b'])
  })

  it('a name hidden by another does not hide a third', () => {
    expect([...graph3dShownLabels([box('a', 0, 0, { rank: 0 }), box('b', 60, 0), box('c', 120, 0)])].sort()).toEqual(['a', 'c'])
  })
})

describe('graph3dPixelScale', () => {
  it('draws a name the same number of pixels tall in any view', () => {
    // A 90-degree field of view: the half height of a 900 px view is 450 px at scale 1.
    expect(graph3dPixelScale(22, 900, 90)).toBeCloseTo(22 / 450, 6)
    expect(graph3dPixelScale(22, 450, 90)).toBeCloseTo(22 / 225, 6)
  })
})

describe('compositeOver', () => {
  it('draws a translucent token as it looks on the panel', () => {
    expect(compositeOver({ r: 255, g: 255, b: 255, a: 0.45 }, { r: 40, g: 40, b: 40, a: 1 })).toEqual({ r: 137, g: 137, b: 137, a: 1 })
    expect(compositeOver({ r: 217, g: 119, b: 87, a: 1 }, { r: 40, g: 40, b: 40, a: 1 })).toEqual({ r: 217, g: 119, b: 87, a: 1 })
  })
})
