// The order this module exists for: the core must hear about a WSL project before the connect that
// opening it causes. The connect is an effect that runs off the store change, so a subscriber scheduling
// it stands in for React, on the real store.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjects } from '../state/projects'
import { reportSshExit, setSshDropHandler } from './sshDropReport'
import { bindOpenedWslProject, createProjectReconnector, dropClosedWslConnection, releaseClosedTerminals, unbindDeletedWslProject } from './wslProjectBinding'
import type { Project } from '@shared/types'

const wsl: NonNullable<Project['ssh']> = {
  server: { host: 'ubuntu-0123456789abcdef.wsl.nodeterm.invalid', user: 'dev', wslDistro: 'Ubuntu' },
  remoteCwd: '~'
}
const plain: NonNullable<Project['ssh']> = { server: { host: 'h.example.com', user: 'dev' }, remoteCwd: '/srv' }

/** What Canvas's create step does: these two lines, in this order, with nothing between them. */
function createFromDialog(label: string, ssh: NonNullable<Project['ssh']>, api: { bind: (id: string, host: string) => Promise<boolean> }): Project {
  const opened = useProjects.getState().openSshProject(label, ssh)
  bindOpenedWslProject(opened, ssh, api)
  return opened
}

describe('bindOpenedWslProject', () => {
  let unsub: (() => void) | undefined
  afterEach(() => unsub?.())

  it('binds in the same tick, before the connect the store change schedules', async () => {
    const order: string[] = []
    unsub = useProjects.subscribe(() => {
      // The soonest an effect could run.
      queueMicrotask(() => order.push('connect'))
    })
    const bind = vi.fn(async () => {
      order.push('bind')
      return true
    })
    const p = createFromDialog('~ · WSL: Ubuntu', wsl, { bind })
    expect(bind).toHaveBeenCalledWith(p.id, wsl.server.host)
    await Promise.resolve()
    await Promise.resolve()
    expect(order[0]).toBe('bind')
    expect(order).toContain('connect')
  })

  it('binds again on reopening the same project, and never for an ordinary SSH project', () => {
    const bind = vi.fn(async () => true)
    const first = createFromDialog('a', wsl, { bind })
    const second = createFromDialog('a', wsl, { bind })
    expect(second.id).toBe(first.id)
    expect(bind).toHaveBeenCalledTimes(2)
    bind.mockClear()
    createFromDialog('b', plain, { bind })
    expect(bind).not.toHaveBeenCalled()
  })
})

