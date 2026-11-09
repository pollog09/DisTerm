// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShipConfig, ShipConfigResult } from '@shared/ship-config'
import { pinNeutralMachineNoun } from '../../lib/testMachineNoun'
import { ShipProcessPanel } from './ShipProcessPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
pinNeutralMachineNoun()

const config = (over: Partial<ShipConfig> = {}): ShipConfig => ({
  machine: { kind: 'local', label: '' },
  agents: [
    { name: 'implementer', fileName: 'implementer.md', scope: 'project', overridesGlobal: true, model: 'inherit' },
    { name: 'doc-writer', fileName: 'doc-writer.md', scope: 'global' }
  ],
  commands: ['ship-change'],
  workflows: [],
  skills: [],
  mcpServers: [],
  mcpRead: false,
  pipelines: [],
  graphSource: null,
  projectGraphPath: '/p/.claude/ship-graph.json',
  globalGraphPath: '/g/ship-graph.json',
  projectGraphExists: false,
  globalGraphExists: false,
  warnings: [],
  ...over
})

let root: Root
let host: HTMLDivElement
const onReload = vi.fn()
const onOpenFile = vi.fn()

function render(
  result: ShipConfigResult | null,
  createShipGraph = vi.fn(),
  session?: { source: string; label: string },
  setAgentModel = vi.fn()
) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root.render(<ShipProcessPanel projectId="P" result={result} api={{ createShipGraph, setAgentModel }} session={session} onReload={onReload} onOpenFile={onOpenFile} />)
  })
  return createShipGraph
}

const picker = (agent: string): HTMLSelectElement => host.querySelector(`select[aria-label="Model for ${agent}"]`) as HTMLSelectElement

function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const button = (text: string, index = 0): HTMLButtonElement =>
  [...host.querySelectorAll('button')].filter((b) => b.textContent?.includes(text))[index] as HTMLButtonElement

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

describe('ShipProcessPanel', () => {
  it('says what it is doing before there is an answer', () => {
    render(null)
    expect(host.textContent).toMatch(/Reading/)
  })

  it('a failed read names the reason, says the graph still works, and offers retry', () => {
    render({ ok: false, reason: 'This SSH project is not connected.' })
    expect(host.textContent).toContain('This SSH project is not connected.')
    expect(host.textContent).toContain('still draws what it observes')
    act(() => button('Retry').click())
    expect(onReload).toHaveBeenCalled()
  })

  it('lists agents with where they come from, the override called out', () => {
    render({ ok: true, config: config() })
    expect(host.textContent).toContain('2 agents on')
    expect(host.textContent).toContain('project, overrides global')
    expect(picker('implementer').value).toBe('inherit')
    expect(host.textContent).toContain('ship-change')
    expect(host.textContent).toContain('No routing file')
  })

  it('names the SSH host when that is where the agents are', () => {
    render({ ok: true, config: config({ machine: { kind: 'ssh', label: 'build-box' } }) })
    expect(host.textContent).toContain('on build-box')
  })

  it("a team tab names the host, not the viewer's own machine", () => {
    render({ ok: true, config: config() }, vi.fn(), { source: 'relay', label: 'Ada\'s desk' })
    expect(host.textContent).toContain("2 agents on Ada's desk")
  })

  it('an SSH project on a team tab still names the SSH host', () => {
    render({ ok: true, config: config({ machine: { kind: 'ssh', label: 'build-box' } }) }, vi.fn(), { source: 'relay', label: 'Ada' })
    expect(host.textContent).toContain('on build-box')
  })

  it('a path holding something that is not a file offers neither Open nor Create', () => {
    render({ ok: true, config: config({ projectGraphBlocked: true }) })
    const row = [...host.querySelectorAll('.ship-panel__file')][0]
    expect(row.textContent).toContain('Not usable')
    expect(row.querySelector('button')).toBeNull()
  })

  it('offers Create where there is no file and Open where there is', () => {
    render({ ok: true, config: config({ globalGraphExists: true, graphSource: 'global' }) })
    expect(button('Create example')).toBeDefined()
    expect(host.textContent).toContain('Routing comes from the global ship-graph.json')
    act(() => button('Open').click())
    expect(onOpenFile).toHaveBeenCalledWith('/g/ship-graph.json', false)
  })

  it('a canvas with no folder has no project row', () => {
    render({ ok: true, config: config({ projectGraphPath: null }) })
    expect(host.textContent).not.toContain('This project')
    expect(host.textContent).toContain('All projects')
  })

  it('Create writes, reloads and opens the new file', async () => {
    const create = render({ ok: true, config: config() }, vi.fn(async () => ({ ok: true, path: '/p/.claude/ship-graph.json' })))
    await act(async () => button('Create example').click())
    expect(create).toHaveBeenCalledWith('P', 'project')
    expect(onReload).toHaveBeenCalled()
    expect(onOpenFile).toHaveBeenCalledWith('/p/.claude/ship-graph.json', false)
  })

  it('a refused Create says why and opens nothing', async () => {
    render({ ok: true, config: config() }, vi.fn(async () => ({ ok: false, reason: 'exists', message: 'Already there.' })))
    await act(async () => button('Create example').click())
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Already there.')
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('shows warnings, and the known limits', () => {
    render({ ok: true, config: config({ warnings: ['Project ship-graph.json: not valid JSON, so it was ignored.'] }) })
    expect(host.textContent).toContain('not valid JSON')
    expect(host.textContent).toContain('Workflow agent() runs')
    expect(host.textContent).toContain('no visual pipeline editor')
  })

  it('sets an agent model by scope and name, then re-reads', async () => {
    const setAgentModel = vi.fn().mockResolvedValue({ ok: true, model: 'opus' })
    render({ ok: true, config: config() }, vi.fn(), undefined, setAgentModel)
    choose(picker('implementer'), 'opus')
    await act(async () => {})
    expect(setAgentModel).toHaveBeenCalledWith('P', 'project', 'implementer', 'opus')
    expect(onReload).toHaveBeenCalled()
  })

  it('an agent with no model line says so, and a global one warns it reaches every project', () => {
    render({ ok: true, config: config() })
    const select = picker('doc-writer')
    expect(select.value).toBe('')
    expect(select.selectedOptions[0].textContent).toBe('no model set')
    expect(select.title).toContain('every project on')
    expect(picker('implementer').title).toContain('this project')
  })

  it('a refusal is shown beside the agent and nothing reloads', async () => {
    const setAgentModel = vi.fn().mockResolvedValue({ ok: false, reason: 'failed', message: 'Could not write it.' })
    render({ ok: true, config: config() }, vi.fn(), undefined, setAgentModel)
    choose(picker('doc-writer'), 'sonnet')
    await act(async () => {})
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Could not write it.')
    expect(onReload).not.toHaveBeenCalled()
  })

  it('keeps a model it cannot offer visible, and cannot edit an agent without a known file', () => {
    render({ ok: true, config: config({ agents: [{ name: 'x', scope: 'global', model: 'claude-opus-5-5' }] }) })
    const select = picker('x')
    expect(select.value).toBe('claude-opus-5-5')
    expect(select.disabled).toBe(true)
  })
})
