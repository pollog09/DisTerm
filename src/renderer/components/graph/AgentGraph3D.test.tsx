// @vitest-environment jsdom
//
// The 3D view against a stand-in for 3d-force-graph: jsdom has no WebGL, so what is checked here is
// what the component asks of the library (when the frame loop runs, what it is fed, what is given
// back on unmount), never real rendering.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MeshBasicMaterial, PerspectiveCamera, Raycaster, SphereGeometry, Vector3, type Mesh, type MeshLambertMaterial, type Object3D } from 'three'
import type { GraphEdge, GraphNode } from '../../lib/agentGraphModel'
import { useAgentGraphDisplay } from '../../state/agentGraphDisplay'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Call = { name: string; args: unknown[] }
interface Fake {
  calls: Call[]
  props: Record<string, unknown>
  canvas: HTMLCanvasElement
  renderer: { domElement: HTMLCanvasElement; forceContextLoss: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
  scene: { add: ReturnType<typeof vi.fn> }
  camera: PerspectiveCamera
  controls: { target: Vector3 }
}

const lib = vi.hoisted(() => ({ instances: [] as Fake[], throwOnCreate: false }))

vi.mock('3d-force-graph', async () => {
  const { PerspectiveCamera, Vector3 } = await import('three')
  function ForceGraph3D(this: unknown, el: HTMLElement, config: unknown) {
    if (lib.throwOnCreate) throw new Error('Error creating WebGL context.')
    const canvas = document.createElement('canvas')
    el.appendChild(canvas)
    const fake: Fake = {
      calls: [{ name: 'new', args: [config] }],
      props: {},
      canvas,
      renderer: { domElement: canvas, forceContextLoss: vi.fn(), dispose: vi.fn() },
      scene: { add: vi.fn() },
      // Where the picking tests' ray starts, so a name drawn a fixed size on screen is measured from it.
      camera: new PerspectiveCamera(),
      controls: { target: new Vector3(0, 0, 0) }
    }
    fake.camera.position.set(0, 0, 100)
    fake.camera.updateMatrixWorld()
    ;(window as unknown as { scene?: unknown }).scene = fake.scene
    lib.instances.push(fake)
    const proxy: unknown = new Proxy(fake, {
      get(target, prop: string) {
        if (prop === 'then') return undefined
        return (...args: unknown[]) => {
          target.calls.push({ name: prop, args })
          if (prop === 'renderer') return target.renderer
          if (prop === 'scene') return target.scene
          if (prop === 'camera') return target.camera
          if (prop === 'controls') return target.controls
          if (prop === 'd3Force') return args.length > 1 ? proxy : { strength: () => undefined }
          if (prop === 'emitParticle') {
            const link = args[0] as { __singleHopPhotonsObj?: { children: unknown[] } }
            ;(link.__singleHopPhotonsObj ??= { children: [] }).children.push({})
            return proxy
          }
          if (args.length === 0 && prop in target.props) return target.props[prop]
          if (args.length > 0) target.props[prop] = args[0]
          return proxy
        }
      }
    })
    return proxy
  }
  return { default: ForceGraph3D }
})

let AgentGraph3D: typeof import('./AgentGraph3D').default
let MAX_FLOW_DOTS: number

beforeAll(async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  ;({ default: AgentGraph3D } = await import('./AgentGraph3D'))
  ;({ MAX_FLOW_DOTS } = await import('../../lib/agentGraphLayout'))
})

const MOUNTED_AT = 1000
const pulseOf = (ts: number | undefined): number => (ts !== undefined && ts > MOUNTED_AT ? ts : 0)
const NODES: GraphNode[] = [
  { id: 'session:a', kind: 'session', title: 'Orchestrator', sessionId: 'a', agentId: 'claude', state: 'working' },
  { id: 'session:b', kind: 'session', title: 'Worker', sessionId: 'b', agentId: 'claude' }
]
const message = (ts?: number): GraphEdge => ({ id: 'm:a:b', source: 'session:a', target: 'session:b', kind: 'message', latest: 'delivered', ...(ts ? { lastEventTs: ts } : {}) })

let root: Root
let host: HTMLDivElement
const onNodeClick = vi.fn()
const onUnsupported = vi.fn()

function view(edges: GraphEdge[] = [message()], over: { shown?: boolean; nodes?: GraphNode[] } = {}) {
  return (
    <AgentGraph3D
      nodes={over.nodes ?? NODES}
      edges={edges}
      pulseOf={pulseOf}
      showMachine={false}
      shown={over.shown ?? true}
      onNodeClick={onNodeClick}
      onUnsupported={onUnsupported}
    />
  )
}

async function mount(edges?: GraphEdge[]): Promise<Fake> {
  host = document.createElement('div')
  // jsdom lays nothing out; a name's size on screen is worked out from the view's height.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(view(edges)))
  return lib.instances[lib.instances.length - 1]
}

