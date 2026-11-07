// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DisInvoiceSyncReport } from '../../lib/disInvoiceSync'
import { DIS_INVOICE_KEY_CHANGED, useDisInvoiceSyncRun } from '../../state/disInvoiceSyncRun'
import { DisInvoiceSyncButton, type DisInvoiceSyncControl } from './DisInvoiceSyncButton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const report = (over: Partial<DisInvoiceSyncReport> = {}): DisInvoiceSyncReport => ({
  noColumns: false,
  projects: [],
  withoutProject: 0,
  stopped: [],
  failed: [],
  skippedRemote: [],
  unavailable: [],
  ...over
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  useDisInvoiceSyncRun.setState({ busy: false, outcome: null })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (over: Partial<DisInvoiceSyncControl> = {}): DisInvoiceSyncControl => {
  const control: DisInvoiceSyncControl = {
    status: vi.fn(async () => ({ hasKey: true })),
    run: vi.fn(async () => report()),
    openSettings: vi.fn(),
    ...over
  }
  act(() => root.render(<DisInvoiceSyncButton control={control} />))
  return control
}

const button = (label: string): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement

const press = async (label = 'Sync'): Promise<void> => {
  await act(async () => {
    button(label).click()
  })
}

describe('DisInvoiceSyncButton', () => {
  it('with no key, opens Settings and does not sync', async () => {
    const control = render({ status: vi.fn(async () => ({ hasKey: false })) })
    await press()
    expect(control.openSettings).toHaveBeenCalledTimes(1)
    expect(control.run).toHaveBeenCalledTimes(0)
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

  it('with no key, says Connect dis-invoice and opens Settings', async () => {
    const control = render({ status: vi.fn(async () => ({ hasKey: false })) })
    await act(async () => {})
    expect(button('Sync')).toBeUndefined()
    await press('Connect dis-invoice')
    expect(control.openSettings).toHaveBeenCalledTimes(1)
    expect(control.run).toHaveBeenCalledTimes(0)
  })

  it('turns back into Sync once Settings saves a key', async () => {
    let hasKey = false
    render({ status: vi.fn(async () => ({ hasKey })) })
    await act(async () => {})
    expect(button('Connect dis-invoice')).toBeDefined()
    hasKey = true
    await act(async () => {
      window.dispatchEvent(new Event(DIS_INVOICE_KEY_CHANGED))
    })
    expect(button('Sync')).toBeDefined()
  })

  it('a status that rejects keeps the Sync label', async () => {
    render({ status: vi.fn(() => Promise.reject(new Error('E_DISCONNECTED'))) })
    await act(async () => {})
    expect(button('Sync')).toBeDefined()
  })

  it('shows the report, then dismisses it', async () => {
    render({ run: vi.fn(async () => report({ withoutProject: 2 })) })
    await press()
    expect([...host.querySelectorAll('.kanban-sync__line')].map((p) => [p.className, p.textContent])).toEqual([
      ['kanban-sync__line kanban-sync__line--ok', 'Already up to date across 0 projects.'],
      ['kanban-sync__line kanban-sync__line--warn', '2 tasks skipped because they have no project in dis-invoice. Assign one and sync again.']
    ])
    await press('Dismiss')
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

  it('says it is syncing and refuses a second press until it is done', async () => {
    let finish: (value: DisInvoiceSyncReport) => void = () => {}
    const run = vi.fn(() => new Promise<DisInvoiceSyncReport>((resolve) => (finish = resolve)))
    render({ run })
    await press()
    const busy = button('Syncing…')
    expect(busy.disabled).toBe(true)
    expect(busy.getAttribute('aria-busy')).toBe('true')
    await act(async () => {
      busy.click()
    })
    expect(run).toHaveBeenCalledTimes(1)
    await act(async () => finish(report()))
    expect(button('Sync').disabled).toBe(false)
  })

  it('a rejected key offers Settings beside the failure', async () => {
    const control = render({
      run: vi.fn(async () => report({ failure: { reason: 'unauthorized', message: 'dis-invoice rejected the connector key.' } }))
    })
    await press()
    expect(host.querySelector('.kanban-sync__line--error')?.textContent).toBe('dis-invoice rejected the connector key.')
    await press('Open Settings')
    expect(control.openSettings).toHaveBeenCalledTimes(1)
  })

  it('a server failure reports without a Settings button', async () => {
    render({ run: vi.fn(async () => report({ failure: { reason: 'server', message: 'dis-invoice answered 500.' } })) })
    await press()
    expect(host.querySelector('.kanban-sync__line--error')?.textContent).toBe('dis-invoice answered 500.')
    expect(button('Open Settings')).toBeUndefined()
  })

  describe('when the board changes during a run', () => {
    const REPORT_LINE = 'Already up to date across 0 projects.'
    const lines = (): Array<string | null> => [...host.querySelectorAll('.kanban-sync__line')].map((p) => p.textContent)

    const switchBoard = (): void => {
      act(() => root.unmount())
      root = createRoot(host)
    }

    it('the next board shows the run still going, and refuses a second one', async () => {
      let finish: (value: DisInvoiceSyncReport) => void = () => {}
      const run = vi.fn(() => new Promise<DisInvoiceSyncReport>((resolve) => (finish = resolve)))
      render({ run })
      await press()
      switchBoard()
      const otherRun = vi.fn(async () => report())
      render({ run: otherRun })
      expect(button('Syncing…').disabled).toBe(true)
      await act(async () => finish(report()))
      expect(lines()).toEqual([REPORT_LINE])
      expect(button('Sync').disabled).toBe(false)
      expect(run).toHaveBeenCalledTimes(1)
      expect(otherRun).toHaveBeenCalledTimes(0)
    })

    it('a report that lands with no board open is waiting on the next one', async () => {
      let finish: (value: DisInvoiceSyncReport) => void = () => {}
      render({ run: vi.fn(() => new Promise<DisInvoiceSyncReport>((resolve) => (finish = resolve))) })
      await press()
      switchBoard()
      await act(async () => finish(report()))
      render()
      expect(lines()).toEqual([REPORT_LINE])
    })

    it('a dismissed report stays dismissed on the next board', async () => {
      render()
      await press()
      await press('Dismiss')
      switchBoard()
      render()
      expect(lines()).toEqual([])
    })
  })

  it('a channel that rejects is a failure on screen, not an unhandled one', async () => {
    render({ run: vi.fn(() => Promise.reject(new Error('E_DISCONNECTED'))) })
    await press()
    expect(host.querySelector('.kanban-sync__line--error')?.textContent).toBe('The sync stopped before it finished. Try again.')
    expect(button('Sync').disabled).toBe(false)
  })
})
