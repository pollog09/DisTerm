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

  it('a backoff waiting when the project closes some other way stops at its next step, keeping its nodes', async () => {
    const id = open(wsl)
    exit255(id)
    useProjects.getState().closeProject(id)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(dial).not.toHaveBeenCalled()
    useProjects.getState().reopenProject(id)
    await vi.advanceTimersByTimeAsync(1000)
    expect(dial).toHaveBeenCalledTimes(1)
    expect(respawn).toHaveBeenCalledWith(id, [NODE])
  })

  it('an explicit retry on a closed project dials nothing either', async () => {
    const id = open(wsl)
    close(id)
    await vi.advanceTimersByTimeAsync(0)
    rec.retryNow(id, [NODE])
    await vi.advanceTimersByTimeAsync(5000)
    expect(dial).not.toHaveBeenCalled()
  })

  it('nodes dropped before the close come back on reopen: their backoff was cancelled, not their claim', async () => {
    const id = open(wsl)
    exit255(id)
    close(id)
    await vi.advanceTimersByTimeAsync(5000)
    expect(dial).not.toHaveBeenCalled()
    useProjects.getState().reopenProject(id)
    await vi.advanceTimersByTimeAsync(1000)
    expect(dial).toHaveBeenCalledTimes(1)
    expect(respawn).toHaveBeenCalledWith(id, [NODE])
  })

  describe('another project opened in between: the canvas load replaced the terminals', () => {
    const other: NonNullable<Project['ssh']> = { server: { host: 'other.example.com', user: 'dev' }, remoteCwd: '/o' }

    it('close the last tab, open another, reopen: the fresh mounts get no respawn', async () => {
      const id = open(wsl)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      expect(useProjects.getState().activeProjectId).toBe('')
      open(other)
      useProjects.getState().reopenProject(id)
      rec.onConnected(id)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(respawn).not.toHaveBeenCalled()
      expect(dial).not.toHaveBeenCalled()
    })

    it('close the last tab and reopen directly: still exactly one respawn', async () => {
      const id = open(wsl)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      useProjects.getState().reopenProject(id)
      rec.onConnected(id)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(respawn).toHaveBeenCalledTimes(1)
    })

    it('closing a tab with others open: a node queued before the close gets no respawn on reopen', async () => {
      disconnect.mockImplementation(async () => {})
      open(other)
      const id = open(wsl)
      exit255(id)
      close(id)
      expect(useProjects.getState().activeProjectId).not.toBe('')
      await vi.advanceTimersByTimeAsync(0)
      useProjects.getState().reopenProject(id)
      rec.onConnected(id)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(respawn).not.toHaveBeenCalled()
      expect(dial).not.toHaveBeenCalled()
    })

    it('an exit landing after the other project opened is not held for later', async () => {
      disconnect.mockImplementation(async () => {})
      const id = open(wsl)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      open(other)
      exit255(id)
      useProjects.getState().reopenProject(id)
      rec.onConnected(id)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(respawn).not.toHaveBeenCalled()
    })

    it('a project still dialable keeps its queue when another is active, as before', async () => {
      const id = open(plain)
      exit255(id)
      open(other)
      await vi.advanceTimersByTimeAsync(1000)
      expect(dial).toHaveBeenCalledWith(id)
      expect(respawn).toHaveBeenCalledWith(id, [NODE])
    })
  })

  describe('the refuse window and a close', () => {
    /** A node respawned by the ordinary loop, so its 10 s window has just started. */
    async function respawnedJustNow(id: string): Promise<void> {
      exit255(id)
      await vi.advanceTimersByTimeAsync(1000)
      expect(respawn).toHaveBeenCalledTimes(1)
      respawn.mockClear()
      dial.mockClear()
    }

    it('an older window does not strand a terminal whose exit lands just after a quick reopen', async () => {
      disconnect.mockImplementation(async () => {})
      const id = open(wsl)
      await respawnedJustNow(id)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      useProjects.getState().reopenProject(id)
      exit255(id)
      await vi.advanceTimersByTimeAsync(1000)
      expect(dial).toHaveBeenCalledTimes(1)
      expect(respawn).toHaveBeenCalledWith(id, [NODE])
    })

    it('a respawn flushed from a close clears an older window, so a later exit is reported', async () => {
      const id = open(wsl)
      await respawnedJustNow(id)
      useProjects.getState().closeProject(id)
      exit255(id)
      useProjects.getState().reopenProject(id)
      rec.onConnected(id)
      expect(respawn).toHaveBeenCalledTimes(1)
      respawn.mockClear()
      exit255(id)
      await vi.advanceTimersByTimeAsync(1000)
      expect(respawn).toHaveBeenCalledWith(id, [NODE])
    })

    it('a loop held by a close respawns its node without starting a window', async () => {
      const id = open(wsl)
      await respawnedJustNow(id)
      exit255(id) // refused: inside the window, as it should be while the project is open
      await vi.advanceTimersByTimeAsync(1000)
      expect(dial).not.toHaveBeenCalled()
      reportSshExit(255, id, true, 'term-2')
      useProjects.getState().closeProject(id)
      await vi.advanceTimersByTimeAsync(1000)
      useProjects.getState().reopenProject(id)
      rec.onConnected(id)
      respawn.mockClear()
      reportSshExit(255, id, true, 'term-2')
      await vi.advanceTimersByTimeAsync(1000)
      expect(respawn).toHaveBeenCalledWith(id, ['term-2'])
    })

    it('an ordinary SSH project keeps its window, through its own close and reopen too', async () => {
      const id = open(plain)
      await respawnedJustNow(id)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      useProjects.getState().reopenProject(id)
      exit255(id)
      await vi.advanceTimersByTimeAsync(5000)
      expect(dial).not.toHaveBeenCalled()
      expect(respawn).not.toHaveBeenCalled()
    })

    it('closing a WSL project leaves another project’s window alone', async () => {
      const ssh = open(plain)
      reportSshExit(255, ssh, true, 'term-ssh')
      await vi.advanceTimersByTimeAsync(1000)
      expect(respawn).toHaveBeenCalledWith(ssh, ['term-ssh'])
      respawn.mockClear()
      dial.mockClear()
      const id = open(wsl)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      reportSshExit(255, ssh, true, 'term-ssh')
      await vi.advanceTimersByTimeAsync(5000)
      expect(dial).not.toHaveBeenCalled()
    })
  })

  describe('what the close’s cancel keeps', () => {
    beforeEach(() => {
      // This close's own disconnect reports nothing, so only what was queued before it is in play.
      disconnect.mockImplementation(async () => {})
    })

    it('a node queued before the close, which its own disconnect never reports again', async () => {
      const id = open(wsl)
      reportSshExit(255, id, true, 'term-queued')
      close(id)
      await vi.advanceTimersByTimeAsync(5000)
      useProjects.getState().reopenProject(id)
      rec.onConnected(id)
      expect(respawn).toHaveBeenCalledWith(id, ['term-queued'])
    })

    it('the old backoff timer does not also fire after a quick reopen: one dial, not two', async () => {
      const id = open(wsl)
      exit255(id)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      useProjects.getState().reopenProject(id)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(dial).toHaveBeenCalledTimes(1)
      expect(respawn).toHaveBeenCalledTimes(1)
    })

    it('reopening starts a full backoff: first dial after the first delay, and it retries a failure', async () => {
      dial.mockImplementation(async () => false)
      const id = open(wsl)
      exit255(id)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      useProjects.getState().reopenProject(id)
      await vi.advanceTimersByTimeAsync(999)
      expect(dial).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(dial).toHaveBeenCalledTimes(1)
      dial.mockImplementation(async () => true)
      await vi.advanceTimersByTimeAsync(2000)
      expect(dial).toHaveBeenCalledTimes(2)
      expect(respawn).toHaveBeenCalledWith(id, [NODE])
    })

    it('a store change while it is still closed schedules nothing', async () => {
      const id = open(wsl)
      exit255(id)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      useProjects.setState({ activeProjectId: '' } as never)
      expect(vi.getTimerCount()).toBe(0)
      expect(useProjects.getState().getProject(id)?.closed).toBe(true)
    })

    it('a retry with no nodes, while closed, leaves nothing to dial after the reopen', async () => {
      const id = open(wsl)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      rec.retryNow(id)
      useProjects.getState().reopenProject(id)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(dial).not.toHaveBeenCalled()
    })

    it('a dial that SUCCEEDS after the close respawns nothing while it is closed', async () => {
      let answer: (ok: boolean) => void = () => {}
      dial.mockImplementation(() => new Promise<boolean>((r) => (answer = r)))
      const id = open(wsl)
      exit255(id)
      await vi.advanceTimersByTimeAsync(1000)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      answer(true)
      await vi.advanceTimersByTimeAsync(5000)
      expect(respawn).not.toHaveBeenCalled()
      useProjects.getState().reopenProject(id)
      rec.onConnected(id)
      expect(respawn).toHaveBeenCalledWith(id, [NODE])
    })
  })

  describe('closing the LAST open tab, whose terminals stay mounted', () => {
    it('leaves no active project, as the bug needs', () => {
      const id = open(wsl)
      close(id)
      expect(useProjects.getState().activeProjectId).toBe('')
    })

    it('the terminal its disconnect killed is respawned on reopen, by the connected status', async () => {
      const id = open(wsl)
      close(id)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(disconnect).toHaveBeenCalled()
      expect(dial).not.toHaveBeenCalled()
      expect(respawn).not.toHaveBeenCalled()
      useProjects.getState().reopenProject(id)
      rec.onConnected(id)
      expect(respawn).toHaveBeenCalledTimes(1)
      expect(respawn).toHaveBeenCalledWith(id, [NODE])
      // The status flushed it, so the timer has nothing left to do.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(dial).not.toHaveBeenCalled()
      expect(respawn).toHaveBeenCalledTimes(1)
    })

    it('it is respawned without any status too: a connect reusing a live master reports none', async () => {
      const id = open(wsl)
      close(id)
      await vi.advanceTimersByTimeAsync(5000)
      useProjects.getState().reopenProject(id)
      await vi.advanceTimersByTimeAsync(1000)
      expect(dial).toHaveBeenCalledTimes(1)
      expect(respawn).toHaveBeenCalledWith(id, [NODE])
    })

    it('every terminal of the project comes back, once', async () => {
      const id = open(wsl)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      reportSshExit(255, id, true, 'term-2')
      reportSshExit(255, id, true, NODE)
      useProjects.getState().reopenProject(id)
      rec.onConnected(id)
      expect(respawn).toHaveBeenCalledTimes(1)
      expect([...respawn.mock.calls[0][1]].sort()).toEqual([NODE, 'term-2'])
    })

    it('a quick reopen: exit already reported, back within a millisecond', async () => {
      const id = open(wsl)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      expect(disconnect).toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      useProjects.getState().reopenProject(id)
      await vi.advanceTimersByTimeAsync(1000)
      expect(dial).toHaveBeenCalledTimes(1)
      expect(respawn).toHaveBeenCalledWith(id, [NODE])
    })

    it('a quick reopen: the exit only lands after it, and takes the ordinary path', async () => {
      const id = open(wsl)
      disconnect.mockImplementation(async () => {})
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      useProjects.getState().reopenProject(id)
      exit255(id)
      await vi.advanceTimersByTimeAsync(1000)
      expect(dial).toHaveBeenCalledTimes(1)
      expect(respawn).toHaveBeenCalledWith(id, [NODE])
    })

    it('a reopen in the same tick as the close: nothing was disconnected, so nothing is touched', async () => {
      const id = open(wsl)
      close(id)
      useProjects.getState().reopenProject(id)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(disconnect).not.toHaveBeenCalled()
      expect(dial).not.toHaveBeenCalled()
      expect(respawn).not.toHaveBeenCalled()
    })

    it('a terminal respawned just before the close is not lost to the refuse window', async () => {
      const id = open(wsl)
      exit255(id)
      await vi.advanceTimersByTimeAsync(1000)
      expect(respawn).toHaveBeenCalledTimes(1)
      respawn.mockClear()
      dial.mockClear()
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      useProjects.getState().reopenProject(id)
      await vi.advanceTimersByTimeAsync(1000)
      expect(respawn).toHaveBeenCalledWith(id, [NODE])
    })

    it('that respawn does not start the window: if a late exit kills it, it is reported again', async () => {
      const id = open(wsl)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      useProjects.getState().reopenProject(id)
      rec.onConnected(id)
      respawn.mockClear()
      dial.mockClear()
      exit255(id)
      await vi.advanceTimersByTimeAsync(1000)
      expect(dial).toHaveBeenCalledTimes(1)
      expect(respawn).toHaveBeenCalledWith(id, [NODE])
    })

    it('a connect landing while it is closed does not spend the held terminals', async () => {
      const id = open(wsl)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      rec.onConnected(id)
      expect(respawn).not.toHaveBeenCalled()
      useProjects.getState().reopenProject(id)
      rec.onConnected(id)
      expect(respawn).toHaveBeenCalledWith(id, [NODE])
    })

    it('a dial in flight when it closes retries nothing, and its nodes wait for the reopen', async () => {
      let answer: (ok: boolean) => void = () => {}
      dial.mockImplementation(() => new Promise<boolean>((r) => (answer = r)))
      const id = open(wsl)
      exit255(id)
      await vi.advanceTimersByTimeAsync(1000)
      expect(dial).toHaveBeenCalledTimes(1)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      answer(false)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(dial).toHaveBeenCalledTimes(1)
      dial.mockImplementation(async () => true)
      useProjects.getState().reopenProject(id)
      await vi.advanceTimersByTimeAsync(1000)
      expect(dial).toHaveBeenCalledTimes(2)
      expect(respawn).toHaveBeenCalledWith(id, [NODE])
    })

    it('stops listening to the store when disposed', async () => {
      const id = open(wsl)
      close(id)
      await vi.advanceTimersByTimeAsync(0)
      rec.dispose()
      useProjects.getState().reopenProject(id)
      await vi.advanceTimersByTimeAsync(5000)
      expect(dial).not.toHaveBeenCalled()
    })
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