/** The first session lit but waiting, not working: nothing runs, so there is no sun to grow and caption it. */
const noSun = async (): Promise<void> => act(async () => root.render(view([message()], { nodes: [{ ...NODES[0], state: 'waiting' }, NODES[1]] })))
const named = (fake: Fake, name: string): unknown[][] => fake.calls.filter((c) => c.name === name).map((c) => c.args)
/** Whether the library's loop is running, by the last pause or resume asked of it (it starts running). */
const running = (fake: Fake): boolean => {
  const last = [...fake.calls].reverse().find((c) => c.name === 'pauseAnimation' || c.name === 'resumeAnimation')
  return last ? last.name === 'resumeAnimation' : true
}
const settle = async (fake: Fake): Promise<void> => {
  await act(async () => (fake.props.onEngineStop as () => void)())
}

let reducedMotion = false
beforeEach(() => {
  lib.instances.length = 0
  lib.throwOnCreate = false
  reducedMotion = false
  onNodeClick.mockReset()
  onUnsupported.mockReset()
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce') && reducedMotion,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
  document.documentElement.removeAttribute('data-nt-window')
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  document.documentElement.removeAttribute('data-theme')
})

/** jsdom draws no canvas. Labels need only a context that answers; `null` means no label. */
const canvas2d = (works: boolean) =>
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) =>
    works && kind === '2d'
      ? { font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, textBaseline: '', measureText: () => ({ width: 120 }), beginPath() {}, roundRect() {}, fill() {}, stroke() {}, fillText() {}, fillRect() {}, arc() {}, ellipse() {}, moveTo() {}, lineTo() {}, save() {}, restore() {}, translate() {}, createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }) }
      : null) as never)
/** What the library would build for a node: the component's own `nodeThreeObject`. */
const nodeGroup = (fake: Fake, id: string): Object3D => (fake.props.nodeThreeObject as (n: { id: string; kind: string }) => Object3D)({ id, kind: 'session' })
/** Children in the order the component adds them: core, halo, aura, then the label when there is one. */
const parts = (group: Object3D) => {
  const [core, halo, aura, orbit, label] = group.children
  return { core: core as Mesh<never, MeshLambertMaterial>, halo, aura, orbit, label }
}