describe('closing a WSL project keeps its master down', () => {
  // The chain from the review, on the real store, the real coordinator and the real exit report: a
  // disconnect ends the parked PTY's channel with 255, and that exit must not lead to a dial.
  const NODE = 'term-1'
  let rec: ReturnType<typeof createProjectReconnector>
  let dial: ReturnType<typeof vi.fn>
  let respawn: ReturnType<typeof vi.fn>
  let released: string[]
  let disconnect: ReturnType<typeof vi.fn>

  const exit255 = (projectId: string): void => reportSshExit(255, projectId, true, NODE)

  beforeEach(() => {
    vi.useFakeTimers()
    useProjects.setState({ projects: [], activeProjectId: '' } as never)
    dial = vi.fn(async () => true)
    respawn = vi.fn()
    released = []
    rec = createProjectReconnector({ connect: dial as never, respawn: respawn as never })
    setSshDropHandler((projectId, nodeId) => rec.reportDrop(projectId, nodeId))
    // What really follows a disconnect: the parked PTY's channel exits 255, and its retained
    // subscription reports it.
    disconnect = vi.fn(async (id: string) => exit255(id))
  })

  afterEach(() => {
    setSshDropHandler(null)
    rec.dispose()
    vi.useRealTimers()
  })

  function close(id: string, ended?: Promise<unknown>): void {
    const store = useProjects.getState()
    dropClosedWslConnection(store.getProject(id), {
      ended,
      forgetReconnect: (x) => rec.forget(x),
      releaseTerminals: (x) => released.push(x.id),
      clearConn: () => {},
      disconnect: disconnect as never
    })
    store.closeProject(id)
  }

  const open = (ssh: NonNullable<Project['ssh']>): string => useProjects.getState().openSshProject('p', ssh).id

  it('the exit its disconnect causes dials nothing, however long we wait', async () => {
    const id = open(wsl)
    close(id)
    await vi.advanceTimersByTimeAsync(0)
    expect(disconnect).toHaveBeenCalledWith(id)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(dial).not.toHaveBeenCalled()
  })

  it('a reconnect already pending at close never fires', async () => {
    const id = open(wsl)
    exit255(id)
    close(id)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(dial).not.toHaveBeenCalled()
    expect(respawn).not.toHaveBeenCalled()
  })

  it('a backoff waiting when the project closes some other way stops at its next step', async () => {
    const id = open(wsl)
    exit255(id)
    useProjects.getState().closeProject(id)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(dial).not.toHaveBeenCalled()
  })

  it('an explicit retry on a closed project dials nothing either', async () => {
    const id = open(wsl)
    close(id)
    await vi.advanceTimersByTimeAsync(0)
    rec.retryNow(id, [NODE])
    await vi.advanceTimersByTimeAsync(5000)
    expect(dial).not.toHaveBeenCalled()
  })

  it('a loop cancelled by the close does not come back when the tab reopens', async () => {
    const id = open(wsl)
    exit255(id)
    close(id)
    await vi.advanceTimersByTimeAsync(0)
    useProjects.getState().reopenProject(id)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(dial).not.toHaveBeenCalled()
    expect(respawn).not.toHaveBeenCalled()
  })

  it('reopening reconnects: a later drop dials and respawns as usual', async () => {
    const id = open(wsl)
    close(id)
    await vi.advanceTimersByTimeAsync(5000)
    expect(dial).not.toHaveBeenCalled()
    useProjects.getState().reopenProject(id)
    exit255(id)
    await vi.advanceTimersByTimeAsync(1000)
    expect(dial).toHaveBeenCalledTimes(1)
    expect(respawn).toHaveBeenCalledWith(id, [NODE])
  })

  it('releases the terminals in the close’s own tick, before the disconnect', async () => {
    const order: string[] = []
    disconnect.mockImplementation(async () => order.push('disconnect'))
    const id = open(wsl)
    const store = useProjects.getState()
    dropClosedWslConnection(store.getProject(id), {
      ended: undefined,
      forgetReconnect: () => order.push('forget'),
      releaseTerminals: () => order.push('release'),
      clearConn: () => order.push('clear'),
      disconnect: disconnect as never
    })
    expect(order).toEqual(['forget', 'release'])
    store.closeProject(id)
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['forget', 'release', 'clear', 'disconnect'])
  })

  it('waits for the close’s own session kill before disconnecting', async () => {
    let answer: () => void = () => {}
    const id = open(wsl)
    close(id, new Promise<void>((r) => (answer = r)))
    await vi.advanceTimersByTimeAsync(10)
    expect(disconnect).not.toHaveBeenCalled()
    answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(disconnect).toHaveBeenCalledWith(id)
  })

  it('a tab reopened before that kill was answered keeps its connection', async () => {
    let answer: () => void = () => {}
    const id = open(wsl)
    close(id, new Promise<void>((r) => (answer = r)))
    useProjects.getState().reopenProject(id)
    answer()
    await vi.advanceTimersByTimeAsync(10)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('an ordinary SSH project behaves as before: connected, not released, and it redials', async () => {
    const id = open(plain)
    close(id)
    await vi.advanceTimersByTimeAsync(0)
    expect(disconnect).not.toHaveBeenCalled()
    expect(released).toEqual([])
    exit255(id)
    await vi.advanceTimersByTimeAsync(1000)
    expect(dial).toHaveBeenCalledTimes(1)
  })

  it('an open WSL project still reconnects, and other exit codes report nothing', async () => {
    const id = open(wsl)
    reportSshExit(0, id, true, NODE)
    reportSshExit(255, id, false, NODE)
    await vi.advanceTimersByTimeAsync(5000)
    expect(dial).not.toHaveBeenCalled()
    exit255(id)
    await vi.advanceTimersByTimeAsync(1000)
    expect(dial).toHaveBeenCalledTimes(1)
  })
})

describe('releaseClosedTerminals', () => {
  const project = { nodes: [{ id: 't1', kind: 'terminal' }, { id: 't2' }, { id: 'w1', kind: 'whiteboard' }] } as never

  it('a mounted project’s terminals dispose on unmount instead of parking', () => {
    const onUnmount: string[] = []
    const park: string[] = []
    releaseClosedTerminals(project, true, { disposeOnUnmount: (n) => onUnmount.push(n), disposePark: (n) => park.push(n) })
    expect(onUnmount).toEqual(['t1', 't2'])
    expect(park).toEqual([])
  })

  it('an unmounted project’s parks are dropped, without marking anything for a later unmount', () => {
    const onUnmount: string[] = []
    const park: string[] = []
    releaseClosedTerminals(project, false, { disposeOnUnmount: (n) => onUnmount.push(n), disposePark: (n) => park.push(n) })
    expect(park).toEqual(['t1', 't2'])
    expect(onUnmount).toEqual([])
  })
})

describe('unbindDeletedWslProject', () => {
  it('only for a WSL project', () => {
    const unbind = vi.fn(async () => true)
    unbindDeletedWslProject({ id: 'p1', ssh: wsl }, { unbind })
    expect(unbind).toHaveBeenCalledWith('p1', wsl.server.host)
    unbind.mockClear()
    unbindDeletedWslProject({ id: 'p2', ssh: plain }, { unbind })
    unbindDeletedWslProject({ id: 'p3' }, { unbind })
    unbindDeletedWslProject(undefined, { unbind })
    expect(unbind).not.toHaveBeenCalled()
  })
})

// Both calls live inside Canvas callbacks with no unit seam (the same pin as the other Canvas
// `.source.test.ts` files): the behavior is proven above, and this pins that Canvas goes through it.
describe('Canvas uses them', () => {
  const src = readFileSync(new URL('../canvas/Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

  it('binds on the line right after the only store write that opens an SSH project', () => {
    expect(src).toContain(
      'const opened = useProjects.getState().openSshProject(input.label, ssh)\n        bindOpenedWslProject(opened, ssh, api?.wslProject)\n'
    )
    expect(src.match(/\.openSshProject\(/g)).toHaveLength(1)
  })

  it('the close path drops the connection', () => {
    const close = src.slice(src.indexOf('const performCloseProject = useCallback('), src.indexOf('const closeProject = useCallback('))
    expect(close).toContain('dropClosedWslConnection(store.getProject(id), {')
    expect(close.indexOf('dropClosedWslConnection')).toBeLessThan(close.indexOf('store.closeProject(id)'))
  })

  it('runs the coordinator that knows about closed projects', () => {
    expect(src).toContain('const rec = createProjectReconnector({')
    expect(src).not.toContain('new SshReconnector(')
  })

  it('unbinds in deleteProject, not in the close path', () => {
    const del = src.slice(src.indexOf('const deleteProject = useCallback('))
    expect(del.slice(0, del.indexOf('store.deleteProject(id)'))).toContain('unbindDeletedWslProject(project,')
    const close = src.slice(src.indexOf('const closeProject = useCallback('), src.indexOf('const deleteProject = useCallback('))
    expect(close).not.toContain('unbindDeletedWslProject')
  })
})
