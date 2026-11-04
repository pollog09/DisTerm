import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import { AGENT_GRAPH_HISTORY_CAP } from '../../shared/agent-graph'
import type { BoardLogEntry } from '../../shared/types'
import type { BoardLogRouter } from '../board-log-handlers'
import type { CorePlatform } from '../platform'
import { testTmpDir } from '../test-tmp'
import { AgentGraphLog } from './event-log'
import { boardLogToDeliveries, readAgentGraphSnapshot, registerAgentGraphHandlers } from './handlers'

const AUTHOR = { name: 'nodeterm', color: '#8b8b8b' }
const line = (over: Partial<BoardLogEntry> & { from?: unknown; to?: unknown; title?: unknown; reason?: unknown }): BoardLogEntry => {
  const { from = 'a', to = 'b', title = 'delivered', reason, ...rest } = over
  return {
    id: 'id1',
    ts: 10,
    author: AUTHOR,
    kind: 'event',
    event: { type: 'agent-message', from, to, title, reason },
    ...rest
  } as BoardLogEntry
}

function writeLog(cwd: string, entries: readonly BoardLogEntry[]): void {
  fs.mkdirSync(path.join(cwd, '.nodeterm'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.nodeterm', 'board-log.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

describe('boardLogToDeliveries', () => {
  it('reads an agent-message line', () => {
    expect(boardLogToDeliveries([line({ reason: 'messaging-off', title: 'notPermitted' })])).toEqual([
      { kind: 'delivery', id: 'id1', ts: 10, from: 'a', to: 'b', outcome: 'notPermitted', reason: 'messaging-off' }
    ])
  })

  it('skips what is not one, and what a hand-edited file got wrong', () => {
    const comment = { id: 'c', ts: 1, author: AUTHOR, kind: 'comment', text: 'hi' } as BoardLogEntry
    const moved = { id: 'm', ts: 1, author: AUTHOR, kind: 'event', event: { type: 'card-moved' } } as unknown as BoardLogEntry
    const bad = [
      comment,
      moved,
      line({ from: '../../etc' }),
      line({ to: 'has space' }),
      line({ to: 5 }),
      line({ title: 7 }),
      line({ ts: Number.NaN }),
      line({ id: '' }),
      null as unknown as BoardLogEntry
    ]
    expect(boardLogToDeliveries(bad)).toEqual([])
  })

  it('cleans what it keeps: one line, bounded', () => {
    const [e] = boardLogToDeliveries([line({ title: `x\n${'y'.repeat(500)}`, reason: `r\r\n${'z'.repeat(500)}` })])
    expect(e.outcome).not.toContain('\n')
    expect(e.outcome.length).toBeLessThanOrEqual(64)
    expect(e.reason).not.toMatch(/[\r\n]/)
    expect(e.reason!.length).toBeLessThanOrEqual(200)
  })
})

describe('readAgentGraphSnapshot', () => {
  it('merges the board log under the live buffer, counting one delivery once', async () => {
    const cwd = testTmpDir('graph-snap-')
    writeLog(cwd, [line({ id: 'shared', ts: 1 }), line({ id: 'old', ts: 0 })])
    const log = new AgentGraphLog()
    log.push({ kind: 'delivery', id: 'shared', ts: 1, from: 'a', to: 'b', outcome: 'delivered' })
    log.push({ kind: 'delivery', id: 'new', ts: 2, from: 'a', to: 'b', outcome: 'queued' })
    const router: BoardLogRouter = { route: () => ({ kind: 'local', cwd }) }
    const s = await readAgentGraphSnapshot('P', router, log)
    expect(s.events.map((e) => e.id)).toEqual(['old', 'shared', 'new'])
    expect(s.history).toBe('board-log')
    expect(s.historyTruncated).toBe(false)
  })

  it('says so when the log held more than one read returns', async () => {
    const cwd = testTmpDir('graph-snap-')
    writeLog(cwd, Array.from({ length: AGENT_GRAPH_HISTORY_CAP + 5 }, (_, i) => line({ id: `i${i}`, ts: i })))
    const s = await readAgentGraphSnapshot('P', { route: () => ({ kind: 'local', cwd }) }, new AgentGraphLog())
    expect(s.historyTruncated).toBe(true)
    expect(s.events).toHaveLength(AGENT_GRAPH_HISTORY_CAP)
  })

  it('a project with no reachable log is memory only, and says so', async () => {
    const log = new AgentGraphLog()
    log.push({ kind: 'delivery', id: 'x', ts: 1, from: 'a', to: 'b', outcome: 'delivered' })
    const s = await readAgentGraphSnapshot('P', { route: () => ({ kind: 'unsupported' }) }, log)
    expect(s.history).toBe('memory')
    expect(s.events).toHaveLength(1)
  })

  it('a router that throws is the same fact, not a failed read', async () => {
    const router: BoardLogRouter = {
      route: () => {
        throw new Error('boom')
      }
    }
    await expect(readAgentGraphSnapshot('P', router, new AgentGraphLog())).resolves.toMatchObject({ history: 'memory', events: [] })
  })

  it('a remote project reads through its exec', async () => {
    const tail = vi.fn(async () => `${JSON.stringify(line({ id: 'r' }))}\n`)
    const s = await readAgentGraphSnapshot(
      'P',
      { route: () => ({ kind: 'remote', remoteCwd: '/srv', exec: { append: async () => {}, tail }, fingerprint: async () => '0' }) },
      new AgentGraphLog()
    )
    expect(tail).toHaveBeenCalled()
    expect(s.events.map((e) => e.id)).toEqual(['r'])
    expect(s.history).toBe('board-log')
  })

  it('reports what the buffer dropped', async () => {
    const log = new AgentGraphLog(1)
    log.push({ kind: 'delivery', id: 'a', ts: 1, from: 'a', to: 'b', outcome: 'delivered' })
    log.push({ kind: 'delivery', id: 'b', ts: 2, from: 'a', to: 'b', outcome: 'delivered' })
    await expect(readAgentGraphSnapshot('P', { route: () => ({ kind: 'unsupported' }) }, log)).resolves.toMatchObject({ dropped: 1, capacity: 1 })
  })
})

describe('registerAgentGraphHandlers', () => {
  it('serves the snapshot and broadcasts each event until disposed', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const broadcast = vi.fn()
    const platform = {
      handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
      broadcast
    } as unknown as CorePlatform
    const log = new AgentGraphLog()
    const off = registerAgentGraphHandlers(platform, { route: () => ({ kind: 'unsupported' }) }, log)
    const event = { kind: 'delivery', id: 'x', ts: 1, from: 'a', to: 'b', outcome: 'queued' } as const
    log.push(event)
    expect(broadcast).toHaveBeenCalledWith(IPC.agentGraphEvent, event)
    await expect(handlers.get(IPC.agentGraphSnapshot)!('P')).resolves.toMatchObject({ events: [event] })
    off()
    log.push({ ...event, id: 'y' })
    expect(broadcast).toHaveBeenCalledTimes(1)
  })
})