describe('AgentGraph3D', () => {
  it('feeds the library the same nodes and lines, and turns the camera by drag, not the nodes', async () => {
    const fake = await mount()
    expect(named(fake, 'new')[0][0]).toMatchObject({ controlType: 'orbit' })
    const data = fake.props.graphData as { nodes: { id: string }[]; links: { id: string }[] }
    expect(data.nodes.map((n) => n.id)).toEqual(['session:a', 'session:b'])
    expect(data.links.map((l) => l.id)).toEqual(['m:a:b'])
    expect(fake.props.enableNodeDrag).toBe(false)
  })

  it('a status change restyles in place and does not hand the layout new data', async () => {
    const fake = await mount()
    const fed = named(fake, 'graphData').length
    await act(async () => root.render(view([message()], { nodes: [{ ...NODES[0], state: 'waiting' }, NODES[1]] })))
    expect(named(fake, 'graphData').length).toBe(fed)
  })

  it('a status change shows on the drawn nodes and lines, without rebuilding them', async () => {
    canvas2d(false)
    const fake = await mount()
    await noSun()
    const a = parts(nodeGroup(fake, 'session:a'))
    const b = parts(nodeGroup(fake, 'session:b'))
    expect([a.halo.visible, a.aura.visible, a.core.material.emissiveIntensity]).toEqual([true, true, 0.35])
    expect([b.halo.visible, b.core.material.emissiveIntensity]).toEqual([false, 0])
    const linkStyled = named(fake, 'linkColor').length
    await act(async () => root.render(view([message()], { nodes: [{ ...NODES[0], state: undefined }, { ...NODES[1], state: 'waiting' }] })))
    expect([a.halo.visible, a.aura.visible, a.core.material.emissiveIntensity]).toEqual([false, false, 0])
    expect([b.halo.visible, b.core.material.emissiveIntensity]).toEqual([true, 0.35])
    expect(named(fake, 'linkColor').length).toBeGreaterThan(linkStyled)
  })

  it('a theme change re-resolves every colour', async () => {
    canvas2d(false)
    // jsdom resolves no theme, so the computed colour stands in for one: dark, then light.
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () => ({ color: document.documentElement.dataset.theme === 'light' ? 'rgb(10, 20, 30)' : 'rgb(200, 100, 50)' }) as CSSStyleDeclaration
    )
    const fake = await mount()
    const a = parts(nodeGroup(fake, 'session:a'))
    expect(a.core.material.color.getHexString()).toBe('c86432')
    const linkColor = () => (fake.props.linkColor as (l: { id: string }) => string)({ id: 'm:a:b' })
    expect(linkColor()).toBe('rgba(200, 100, 50, 1)')
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'light')
      await Promise.resolve()
    })
    expect(a.core.material.color.getHexString()).toBe('0a141e')
    expect(linkColor()).toBe('rgba(10, 20, 30, 1)')
  })

  it('a click on a session hands back the model node, as the 2D box does', async () => {
    const fake = await mount()
    await act(async () => (fake.props.onNodeClick as (n: { id: string }) => void)({ id: 'session:b' }))
    expect(onNodeClick).toHaveBeenCalledWith(NODES[1])
  })

  it('hover shows what the box says', async () => {
    const fake = await mount()
    await act(async () => (fake.props.onNodeHover as (n: { id: string } | null) => void)({ id: 'session:a' }))
    const tip = host.querySelector('[role="tooltip"]')
    expect([...(tip?.children ?? [])].map((c) => c.textContent)).toEqual(['Orchestrator', 'Claude Code · working'])
    await act(async () => (fake.props.onNodeHover as (n: null) => void)(null))
    expect(host.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('the Fit control frames the graph', async () => {
    const fake = await mount()
    const fit = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Fit')!
    await act(async () => fit.click())
    expect(named(fake, 'zoomToFit').at(-1)).toEqual([600, 40])
  })

  it('no WebGL: says so through onUnsupported, and leaves nothing behind', async () => {
    lib.throwOnCreate = true
    await mount()
    expect(onUnsupported).toHaveBeenCalledWith(expect.stringContaining('needs WebGL'))
    expect(host.querySelector('canvas')).toBeNull()
  })

  it('a lost context hands back to 2D', async () => {
    const fake = await mount()
    await act(async () => fake.canvas.dispatchEvent(new Event('webglcontextlost')))
    expect(onUnsupported).toHaveBeenCalledWith(expect.stringContaining('lost its graphics context'))
  })

  it('unmounting disposes the scene, the controls and the renderer, and gives the context back', async () => {
    const fake = await mount()
    await act(async () => root.unmount())
    expect(named(fake, 'pauseAnimation').length).toBeGreaterThan(0)
    expect(named(fake, '_destructor')).toHaveLength(1)
    expect(fake.renderer.forceContextLoss).toHaveBeenCalledTimes(1)
    expect(fake.canvas.isConnected).toBe(false)
    expect((window as unknown as { scene?: unknown }).scene).toBeUndefined()
  })
})

describe('picking', () => {
  // three's raycaster ignores `visible`, and the library ranks any node hit above any line hit, so a
  // glow shell that took part would steal hovers from lines and clicks from the node behind it.
  const camera = new PerspectiveCamera()
  camera.position.set(0, 0, 100)
  camera.updateMatrixWorld()
  const hits = (group: Object3D, x: number, y: number): Object3D[] => {
    const ray = new Raycaster(new Vector3(x, y, 100), new Vector3(0, 0, -1))
    ray.camera = camera
    return ray.intersectObject(group, true).map((h) => h.object)
  }

  it('the glow shells let the pointer through, lit or not; the core and the label take it', async () => {
    canvas2d(true)
    const fake = await mount()
    await noSun()
    for (const id of ['session:a', 'session:b']) {
      const group = nodeGroup(fake, id)
      group.updateMatrixWorld(true)
      const { core, halo, aura, label } = parts(group)
      expect(label, id).toBeDefined()
      expect(new Set(hits(group, 0, 0)), id).toEqual(new Set([core]))
      // Outside the core (radius 7), inside the halo (10.85) and the aura (15.4).
      expect(hits(group, 10, 0), id).toEqual([])
      expect(hits(group, 0, -13), id).toEqual([])
      // The name stands on the node's top (7 + 1.2) and is 22 px tall: 3.4 units from 100 away in a
      // 600 px view at three's default 50-degree field of view.
      expect(hits(group, 0, 10), id).toEqual([label])
      expect(hits(group, 0, 12.5), id).toEqual([])
      expect([halo, aura].some((o) => hits(group, 0, 0).includes(o))).toBe(false)
    }
  })
})

describe('names on screen', () => {
  const camera = new PerspectiveCamera()
  camera.position.set(0, 0, 100)
  camera.updateMatrixWorld()
  const hits = (group: Object3D, x: number, y: number): Object3D[] => {
    const ray = new Raycaster(new Vector3(x, y, 100), new Vector3(0, 0, -1))
    ray.camera = camera
    return ray.intersectObject(group, true).map((h) => h.object)
  }
  /** One frame's label pass: the component hangs it on the sky, which is drawn every frame. */
  const frame = (fake: Fake): void => {
    const sky = fake.scene.add.mock.calls.map((c) => c[0] as Object3D).find((o) => o.constructor.name === 'Points')
    sky!.onBeforeRender()
  }

  it('of two names on the same spot, one shows; the other hides and stops taking the pointer', async () => {
    canvas2d(true)
    const fake = await mount()
    await noSun()
    const a = nodeGroup(fake, 'session:a')
    const b = nodeGroup(fake, 'session:b')
    frame(fake)
    const [labelA, labelB] = [parts(a).label, parts(b).label]
    expect([labelA.visible, labelB.visible]).toEqual([true, false])
    a.updateMatrixWorld(true)
    b.updateMatrixWorld(true)
    expect(hits(a, 0, 10)).toEqual([labelA])
    expect(hits(b, 0, 10)).toEqual([])
    b.position.set(40, 0, 0)
    frame(fake)
    expect([labelA.visible, labelB.visible]).toEqual([true, true])
    b.updateMatrixWorld(true)
    expect(hits(b, 40, 10)).toEqual([labelB])
  })
})

describe('planets', () => {
  const camera = new PerspectiveCamera()
  camera.position.set(0, 0, 100)
  camera.updateMatrixWorld()
  const hits = (group: Object3D, x: number, y: number): Object3D[] => {
    const ray = new Raycaster(new Vector3(x, y, 100), new Vector3(0, 0, -1))
    ray.camera = camera
    return ray.intersectObject(group, true).map((h) => h.object)
  }
  const HARNESS: GraphNode = { id: 'h', kind: 'harness', title: 'Harness' }
  const withHarness = async (state?: string) =>
    act(async () => root.render(view([message()], { nodes: [{ ...NODES[0], ...(state ? { state } : {}) }, NODES[1], HARNESS] })))

  it('a ringed world wears two rings, and neither ring nor haze takes the pointer anywhere', async () => {
    canvas2d(true)
    const fake = await mount()
    await withHarness()
    const ringed = nodeGroup(fake, 'h')
    const hazy = nodeGroup(fake, 'session:a')
    for (const group of [ringed, hazy]) group.updateMatrixWorld(true)
    expect(parts(ringed).core.children).toHaveLength(2)
    expect(parts(hazy).core.children).toHaveLength(1)
    for (const group of [ringed, hazy]) {
      const { core, label } = parts(group)
      const taken = new Set<Object3D>()
      for (let x = -15; x <= 15; x++) for (let y = -15; y <= 15; y++) for (const o of hits(group, x, y)) taken.add(o)
      expect([...taken].every((o) => o === core || o === label)).toBe(true)
      expect(taken.has(core)).toBe(true)
    }
  })

  it('a world is painted once, kept through a status change, and given back on unmount', async () => {
    canvas2d(true)
    const fake = await mount()
    await withHarness()
    const { core } = parts(nodeGroup(fake, 'session:a'))
    const map = core.material.map
    expect(map).not.toBeNull()
    const dispose = vi.spyOn(map!, 'dispose')
    await withHarness('waiting')
    expect(core.material.map).toBe(map)
    await act(async () => root.unmount())
    expect(dispose).toHaveBeenCalled()
  })

  it('with no 2D canvas, a world is its plain colour', async () => {
    canvas2d(false)
    const fake = await mount()
    const { core } = parts(nodeGroup(fake, 'session:a'))
    expect(core.material.map).toBeNull()
    expect(core.material.color.getHexString()).toBe('d97757')
  })
})

describe('the current step', () => {
  /** The layer of light the component adds to the scene: the corona first, then each world's glow. */
  const lightLayer = (fake: Fake): Object3D =>
    fake.scene.add.mock.calls.map((c) => c[0] as Object3D).find((o) => o.constructor.name === 'Group')!
  const render = async (nodes: GraphNode[]) => act(async () => root.render(view([message()], { nodes })))

  it('a working session is the sun: drawn larger, its corona lit, its name captioned and never giving way', async () => {
    canvas2d(true)
    const fake = await mount()
    const sun = nodeGroup(fake, 'session:a')
    const other = nodeGroup(fake, 'session:b')
    await render([...NODES])
    const [corona] = lightLayer(fake).children
    expect(corona.visible).toBe(true)
    expect(parts(sun).core.scale.x).toBeCloseTo(1.7)
    expect(parts(other).core.scale.x).toBe(1)
    expect(parts(sun).label.scale.y).toBeGreaterThan(parts(other).label.scale.y * 1.5)
  })

  it('with nothing running there is no sun', async () => {
    canvas2d(true)
    const fake = await mount()
    const a = nodeGroup(fake, 'session:a')
    await render([{ ...NODES[0], state: 'idle' }, NODES[1]])
    expect(lightLayer(fake).children[0].visible).toBe(false)
    expect(parts(a).core.scale.x).toBe(1)
  })

  it('a world that leaves takes its glow with it', async () => {
    canvas2d(true)
    const fake = await mount()
    nodeGroup(fake, 'session:a')
    nodeGroup(fake, 'session:b')
    const layer = lightLayer(fake)
    expect(layer.children).toHaveLength(3)
    await act(async () => root.render(view([], { nodes: [NODES[0]] })))
    expect(layer.children).toHaveLength(2)
  })
})

describe('flying', () => {
  const view3d = (): HTMLElement => host.querySelector<HTMLElement>('[data-testid="agent-graph-3d"]')!
  const press = (code: string, mods: KeyboardEventInit = {}, on: Element = view3d()): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...mods })
    on.dispatchEvent(e)
    return e
  }
  const release = (code: string): void => {
    view3d().dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }))
  }
  const frame = (fake: Fake): void => {
    const sky = fake.scene.add.mock.calls.map((c) => c[0] as Object3D).find((o) => o.constructor.name === 'Points')
    sky!.onBeforeRender()
  }
  const at = (fake: Fake) => [+fake.camera.position.z.toFixed(3), +fake.controls.target.z.toFixed(3)]

  beforeEach(() => useAgentGraphDisplay.setState({ flyHelp: true }))

  it('W moves the camera and the point it turns round together, while it is held', async () => {
    const fake = await mount()
    press('KeyW')
    frame(fake)
    // 100 from the target, at 35% of that a second, for the first frame's 1/60 s.
    expect(at(fake)).toEqual([99.417, -0.583])
    release('KeyW')
    frame(fake)
    expect(at(fake)).toEqual([99.417, -0.583])
  })

  it('the fly keys stop at the view, Space does not scroll, and every other key goes on to the app', async () => {
    await mount()
    const seen: string[] = []
    const onWindow = (e: KeyboardEvent): void => void seen.push(e.code)
    window.addEventListener('keydown', onWindow)
    try {
      const space = press('Space')
      press('KeyW')
      expect(space.defaultPrevented).toBe(true)
      expect(seen).toEqual([])
      press('KeyW', { metaKey: true })
      press('KeyW', { ctrlKey: true })
      press('KeyJ')
      expect(seen).toEqual(['KeyW', 'KeyW', 'KeyJ'])
    } finally {
      window.removeEventListener('keydown', onWindow)
    }
  })

  it('a chord with Cmd or Ctrl does not fly', async () => {
    const fake = await mount()
    press('KeyW', { metaKey: true })
    press('KeyS', { ctrlKey: true })
    frame(fake)
    expect(at(fake)).toEqual([100, 0])
  })

  it('leaving the view lets go of every key, as no keyup will come', async () => {
    const fake = await mount()
    press('KeyW')
    await act(async () => void view3d().dispatchEvent(new FocusEvent('blur')))
    frame(fake)
    expect(at(fake)).toEqual([100, 0])
  })

  it("a key on one of the view's buttons is that button's", async () => {
    const fake = await mount()
    const fit = host.querySelector('button')!
    const e = press('Space', {}, fit)
    frame(fake)
    expect(e.defaultPrevented).toBe(false)
    expect(at(fake)).toEqual([100, 0])
  })

  it('frames keep running while a key is held, and stop after', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    const fake = await mount()
    await settle(fake)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(running(fake)).toBe(false)
    await act(async () => void press('KeyD'))
    expect(running(fake)).toBe(true)
    await act(async () => {
      release('KeyD')
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(running(fake)).toBe(false)
  })

  it('the card of keys hides, is remembered hidden, and comes back from Keys', async () => {
    await mount()
    expect(host.querySelector('.agent-graph-3d__keys')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('.agent-graph-3d__keys-hide')!.click())
    expect(host.querySelector('.agent-graph-3d__keys')).toBeNull()
    expect(localStorage.getItem('nodeterm.agentGraphFlyHelp')).toBe('hidden')
    const keys = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Keys')!
    await act(async () => keys.click())
    expect(host.querySelector('.agent-graph-3d__keys')).not.toBeNull()
  })

  it('the card says where the keys go', async () => {
    await mount()
    const hint = () => host.querySelector('.agent-graph-3d__keys-hint')!.textContent
    expect(hint()).toBe('Click the graph, then fly.')
    await act(async () => view3d().focus())
    expect(hint()).toBe('Keys go to the graph.')
  })
})

