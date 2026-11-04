// @vitest-environment jsdom
//
// Every section renders whenever Settings is open, visible or not, so this one must not read or poll
// a machine's config until it is the one on screen.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pinNeutralMachineNoun } from '../../../lib/testMachineNoun'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
pinNeutralMachineNoun()

const graph = vi.hoisted(() => ({
  readShipConfig: vi.fn(async () => ({ ok: true, config: {
    machine: { kind: 'local', label: '' }, agents: [{ name: 'implementer', scope: 'global' }], commands: [], workflows: [], skills: [], mcpServers: [], mcpRead: false,
    pipelines: [], graphSource: null, projectGraphPath: '/p/x', globalGraphPath: '/g/x', projectGraphExists: true, globalGraphExists: false, warnings: []
  } })),
  createShipGraph: vi.fn(),
  onShipConfigChanged: vi.fn(() => () => {}),
  snapshot: vi.fn(),
  onEvent: vi.fn()
}))

vi.mock('../../../session/session', () => {
  // One object, like the real registry: the hook's effect is keyed on the api's identity.
  const session = { source: 'local', label: 'This computer', api: { agentGraph: graph } }
  const relay = { source: 'relay', label: "Ada's desk", api: { agentGraph: graph } }
  return { sessionForProject: (id: string) => (id === 'TEAM' ? relay : session) }
})

let ShipProcessSection: typeof import('./ShipProcessSection').ShipProcessSection
let useProjects: typeof import('../../../state/projects').useProjects

beforeAll(async () => {
  ;({ ShipProcessSection } = await import('./ShipProcessSection'))
  ;({ useProjects } = await import('../../../state/projects'))
})

let root: Root
let host: HTMLDivElement
const onClose = vi.fn()

async function render(isActive: boolean): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<ShipProcessSection isActive={isActive} onClose={onClose} />)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useProjects.setState({ activeProjectId: 'P' })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('ShipProcessSection', () => {
  it('reads nothing while it is not the visible section', async () => {
    await render(false)
    expect(graph.readShipConfig).not.toHaveBeenCalled()
    expect(graph.onShipConfigChanged).not.toHaveBeenCalled()
  })

  it('reads and subscribes for the active project once visible, and shows its agents', async () => {
    await render(true)
    expect(graph.readShipConfig).toHaveBeenCalledWith('P')
    expect(graph.onShipConfigChanged).toHaveBeenCalledWith('P', expect.any(Function))
    expect(host.textContent).toContain('implementer')
  })

  it('Open closes Settings and asks the canvas to open the file', async () => {
    await render(true)
    const seen: unknown[] = []
    const listener = (e: Event): void => {
      seen.push((e as CustomEvent).detail)
    }
    window.addEventListener('nodeterm:open-file', listener)
    const open = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Open') as HTMLButtonElement
    await act(async () => open.click())
    window.removeEventListener('nodeterm:open-file', listener)
    expect(onClose).toHaveBeenCalled()
    expect(seen).toEqual([{ path: '/p/x', ssh: false }])
  })

  it('names the host on a team project', async () => {
    useProjects.setState({ activeProjectId: 'TEAM' })
    await render(true)
    expect(host.textContent).toContain("on Ada's desk")
  })

  it("drops the old project's config the moment the active project changes", async () => {
    await render(true)
    expect(host.textContent).toContain('implementer')
    graph.readShipConfig.mockImplementationOnce(() => new Promise(() => {}))
    await act(async () => useProjects.setState({ activeProjectId: 'OTHER' }))
    expect(host.textContent).not.toContain('implementer')
    expect(host.textContent).toContain('Reading')
  })

  it('with no project it says so, and reads nothing', async () => {
    useProjects.setState({ activeProjectId: null as unknown as string })
    await render(true)
    expect(host.textContent).toContain('Open a project')
    expect(graph.readShipConfig).not.toHaveBeenCalled()
  })
})
