// @vitest-environment jsdom
//
// The renderer half of the browse-master cancel fix (the manager half lives in
// ssh-project.test.ts). What must hold: from the moment connect() is ISSUED, closing or
// unmounting the dialog tears the throwaway browse master down. Marking the master for
// teardown only after a successful connect meant cancelling during 'connecting' skipped
// disconnect entirely, and a slow or passphrase-parked attempt then landed unowned and
// lived for the rest of the app run.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshProjectDialog } from './SshProjectDialog'
import { useSshServers } from '../state/sshServers'
import { SessionContext } from '../session/session'
import type { WslPrepareResult } from '@shared/wsl-project'
import type { SshServer } from '@shared/ssh'

// React refuses act() outside a configured test environment without this flag.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SERVER: SshServer = { id: 's1', label: 'testbox', host: 'h.example.com', user: 'u' }

describe('SshProjectDialog', () => {
  let root: Root | undefined
  let host: HTMLElement
  let connect: ReturnType<typeof vi.fn>
  let disconnect: ReturnType<typeof vi.fn>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    connect = vi.fn(() => new Promise(() => {})) // never settles: the dialog parks in 'connecting'
    disconnect = vi.fn(async () => {})
    ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
      sshProject: {
        connect,
        disconnect,
        listDir: vi.fn(async () => ({ path: '~', dirs: [] })),
        mkdir: vi.fn(async () => true)
      }
    }
    useSshServers.setState({ servers: [SERVER] })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    host.remove()
  })

  function render(): ReturnType<typeof vi.fn> {
    const onClose = vi.fn()
    root = createRoot(host)
    act(() => {
      root!.render(<SshProjectDialog onCreate={vi.fn()} onManage={vi.fn()} onClose={onClose} />)
    })
    return onClose
  }

  const click = (el: Element): void => {
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  const buttonByText = (text: string): HTMLButtonElement => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes(text))
    if (!b) throw new Error(`no button containing "${text}"`)
    return b
  }
  const setInputValue = (input: HTMLInputElement, value: string): void => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const serverButtons = (): HTMLButtonElement[] =>
    [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Saved SSH servers"] button')]

  describe('WSL distributions', () => {
    const wslServer: SshServer = {
      id: 'wsl-1',
      label: 'WSL: My Distro',
      host: 'my-distro-0123456789abcdef.wsl.nodeterm.invalid',
      user: 'dev',
      wslDistro: 'My Distro'
    }

    async function renderWsl(prepare: (d: string, b: string) => Promise<WslPrepareResult>, onCreate = vi.fn()) {
      const list = vi.fn(async () => ({ available: true, distros: ['My Distro'] }))
      const api = { wslProject: { list, prepare, bind: vi.fn() } }
      root = createRoot(host)
      await act(async () => {
        root!.render(
          <SessionContext.Provider value={{ api } as never}>
            <SshProjectDialog onCreate={onCreate} onManage={vi.fn()} onClose={vi.fn()} />
          </SessionContext.Provider>
        )
      })
      return { list }
    }

    const wslRow = (): HTMLButtonElement => {
      const b = document.querySelector<HTMLButtonElement>('[aria-label="WSL distributions"] button')
      if (!b) throw new Error('no WSL row')
      return b
    }

    it('lists without starting anything, and starts only the row that is picked', async () => {
      const prepare = vi.fn(async (): Promise<WslPrepareResult> => ({ ok: true, server: wslServer, warnings: [] }))
      connect.mockResolvedValue({ controlPath: '/c' })
      await renderWsl(prepare)
      expect(prepare).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
      await act(async () => {
        wslRow().click()
      })
      expect(prepare).toHaveBeenCalledWith('My Distro', expect.stringMatching(/^ssh-browse-/))
      expect(connect).toHaveBeenCalledWith(expect.stringMatching(/^ssh-browse-/), wslServer)
    })

    it('creates a project holding the distro and the Linux folder', async () => {
      const prepare = vi.fn(async (): Promise<WslPrepareResult> => ({ ok: true, server: wslServer, warnings: [] }))
      connect.mockResolvedValue({ controlPath: '/c' })
      const onCreate = vi.fn()
      await renderWsl(prepare, onCreate)
      await act(async () => {
        wslRow().click()
      })
      await act(async () => {
        click(buttonByText('Use this folder'))
      })
      expect(onCreate).toHaveBeenCalledWith({ server: wslServer, remoteCwd: '~', label: '~ · WSL: My Distro' })
    })

    it('shows a named warning and still lets the project be created', async () => {
      const prepare = vi.fn(
        async (): Promise<WslPrepareResult> => ({
          ok: true,
          server: wslServer,
          warnings: [{ kind: 'tmux', message: 'tmux is not installed in "My Distro".', install: 'sudo apt install tmux' }]
        })
      )
      connect.mockResolvedValue({ controlPath: '/c' })
      await renderWsl(prepare)
      await act(async () => {
        wslRow().click()
      })
      expect(document.body.textContent).toContain('tmux is not installed in "My Distro".')
      expect(buttonByText('Use this folder')).toBeTruthy()
    })

    it('names a missing sshd with its command, and Retry runs the setup again', async () => {
      const prepare = vi.fn(
        async (): Promise<WslPrepareResult> => ({
          ok: false,
          code: 'sshd-missing',
          error: 'sshd is not installed in "My Distro". Run: sudo apt install openssh-server',
          install: 'sudo apt install openssh-server'
        })
      )
      await renderWsl(prepare)
      await act(async () => {
        wslRow().click()
      })
      expect(document.body.textContent).toContain('sudo apt install openssh-server')
      expect(connect).not.toHaveBeenCalled()
      await act(async () => {
        click(buttonByText('Retry'))
      })
      expect(prepare).toHaveBeenCalledTimes(2)
    })

    it.each([
      ['Cancel', () => click(buttonByText('Cancel'))],
      ['Esc', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))],
      ['unmounting', () => root?.unmount()]
    ])('%s while setup is pending starts no connection after it finishes', async (name, leave) => {
      let finish: (r: WslPrepareResult) => void = () => {}
      const prepare = vi.fn(() => new Promise<WslPrepareResult>((r) => (finish = r)))
      await renderWsl(prepare)
      await act(async () => {
        wslRow().click()
      })
      await act(async () => {
        leave()
      })
      await act(async () => {
        finish({ ok: true, server: wslServer, warnings: [] })
      })
      expect(connect).not.toHaveBeenCalled()
      if (name === 'unmounting') root = undefined
    })

    it('offers nothing when the core has no WSL', async () => {
      const api = { wslProject: { list: vi.fn(async () => ({ available: false, distros: [] })), prepare: vi.fn(), bind: vi.fn() } }
      root = createRoot(host)
      await act(async () => {
        root!.render(
          <SessionContext.Provider value={{ api } as never}>
            <SshProjectDialog onCreate={vi.fn()} onManage={vi.fn()} onClose={vi.fn()} />
          </SessionContext.Provider>
        )
      })
      expect(document.querySelector('[aria-label="WSL distributions"]')).toBeNull()
    })
  })

  it('keeps a large server collection in its own scroll region above the actions', () => {
    useSshServers.setState({
      servers: Array.from({ length: 25 }, (_, index) => ({
        id: `server-${index}`,
        label: `Server ${index}`,
        host: `host-${index}.example.com`,
        user: 'matt'
      }))
    })
    render()

    const list = document.querySelector<HTMLElement>('[aria-label="Saved SSH servers"]')
    expect(list).not.toBeNull()
    if (!list) return
    const cancel = buttonByText('Cancel')
    expect(serverButtons()).toHaveLength(25)
    expect(list.style.flex).toBe('1 1 auto')
    expect(list.style.minHeight).toBe('0px')
    expect(list.style.overflowY).toBe('auto')
    expect(serverButtons().every((button) => button.style.flexShrink === '0')).toBe(true)
    expect(list.contains(cancel)).toBe(false)
    expect(cancel.parentElement?.style.flexShrink).toBe('0')
    expect(list.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('filters saved servers by label, host, user, and user-at-host without case sensitivity', () => {
    useSshServers.setState({
      servers: [
        { id: 'prod', label: 'Production', host: 'api.example.com', user: 'deploy' },
        { id: 'stage', label: 'Staging', host: 'stage.internal', user: 'ubuntu' }
      ]
    })
    render()
    const filter = document.querySelector<HTMLInputElement>('[aria-label="Filter saved SSH servers"]')
    expect(filter).not.toBeNull()
    if (!filter) return

    setInputValue(filter, 'PRODUCTION')
    expect(serverButtons().map((button) => button.textContent)).toEqual([
      expect.stringContaining('Production')
    ])
    setInputValue(filter, '  API.EXAMPLE.COM  ')
    expect(serverButtons().map((button) => button.textContent)).toEqual([
      expect.stringContaining('Production')
    ])
    setInputValue(filter, 'UBUNTU')
    expect(serverButtons().map((button) => button.textContent)).toEqual([
      expect.stringContaining('Staging')
    ])
    setInputValue(filter, 'ubuntu@stage.internal')
    expect(serverButtons().map((button) => button.textContent)).toEqual([
      expect.stringContaining('Staging')
    ])
    setInputValue(filter, '')
    expect(serverButtons()).toHaveLength(2)
  })

  it('shows a no-results message instead of server rows when the filter has no match', () => {
    render()
    const filter = document.querySelector<HTMLInputElement>('[aria-label="Filter saved SSH servers"]')
    expect(filter).not.toBeNull()
    if (!filter) return
    setInputValue(filter, 'missing-host')
    expect(serverButtons()).toHaveLength(0)
    expect(document.body.textContent).toContain('No saved servers match')
  })

  it('cancelling DURING connecting still tears the browse master down (mark-before-await)', () => {
    const onClose = render()
    click(buttonByText('testbox')) // issues connect(); the promise never settles
    expect(connect).toHaveBeenCalledTimes(1)
    const browseId = connect.mock.calls[0][0] as string
    expect(browseId).toMatch(/^ssh-browse-/)
    expect(disconnect).not.toHaveBeenCalled()
    click(buttonByText('Cancel')) // the connecting step's Cancel button
    expect(disconnect).toHaveBeenCalledWith(browseId)
    expect(onClose).toHaveBeenCalled()
  })

  it('unmounting mid-connect tears it down too (the effect-cleanup path)', () => {
    render()
    click(buttonByText('testbox'))
    const browseId = connect.mock.calls[0][0] as string
    act(() => root!.unmount())
    root = undefined
    expect(disconnect).toHaveBeenCalledWith(browseId)
  })

  it('closing without ever connecting disconnects nothing', () => {
    const onClose = render()
    click(buttonByText('Cancel')) // the pick step's Cancel: no connect was ever issued
    expect(disconnect).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})

// Where the browse LANDS when the machine has a default folder configured. `listDir` cannot report
// a missing directory — it echoes the path back with `dirs: []` whether the folder is gone or
// merely empty — so existence is checked against the PARENT's listing. Getting that wrong drops
// the user into a nonexistent path with "Use this folder" enabled.
describe('SshProjectDialog default folder', () => {
  let root: Root | undefined
  let host: HTMLElement
  let listDir: ReturnType<typeof vi.fn>

  const WITH_DEFAULT: SshServer = { ...SERVER, remoteCwd: '/home/u/projects/app' }

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    listDir = vi.fn(async (_id: string, dir: string) => ({ path: dir, dirs: [] }))
    ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
      sshProject: {
        connect: vi.fn(async () => ({ controlPath: '/tmp/cm' })),
        disconnect: vi.fn(async () => {}),
        listDir,
        mkdir: vi.fn(async () => true)
      }
    }
    useSshServers.setState({ servers: [WITH_DEFAULT] })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    host.remove()
  })

  const open = async (): Promise<void> => {
    root = createRoot(host)
    await act(async () => {
      root!.render(<SshProjectDialog onCreate={vi.fn()} onManage={vi.fn()} onClose={vi.fn()} />)
    })
    await act(async () => {
      const row = [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('testbox')
      )!
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('lands in the configured default folder when it exists', async () => {
    listDir.mockImplementation(async (_id: string, dir: string) => ({
      path: dir,
      dirs: dir === '/home/u/projects' ? ['app'] : []
    }))

    await open()

    expect(listDir).toHaveBeenCalledWith(expect.any(String), '/home/u/projects/app')
  })

  it('an EMPTY default folder is still the right place to land', async () => {
    // The regression a `dirs.length === 0` test would introduce: a real, empty default folder is
    // indistinguishable from a missing one by its own listing, so it must be judged by the parent.
    listDir.mockImplementation(async (_id: string, dir: string) => ({
      path: dir,
      dirs: dir === '/home/u/projects' ? ['app'] : []
    }))

    await open()

    const landed = listDir.mock.calls.at(-1)
    expect(landed?.[1]).toBe('/home/u/projects/app')
  })

  it('falls back to ~ when the configured default is gone', async () => {
    // The parent lists without it: the folder was renamed or deleted on the host since it was set.
    listDir.mockImplementation(async (_id: string, dir: string) => ({
      path: dir,
      dirs: dir === '/home/u/projects' ? ['something-else'] : []
    }))

    await open()

    expect(listDir).not.toHaveBeenCalledWith(expect.any(String), '/home/u/projects/app')
    expect(listDir.mock.calls.at(-1)?.[1]).toBe('~')
  })
})