describe('the 3D frame loop', () => {
  it('stops once the layout has settled and nobody points at it, and runs again under the pointer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    const fake = await mount()
    expect(running(fake)).toBe(true)
    await settle(fake)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(running(fake)).toBe(false)
    await act(async () => host.querySelector('.agent-graph-3d')!.dispatchEvent(new Event('pointerenter')))
    expect(running(fake)).toBe(true)
  })

  it('pauses while the window is idle, and resumes when it is looked at again', async () => {
    const fake = await mount()
    expect(running(fake)).toBe(true)
    await act(async () => {
      document.documentElement.setAttribute('data-nt-window', 'idle')
      await Promise.resolve()
    })
    expect(running(fake)).toBe(false)
    await act(async () => {
      document.documentElement.removeAttribute('data-nt-window')
      await Promise.resolve()
    })
    expect(running(fake)).toBe(true)
  })

  it('pauses while the page is hidden', async () => {
    const fake = await mount()
    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(running(fake)).toBe(false)
  })

  it('pauses while the terminal modal covers it', async () => {
    const fake = await mount()
    await act(async () => root.render(view([message()], { shown: false })))
    expect(running(fake)).toBe(false)
  })

  // The layout's cooldown runs on the wall clock from the last data update, but the layout only moves on
  // frames. A structure change while paused, then a pause longer than the cooldown, used to stop the
  // engine on the first frame with no layout done, and the camera framed a pile of unplaced nodes.
  const third: GraphNode = { id: 'session:c', kind: 'session', title: 'Reviewer', sessionId: 'c', agentId: 'claude' }
  const order = (fake: Fake): string[] => fake.calls.map((c) => c.name).filter((n) => n === 'd3ReheatSimulation' || n === 'resumeAnimation' || n === 'pauseAnimation')

  it('a structure change while covered restarts the cooldown before frames resume', async () => {
    const fake = await mount()
    await act(async () => root.render(view([message()], { shown: false })))
    await act(async () => root.render(view([message()], { shown: false, nodes: [...NODES, third] })))
    expect(running(fake)).toBe(false)
    const before = order(fake).length
    await act(async () => root.render(view([message()], { nodes: [...NODES, third] })))
    expect(order(fake).slice(before)).toEqual(['d3ReheatSimulation', 'resumeAnimation'])
  })

  it('a settled layout is not reheated when frames resume, and a stopped loop is never reheated', async () => {
    const fake = await mount()
    await settle(fake)
    await act(async () => root.render(view([message()], { shown: false })))
    expect(named(fake, 'd3ReheatSimulation')).toHaveLength(0)
    await act(async () => root.render(view([message()])))
    expect(running(fake)).toBe(true)
    expect(named(fake, 'd3ReheatSimulation')).toHaveLength(0)
  })

  it('a window gone idle mid-layout gets the same restart when it is looked at again', async () => {
    const fake = await mount()
    await act(async () => {
      document.documentElement.setAttribute('data-nt-window', 'idle')
      await Promise.resolve()
    })
    expect(running(fake)).toBe(false)
    expect(named(fake, 'd3ReheatSimulation')).toHaveLength(0)
    const before = order(fake).length
    await act(async () => {
      document.documentElement.removeAttribute('data-nt-window')
      await Promise.resolve()
    })
    expect(order(fake).slice(before)).toEqual(['d3ReheatSimulation', 'resumeAnimation'])
  })
})

