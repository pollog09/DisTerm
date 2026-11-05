import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CanvasNodeState, Project, ProjectKanban } from '@shared/types'
import { useProjects } from '../state/projects'
import { flowToNodeStates, nodeStatesToFlow, type CanvasNode } from '../state/workspace'
import { disInvoiceCanvas } from './disInvoiceCanvas'
import { disInvoiceStickyFactory } from './disInvoiceSync'

const REF = { taskId: 1, columnaId: 1, textHash: 'abc' }

const sticky = (id: string, text = id): CanvasNodeState => ({
  id,
  kind: 'sticky',
  position: { x: 0, y: 0 },
  size: { width: 1, height: 1 },
  title: 'Note',
  color: '#fff',
  group: null,
  text
})

const project = (id: string, nodes: CanvasNodeState[] = []): Project => ({
  id,
  name: id,
  color: '#111',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes,
  cwd: `/work/${id}`
})

const BOARD: ProjectKanban = { columns: [], assignments: [] }

function harness(flowProjectId: string) {
  let flow: CanvasNode[] = nodeStatesToFlow([sticky('live-note', 'on the canvas')])
  const log: string[] = []
  const canvas = disInvoiceCanvas({
    flowProjectId: () => flowProjectId,
    flowNodes: () => flow,
    setFlowNodes: (next) => {
      flow = next
      log.push(`flow ${next.map((n) => n.id).join(',')}`)
    },
    castNewNode: (projectId, node) => log.push(`cast ${projectId} ${node.id}`),
    markDirty: () => log.push('dirty')
  })
  return { canvas, log, flow: () => flow }
}

const textOf = (nodes: CanvasNode[], id: string): unknown => nodes.find((n) => n.id === id)?.data.text

describe('disInvoiceCanvas', () => {
  beforeEach(() => {
    useProjects.setState({
      projects: [project('open', [sticky('stale-store-note')]), project('other', [sticky('other-note')])],
      activeProjectId: 'open'
    })
  })

  describe('the project on screen', () => {
    it('reads the live canvas, not the store', () => {
      const { canvas } = harness('open')
      expect(canvas.isLive('open')).toBe(true)
      expect(canvas.nodesOf('open').map((n) => n.id)).toEqual(['live-note'])
    })

    it('writes to the live canvas, casts only what is new, and leaves the store to the commit', () => {
      const { canvas, log, flow } = harness('open')
      const fresh = disInvoiceStickyFactory([])({ id: 'sticky-dis-7-1', text: 'tarea', ref: REF })
      const updated = { ...sticky('live-note', 'from upstream'), disInvoiceRef: REF }
      canvas.applyNodes('open', [updated, fresh])
      expect(log).toEqual(['flow live-note,sticky-dis-7-1', 'cast open sticky-dis-7-1', 'dirty'])
      expect(textOf(flow(), 'live-note')).toBe('from upstream')
      expect(textOf(flow(), 'sticky-dis-7-1')).toBe('tarea')
      expect(useProjects.getState().getProject('open')?.nodes.map((n) => n.id)).toEqual(['stale-store-note'])
    })

    it('survives the commit persist makes, which a store-only write would not', () => {
      const { canvas, flow } = harness('open')
      canvas.applyNodes('open', [disInvoiceStickyFactory([])({ id: 'sticky-dis-7-1', text: 'tarea', ref: REF })])
      useProjects.getState().commitCanvas('open', flowToNodeStates(flow()), { x: 0, y: 0, zoom: 1 })
      expect(useProjects.getState().getProject('open')?.nodes.map((n) => n.id)).toEqual(['live-note', 'sticky-dis-7-1'])
    })
  })

  describe('a project that is not on screen', () => {
    it('reads and writes the store, and leaves the canvas alone', () => {
      const { canvas, log, flow } = harness('open')
      expect(canvas.isLive('other')).toBe(false)
      expect(canvas.nodesOf('other').map((n) => n.id)).toEqual(['other-note'])
      canvas.applyNodes('other', [sticky('sticky-dis-8-2')])
      expect(useProjects.getState().getProject('other')?.nodes.map((n) => n.id)).toEqual(['other-note', 'sticky-dis-8-2'])
      expect(flow().map((n) => n.id)).toEqual(['live-note'])
      expect(log).toEqual([])
    })
  })

  it('in the gap before a switch loads, the refs are the outgoing project’s, so both read as stored', () => {
    useProjects.setState({ activeProjectId: 'other' })
    const { canvas, log } = harness('open')
    expect(canvas.isLive('open')).toBe(false)
    expect(canvas.isLive('other')).toBe(false)
    canvas.applyNodes('open', [sticky('sticky-dis-7-1')])
    expect(useProjects.getState().getProject('open')?.nodes.map((n) => n.id)).toEqual(['stale-store-note', 'sticky-dis-7-1'])
    expect(log).toEqual([])
  })

  it('a board goes to the store either way, and marks the canvas dirty', () => {
    const { canvas, log } = harness('open')
    canvas.applyBoard('other', BOARD)
    expect(canvas.boardOf('other')).toEqual(BOARD)
    expect(log).toEqual(['dirty'])
  })

  it('Canvas hands Sync this adapter, with its real refs', () => {
    const source = readFileSync(path.resolve(__dirname, '../canvas/Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(source).toContain('flowProjectId: () => nodesProjectIdRef.current,')
    expect(source).toContain('flowNodes: () => nodesRef.current,')
    expect(source).toContain('nodesRef.current = next\n          setNodes(next)')
    expect(source).toContain('...disInvoiceCanvasWrites,')
    expect(source.match(/disInvoiceCanvasWrites\.isLive\(projectId\)/g)).toHaveLength(2)
  })
})
