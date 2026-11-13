import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import { SHIP_LEASE_MS } from '../../shared/ship-config'
import { SYSTEM_MAP_NO_FOLDER_MESSAGE, compileSystemMap, parseSystemMap, type CompiledSystemMap } from '../../shared/system-map'
import { AgentGraphLog } from '../agent-graph/event-log'
import type { CorePlatform } from '../platform'
import { SHIP_POLL_LOCAL_MS, SHIP_POLL_REMOTE_MS } from '../ship-config/handlers'
import { SYSTEM_MAP_FULL_READ_MS, registerSystemMapHandlers } from './handlers'
import * as read from './read'
import { SystemMapTouches } from './touches'
import type { SystemMapReadOutcome, SystemMapRouter } from './read'

vi.mock('./read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./read')>()
  return { ...actual, readSystemMapFull: vi.fn(actual.readSystemMapFull) }
})

const fullRead = vi.mocked(read.readSystemMapFull)
let actualFullRead: typeof read.readSystemMapFull

beforeEach(async () => {
  actualFullRead = (await vi.importActual<typeof import('./read')>('./read')).readSystemMapFull
  fullRead.mockReset()
  fullRead.mockImplementation(actualFullRead)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function platform() {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const casts = new Map<string, (...a: unknown[]) => void>()
  const broadcast = vi.fn()
  return {
    handlers,
    casts,
    broadcast,
    sub: (projectId: string, lease: string) => casts.get(IPC.systemMapSubscribe)!(projectId, lease),
    unsub: (projectId: string, lease: string) => casts.get(IPC.systemMapUnsubscribe)!(projectId, lease),
    core: {
      handle: (c: string, f: (...a: unknown[]) => unknown) => handlers.set(c, f),
      on: (c: string, f: (...a: unknown[]) => void) => casts.set(c, f),
      broadcast
    } as unknown as CorePlatform
  }
}

function compiledMap(title: string): CompiledSystemMap {
  const r = parseSystemMap(JSON.stringify({ version: 1, title, parts: [{ id: 'api', label: 'API', kind: 'service', files: ['src/**'] }] }))
  if (!r.ok) throw new Error('bad map')
  return compileSystemMap(r.map)
}

/** A full read answering whatever `state.title` says, counted. */
function scripted(state: { title: string; reads: number; roots?: string[] }) {
  fullRead.mockImplementation(async () => {
    state.reads++
    const compiled = compiledMap(state.title)
    const outcome: SystemMapReadOutcome = {
      result: { ok: true, read: { kind: 'valid', map: compiled.map, emptyParts: [], fileCheck: 'checked', lastCommit: null } },
      roots: state.roots ?? ['/repo'],
      compiled
    }
    return outcome
  })
}

const localRouter = (cwd = '/repo'): SystemMapRouter => ({ route: () => ({ kind: 'local', cwd }) })
const remoteRouter = (): SystemMapRouter => ({ route: () => ({ kind: 'remote', remoteCwd: '/p', host: 'box', runScript: async () => ({ code: 0, stdout: '' }) }) })

/** fs.promises.stat answering a signature the test controls (so fake timers flush it). */
function fakeStat(sig: { mtimeMs: number; size: number } | null) {
  const box = { sig }
  vi.spyOn(fs.promises, 'stat').mockImplementation((async () => {
    if (!box.sig) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return { mtimeMs: box.sig.mtimeMs, size: box.sig.size, isFile: () => true } as fs.Stats
  }) as unknown as typeof fs.promises.stat)
  return box
}

describe('registerSystemMapHandlers: the read', () => {
  it('goes through the route that owns the project', async () => {
    const p = platform()
    const route = vi.fn(() => ({ kind: 'local' as const, cwd: null }))
    registerSystemMapHandlers(p.core, { route }, new SystemMapTouches(new AgentGraphLog()))
    await expect(p.handlers.get(IPC.systemMapRead)!('P')).resolves.toEqual({ ok: false, reason: SYSTEM_MAP_NO_FOLDER_MESSAGE })
    expect(route).toHaveBeenCalledWith('P')
    await expect(p.handlers.get(IPC.systemMapRead)!(undefined)).resolves.toEqual({ ok: false, reason: 'No project.' })
  })
})

describe('registerSystemMapHandlers: leases, polling and touches', () => {
  it('a subscribe starts a poll that registers the map for touches', async () => {
    vi.useFakeTimers()
    fakeStat({ mtimeMs: 1, size: 10 })
    const p = platform()
    const log = new AgentGraphLog()
    const touches = new SystemMapTouches(log)
    const state = { title: 'A', reads: 0 }
    scripted(state)
    registerSystemMapHandlers(p.core, localRouter(), touches)
    expect(touches.projectIds()).toEqual([])
    p.sub('P', 'view')
    await vi.advanceTimersByTimeAsync(0)
    expect(state.reads).toBe(1)
    expect(touches.projectIds()).toEqual(['P'])
    touches.recordEdit('n1', { path: '/repo/src/a.go' }, 1)
    expect(log.snapshot().events).toMatchObject([{ kind: 'map-touch', projectId: 'P', partId: 'api' }])
    p.unsub('P', 'view')
  })

  it('a map that is not valid drops the touch entry', async () => {
    vi.useFakeTimers()
    const box = fakeStat({ mtimeMs: 1, size: 10 })
    const p = platform()
    const touches = new SystemMapTouches(new AgentGraphLog())
    let valid = true
    fullRead.mockImplementation(async () =>
      valid
        ? { result: { ok: true, read: { kind: 'missing' } }, roots: ['/repo'], compiled: compiledMap('A') }
        : { result: { ok: true, read: { kind: 'missing' } }, roots: ['/repo'], compiled: null }
    )
    registerSystemMapHandlers(p.core, localRouter(), touches)
    p.sub('P', 'view')
    await vi.advanceTimersByTimeAsync(0)
    expect(touches.projectIds()).toEqual(['P'])
    valid = false
    box.sig = { mtimeMs: 2, size: 10 }
    await vi.advanceTimersByTimeAsync(SHIP_POLL_LOCAL_MS)
    expect(touches.projectIds()).toEqual([])
    p.unsub('P', 'view')
  })

  it('a changed result broadcasts systemMapChanged once; an unchanged one never; the first read never', async () => {
    vi.useFakeTimers()
    const p = platform()
    const state = { title: 'A', reads: 0 }
    scripted(state)
    registerSystemMapHandlers(p.core, remoteRouter(), new SystemMapTouches(new AgentGraphLog()))
    p.sub('P', 'view')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS * 2)
    expect(state.reads).toBe(3)
    expect(p.broadcast).not.toHaveBeenCalled()
    state.title = 'B'
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS)
    expect(p.broadcast).toHaveBeenCalledTimes(1)
    expect(p.broadcast).toHaveBeenCalledWith(IPC.systemMapChanged('P'), 'P')
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS * 2)
    expect(p.broadcast).toHaveBeenCalledTimes(1)
    p.unsub('P', 'view')
  })

  it('local: an unchanged stat skips the full read until 60 s have passed; a stat change reads at once', async () => {
    vi.useFakeTimers()
    const box = fakeStat({ mtimeMs: 1, size: 10 })
    const p = platform()
    const state = { title: 'A', reads: 0 }
    scripted(state)
    registerSystemMapHandlers(p.core, localRouter(), new SystemMapTouches(new AgentGraphLog()))
    p.sub('P', 'view')
    await vi.advanceTimersByTimeAsync(0)
    expect(state.reads).toBe(1) // the first tick always reads
    const ticksBefore60 = Math.floor((SYSTEM_MAP_FULL_READ_MS - 1) / SHIP_POLL_LOCAL_MS)
    await vi.advanceTimersByTimeAsync(ticksBefore60 * SHIP_POLL_LOCAL_MS)
    expect(state.reads).toBe(1) // stat unchanged, under 60 s
    await vi.advanceTimersByTimeAsync(SHIP_POLL_LOCAL_MS)
    expect(state.reads).toBe(2) // the 60 s full read (a commit changes no file)

    box.sig = { mtimeMs: 2, size: 10 }
    await vi.advanceTimersByTimeAsync(SHIP_POLL_LOCAL_MS)
    expect(state.reads).toBe(3)
    await vi.advanceTimersByTimeAsync(SHIP_POLL_LOCAL_MS)
    expect(state.reads).toBe(3)

    box.sig = null // deleted: a signature change too
    await vi.advanceTimersByTimeAsync(SHIP_POLL_LOCAL_MS)
    expect(state.reads).toBe(4)
    p.unsub('P', 'view')
  })

  it('remote: a full read every 20 s, not every 5 s', async () => {
    vi.useFakeTimers()
    const p = platform()
    const state = { title: 'A', reads: 0 }
    scripted(state)
    registerSystemMapHandlers(p.core, remoteRouter(), new SystemMapTouches(new AgentGraphLog()))
    p.sub('P', 'view')
    await vi.advanceTimersByTimeAsync(0)
    expect(state.reads).toBe(1)
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS - 1)
    expect(state.reads).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(state.reads).toBe(2)
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS * 3)
    expect(state.reads).toBe(5)
    p.unsub('P', 'view')
  })

  it('a lease that expires stops polling and drops the touch entry', async () => {
    vi.useFakeTimers()
    const p = platform()
    const log = new AgentGraphLog()
    const touches = new SystemMapTouches(log)
    const state = { title: 'A', reads: 0 }
    scripted(state)
    registerSystemMapHandlers(p.core, remoteRouter(), touches)
    p.sub('P', 'crashed')
    await vi.advanceTimersByTimeAsync(0)
    expect(touches.projectIds()).toEqual(['P'])
    await vi.advanceTimersByTimeAsync(SHIP_LEASE_MS + SHIP_POLL_REMOTE_MS)
    expect(touches.projectIds()).toEqual([])
    const atExpiry = state.reads
    await vi.advanceTimersByTimeAsync(SHIP_LEASE_MS * 3)
    expect(state.reads).toBe(atExpiry)
    touches.recordEdit('n1', { path: '/repo/src/a.go' }, 1)
    expect(log.snapshot().events).toEqual([])
  })

  it('releasing the last lease stops polling and drops the touch entry; one of two leases does not', async () => {
    vi.useFakeTimers()
    const p = platform()
    const touches = new SystemMapTouches(new AgentGraphLog())
    const state = { title: 'A', reads: 0 }
    scripted(state)
    registerSystemMapHandlers(p.core, remoteRouter(), touches)
    p.sub('P', 'a')
    p.sub('P', 'b')
    await vi.advanceTimersByTimeAsync(0)
    expect(state.reads).toBe(1)
    p.unsub('P', 'a')
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS)
    expect(state.reads).toBe(2)
    expect(touches.projectIds()).toEqual(['P'])
    p.unsub('P', 'b')
    expect(touches.projectIds()).toEqual([])
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS * 3)
    expect(state.reads).toBe(2)
  })

  it('never runs two reads of one project at once, even across a close and reopen', async () => {
    vi.useFakeTimers()
    const p = platform()
    let inFlight = 0
    let most = 0
    fullRead.mockImplementation(async () => {
      most = Math.max(most, ++inFlight)
      await new Promise((r) => setTimeout(r, SHIP_POLL_REMOTE_MS * 3))
      inFlight--
      return { result: { ok: true, read: { kind: 'missing' } }, roots: [], compiled: null }
    })
    registerSystemMapHandlers(p.core, remoteRouter(), new SystemMapTouches(new AgentGraphLog()))
    p.sub('P', 'a')
    p.unsub('P', 'a')
    p.sub('P', 'b')
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS * 10)
    expect(most).toBe(1)
    p.unsub('P', 'b')
  })

  it('ignores a subscribe with no project or no lease id', () => {
    const p = platform()
    registerSystemMapHandlers(p.core, localRouter(), new SystemMapTouches(new AgentGraphLog()))
    expect(() => p.sub(undefined as unknown as string, 'x')).not.toThrow()
    expect(() => p.sub('P', undefined as unknown as string)).not.toThrow()
    expect(fullRead).not.toHaveBeenCalled()
  })
})