describe('particles', () => {
  it('one per new event, none for what happened before the view, at most MAX_FLOW_DOTS on a line', async () => {
    const fake = await mount([message(500)])
    expect(named(fake, 'emitParticle')).toHaveLength(0)
    await act(async () => root.render(view([message(2000)])))
    expect(named(fake, 'emitParticle')).toHaveLength(1)
    await act(async () => root.render(view([message(2000)])))
    expect(named(fake, 'emitParticle')).toHaveLength(1)
    for (const ts of [3000, 4000, 5000, 6000]) await act(async () => root.render(view([message(ts)])))
    expect(named(fake, 'emitParticle')).toHaveLength(MAX_FLOW_DOTS)
  })

  it('an event already on screen when 3D opens does not replay', async () => {
    const fake = await mount([message(2000)])
    expect(named(fake, 'emitParticle')).toHaveLength(0)
  })

  it('runs backwards on a line whose data flows against the way it points', async () => {
    const fake = await mount()
    const speed = fake.props.linkDirectionalParticleSpeed as (l: { id: string }) => number
    await act(async () => root.render(view([message(), { id: 'h', source: 'session:a', target: 'session:b', kind: 'harness', flow: 'reverse' }])))
    expect(speed({ id: 'm:a:b' })).toBeGreaterThan(0)
    expect(speed({ id: 'h' })).toBeLessThan(0)
  })

  describe('the particle object', () => {
    const params = (m: Mesh): { radius: number; widthSegments: number } => (m.geometry as unknown as { parameters: { radius: number; widthSegments: number } }).parameters
    type Build = (l: { id: string }) => Mesh
    const build = async (): Promise<{ fake: Fake; make: Build }> => {
      const fake = await mount()
      return { fake, make: fake.props.linkDirectionalParticleThreeObject as Build }
    }

    it('is a smooth unlit sphere with a faint halo', async () => {
      const { make } = await build()
      const s = make({ id: 'm:a:b' })
      expect(s.geometry).toBeInstanceOf(SphereGeometry)
      expect(params(s).widthSegments).toBeGreaterThanOrEqual(12)
      expect(s.material).toBeInstanceOf(MeshBasicMaterial)
      expect(s.children).toHaveLength(1)
      const halo = s.children[0] as Mesh
      expect(halo.geometry).toBeInstanceOf(SphereGeometry)
      expect(params(halo).radius).toBeGreaterThan(params(s).radius)
      const hm = halo.material as MeshBasicMaterial
      expect(hm.transparent).toBe(true)
      expect(hm.depthWrite).toBe(false)
    })

    it("shares the photon's own geometry and material, and builds only the halo fresh", async () => {
      const { make } = await build()
      const a = make({ id: 'm:a:b' })
      const b = make({ id: 'm:a:b' })
      expect(a).not.toBe(b)
      expect(a.geometry).toBe(b.geometry)
      expect(a.material).toBe(b.material)
      const [ha, hb] = [a.children[0] as Mesh, b.children[0] as Mesh]
      expect(ha.geometry).not.toBe(hb.geometry)
      expect(ha.material).not.toBe(hb.material)
      expect(ha.geometry).not.toBe(a.geometry)
      expect(ha.material).not.toBe(a.material)
    })

    it("a loop line's photon has its own, larger geometry", async () => {
      const { fake } = await build()
      await act(async () => root.render(view([message(), { id: 'r', source: 'session:a', target: 'session:b', kind: 'ship-reject', loop: true, traversals: 1 }])))
      const make = fake.props.linkDirectionalParticleThreeObject as Build
      const loop = make({ id: 'r' })
      const plain = make({ id: 'm:a:b' })
      expect(loop.geometry).not.toBe(plain.geometry)
      expect(params(loop).radius).toBeGreaterThan(params(plain).radius)
      expect(make({ id: 'r' }).geometry).toBe(loop.geometry)
    })

    it('the shared parts are given back on unmount, the halo is left to the library', async () => {
      const { make } = await build()
      const a = make({ id: 'm:a:b' })
      const halo = a.children[0] as Mesh
      type Target = { addEventListener(t: string, f: () => void): void }
      const onGeometry = vi.fn()
      const onMaterial = vi.fn()
      const onHalo = vi.fn()
      ;(a.geometry as unknown as Target).addEventListener('dispose', onGeometry)
      ;(a.material as unknown as Target).addEventListener('dispose', onMaterial)
      ;(halo.geometry as unknown as Target).addEventListener('dispose', onHalo)
      expect(onGeometry).not.toHaveBeenCalled()
      expect(onMaterial).not.toHaveBeenCalled()
      expect(onHalo).not.toHaveBeenCalled()
      await act(async () => root.unmount())
      expect(onGeometry).toHaveBeenCalledTimes(1)
      expect(onMaterial).toHaveBeenCalledTimes(1)
      expect(onHalo).not.toHaveBeenCalled()
    })

    it('never takes the pointer', async () => {
      const { fake, make } = await build()
      const s = make({ id: 'm:a:b' })
      s.position.set(0, 0, 0)
      s.updateMatrixWorld(true)
      const ray = new Raycaster(new Vector3(0, 0, 100), new Vector3(0, 0, -1))
      ray.camera = fake.camera
      expect(ray.intersectObject(s, true)).toEqual([])
    })

    it('a link the model dropped still gets a particle', async () => {
      const { make } = await build()
      expect(() => make({ id: 'nope' })).not.toThrow()
      expect(make({ id: 'nope' }).geometry).toBeInstanceOf(SphereGeometry)
    })

    it('the old width and colour knobs are gone', async () => {
      const { fake } = await build()
      expect(fake.props.linkDirectionalParticleWidth).toBeUndefined()
      expect(fake.props.linkDirectionalParticleColor).toBeUndefined()
    })
  })
})

