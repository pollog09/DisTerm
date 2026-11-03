// The order this module exists for: the core must hear about a WSL project before the connect that
// opening it causes. The connect is an effect that runs off the store change, so a subscriber scheduling
// it stands in for React, on the real store.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useProjects } from '../state/projects'
import { bindOpenedWslProject, dropClosedWslConnection, unbindDeletedWslProject } from './wslProjectBinding'
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

describe('dropClosedWslConnection', () => {
  it('disconnects a closed WSL project, after its session kill was answered', async () => {
    const order: string[] = []
    let answer: () => void = () => {}
    const ended = new Promise<void>((r) => (answer = r))
    const disconnect = vi.fn(async () => order.push('disconnect'))
    dropClosedWslConnection({ id: 'p1', ssh: wsl }, ended, disconnect, () => order.push('clear'))
    await Promise.resolve()
    expect(disconnect).not.toHaveBeenCalled()
    answer()
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledWith('p1'))
    expect(order).toEqual(['clear', 'disconnect'])
  })

  it('leaves an ordinary SSH project connected, as it always was', async () => {
    const disconnect = vi.fn(async () => {})
    dropClosedWslConnection({ id: 'p2', ssh: plain }, undefined, disconnect, () => {})
    dropClosedWslConnection(undefined, undefined, disconnect, () => {})
    await new Promise((r) => setTimeout(r, 5))
    expect(disconnect).not.toHaveBeenCalled()
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
    expect(close).toContain('dropClosedWslConnection(store.getProject(id), ended, sshDisconnect,')
    expect(close.indexOf('dropClosedWslConnection')).toBeLessThan(close.indexOf('store.closeProject(id)'))
  })

  it('unbinds in deleteProject, not in the close path', () => {
    const del = src.slice(src.indexOf('const deleteProject = useCallback('))
    expect(del.slice(0, del.indexOf('store.deleteProject(id)'))).toContain('unbindDeletedWslProject(project,')
    const close = src.slice(src.indexOf('const closeProject = useCallback('), src.indexOf('const deleteProject = useCallback('))
    expect(close).not.toContain('unbindDeletedWslProject')
  })
})