describe('under reduced motion', () => {
  beforeEach(() => {
    reducedMotion = true
  })

  it('the layout is computed before the first frame and never animates', async () => {
    const fake = await mount()
    expect(fake.props.warmupTicks).toBe(300)
    expect(fake.props.cooldownTicks).toBe(0)
  })

  it('no particles', async () => {
    const fake = await mount()
    await act(async () => root.render(view([message(2000)])))
    expect(named(fake, 'emitParticle')).toHaveLength(0)
  })

  it('a restart after a pause still settles at once: the layout keeps no cooldown to animate', async () => {
    const fake = await mount()
    await act(async () => root.render(view([message()], { shown: false })))
    await act(async () => root.render(view([message()])))
    expect(named(fake, 'd3ReheatSimulation')).toHaveLength(1)
    expect(fake.props.cooldownTicks).toBe(0)
    expect(fake.props.warmupTicks).toBe(300)
  })

  it('the camera jumps instead of flying', async () => {
    const fake = await mount()
    await settle(fake)
    expect(named(fake, 'zoomToFit').at(-1)).toEqual([0, 40])
    const fit = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Fit')!
    await act(async () => fit.click())
    expect(named(fake, 'zoomToFit').at(-1)).toEqual([0, 40])
  })
})

describe('live subagents', () => {
  const LIVE = [
    { id: 'r1', type: 'Explore', startedAt: 1 },
    { id: 'r2', type: 'Explore', startedAt: 2 },
    { id: 'r3', type: 'Explore', startedAt: 3 }
  ]
  const busy: GraphNode[] = [
    { id: 'session:a', kind: 'session', title: 'Orchestrator', sessionId: 'a', agentId: 'claude', state: 'working' },
    { id: 'sub:a:Explore', kind: 'subagent', title: 'Explore', sessionId: 'a', activity: 'running', runs: 3, live: LIVE }
  ]
  const spawned: GraphEdge = { id: 'spawned:a:Explore', source: 'session:a', target: 'sub:a:Explore', kind: 'spawned', traversals: 3, running: true, movedAt: 2 }

  const camera = new PerspectiveCamera()
  camera.position.set(0, 0, 100)
  camera.updateMatrixWorld()
  const hits = (group: Object3D, x: number, y: number): Object3D[] => {
    const ray = new Raycaster(new Vector3(x, y, 100), new Vector3(0, 0, -1))
    ray.camera = camera
    return ray.intersectObject(group, true).map((h) => h.object)
  }

  async function mountBusy(nodes: GraphNode[] = busy, edges: GraphEdge[] = [spawned]): Promise<Fake> {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => root.render(view(edges, { nodes })))
    return lib.instances[lib.instances.length - 1]
  }

  it('each live run is a satellite of its box, and none takes the pointer', async () => {
    canvas2d(true)
    const fake = await mountBusy()
    const group = nodeGroup(fake, 'sub:a:Explore')
    group.updateMatrixWorld(true)
    const { core, orbit } = parts(group)
    expect(orbit.children).toHaveLength(3)
    // A ray through every satellite's position hits nothing but what was already pickable.
    for (const sat of orbit.children) {
      expect(hits(group, sat.position.x, sat.position.y).filter((o) => orbit.children.includes(o))).toEqual([])
    }
    expect(hits(group, 0, 0)).toContain(core)
  })

  it('a run that ends takes its satellite away', async () => {
    canvas2d(true)
    const fake = await mountBusy()
    await act(async () => root.render(view([spawned], { nodes: [busy[0], { ...busy[1], live: LIVE.slice(1) }] })))
    expect(parts(nodeGroup(fake, 'sub:a:Explore')).orbit.children).toHaveLength(2)
  })

  it('keeps frames while something runs, streams along the running line, and stops when it is over', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    const fake = await mountBusy()
    await settle(fake)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(running(fake)).toBe(true)
    expect(named(fake, 'emitParticle').length).toBeGreaterThanOrEqual(2)
    const done: GraphNode[] = [busy[0], { ...busy[1], activity: 'done', live: undefined }]
    await act(async () => root.render(view([{ ...spawned, running: undefined, movedAt: undefined }], { nodes: done })))
    // The stand-in's particles never land; the real ones do within a couple of seconds.
    for (const l of (fake.props.graphData as { links: Array<{ __singleHopPhotonsObj?: { children: unknown[] } }> }).links) l.__singleHopPhotonsObj?.children.splice(0)
    const before = named(fake, 'emitParticle').length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(running(fake)).toBe(false)
    expect(named(fake, 'emitParticle').length).toBe(before)
  })

  it('under reduced motion, nothing runs for it and nothing streams', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    reducedMotion = true
    const fake = await mountBusy()
    await settle(fake)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(running(fake)).toBe(false)
    expect(named(fake, 'emitParticle')).toEqual([])
  })

  it('an idle window stops it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    const fake = await mountBusy()
    await settle(fake)
    await act(async () => {
      document.documentElement.setAttribute('data-nt-window', 'idle')
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(running(fake)).toBe(false)
  })
})

describe('the optional props the system map uses', () => {
  const pinnedView = (over: Partial<import('./AgentGraph3D').AgentGraph3DProps> = {}) => (
    <AgentGraph3D nodes={NODES} edges={[message()]} pulseOf={pulseOf} showMachine={false} shown onNodeClick={onNodeClick} onUnsupported={onUnsupported} {...over} />
  )
  const mountWith = async (over: Partial<import('./AgentGraph3D').AgentGraph3DProps>): Promise<Fake> => {
    host = document.createElement('div')
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => root.render(pinnedView(over)))
    return lib.instances[lib.instances.length - 1]
  }
  type FedNode = { id: string; fx?: number; fy?: number; fz?: number }
  const fed = (fake: Fake): FedNode[] => (fake.props.graphData as { nodes: FedNode[] }).nodes

  it('pinned sets fx/fy/fz on the node objects, and a node no longer pinned is let go', async () => {
    const fake = await mountWith({ pinned: new Map([['session:a', { x: 1, y: 2, z: 3 }], ['session:b', { x: -4, y: 5, z: -6 }]]) })
    expect(fed(fake).map((n) => [n.id, n.fx, n.fy, n.fz])).toEqual([
      ['session:a', 1, 2, 3],
      ['session:b', -4, 5, -6]
    ])
    await act(async () => root.render(pinnedView({ pinned: new Map([['session:a', { x: 7, y: 8, z: 9 }]]) })))
    const nodes = fed(fake)
    expect([nodes[0].fx, nodes[0].fy, nodes[0].fz]).toEqual([7, 8, 9])
    expect(nodes[1]).not.toHaveProperty('fx')
    expect(nodes[1]).not.toHaveProperty('fy')
    expect(nodes[1]).not.toHaveProperty('fz')
  })

  it('without pinned no node is fixed', async () => {
    const fake = await mount()
    for (const n of fed(fake)) expect(n.fx ?? n.fy ?? n.fz).toBeUndefined()
  })

  it('describeNode and describeEdge drive the hover text', async () => {
    const fake = await mountWith({ describeNode: (n) => [`Part ${n.title}`, 'Service part'], describeEdge: (e) => [`Line ${e.id}`] })
    await act(async () => (fake.props.onNodeHover as (n: { id: string } | null) => void)({ id: 'session:a' }))
    const tip = () => [...(host.querySelector('[role="tooltip"]')?.children ?? [])].map((c) => c.textContent)
    expect(tip()).toEqual(['Part Orchestrator', 'Service part'])
    await act(async () => (fake.props.onNodeHover as (n: null) => void)(null))
    await act(async () => (fake.props.onLinkHover as (l: { id: string } | null) => void)({ id: 'm:a:b' }))
    expect(tip()).toEqual(['Line m:a:b'])
  })

  it('clickHint null hides the Click row of the key card; a string replaces it; absent keeps Open terminal', async () => {
    useAgentGraphDisplay.setState({ flyHelp: true })
    const rows = () => [...host.querySelectorAll('.agent-graph-3d__keys-row dd')].map((d) => d.textContent)
    await mountWith({ clickHint: null })
    expect(rows()).toEqual(['Fly around', 'Up and down', 'Turn the view', 'Zoom'])
    await act(async () => root.render(pinnedView({ clickHint: 'Show the part' })))
    expect(rows().at(-1)).toBe('Show the part')
    await act(async () => root.render(pinnedView({})))
    expect(rows().at(-1)).toBe('Open terminal')
  })

  it('ariaLabel names the view; the default is the agent graph\'s', async () => {
    await mountWith({ ariaLabel: 'System map in 3D. Fly with W A S D, Space and Shift; drag to turn.' })
    expect(host.querySelector('[data-testid="agent-graph-3d"]')!.getAttribute('aria-label')).toBe('System map in 3D. Fly with W A S D, Space and Shift; drag to turn.')
    await act(async () => root.render(pinnedView({})))
    expect(host.querySelector('[data-testid="agent-graph-3d"]')!.getAttribute('aria-label')).toBe('Agent graph in 3D. Fly with W A S D, Space and Shift; drag to turn.')
  })
})
