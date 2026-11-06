// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DisInvoiceSaveResult } from '@shared/dis-invoice'
import { DisInvoiceSection } from './DisInvoiceSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = `disck_${'a'.repeat(43)}`
let host: HTMLDivElement
let root: Root
let hasKey: boolean
const saveConfig = vi.fn(async (_key: string): Promise<DisInvoiceSaveResult> => ({ ok: true }))
const clearKey = vi.fn(async () => {})

beforeEach(async () => {
  hasKey = false
  saveConfig.mockClear()
  clearKey.mockClear()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    disInvoice: {
      status: async () => ({ hasKey, storage: 'encrypted' }),
      saveConfig,
      clearKey
    }
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<DisInvoiceSection isActive />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const input = (): HTMLInputElement => host.querySelector('#dis-invoice-key') as HTMLInputElement
const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label)

async function type(value: string): Promise<void> {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('DisInvoiceSection', () => {
  it('takes the key in a password field, with Save off until there is one, and no Remove yet', async () => {
    expect(input().type).toBe('password')
    expect(input().autocomplete).toBe('off')
    expect(button('Save')?.disabled).toBe(true)
    expect(button('Remove')).toBeUndefined()
    await type(KEY)
    expect(button('Save')?.disabled).toBe(false)
  })

  it('saves, clears the field, and then says a key is saved without showing it', async () => {
    await type(KEY)
    hasKey = true
    await act(async () => button('Save')!.click())
    expect(saveConfig).toHaveBeenCalledWith(KEY)
    expect(input().value).toBe('')
    expect(input().placeholder).toBe('Key saved')
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'dis-invoice accepted the key. Press Sync on the board to bring your tasks in.'
    )
    expect(host.innerHTML).not.toContain(KEY)
    expect(button('Remove')?.disabled).toBe(false)
  })

  it('shows a refusal and keeps what was typed so it can be corrected', async () => {
    saveConfig.mockResolvedValueOnce({ ok: false, reason: 'unauthorized', message: 'dis-invoice rejected the connector key.' })
    await type(KEY)
    await act(async () => button('Save')!.click())
    expect(host.querySelector('[role="status"]')?.textContent).toBe('dis-invoice rejected the connector key.')
    expect(input().value).toBe(KEY)
  })

  it('removes the key', async () => {
    hasKey = true
    await act(async () => root.render(<DisInvoiceSection isActive={false} />))
    await act(async () => root.render(<DisInvoiceSection isActive />))
    hasKey = false
    await act(async () => button('Remove')!.click())
    expect(clearKey).toHaveBeenCalledTimes(1)
    expect(button('Remove')).toBeUndefined()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Key removed. Your notes and projects stay as they are.')
  })

  it('has no way to read a key: the API it uses has no such method', () => {
    expect(Object.keys((window as unknown as { nodeTerminal: { disInvoice: object } }).nodeTerminal.disInvoice).sort()).toEqual([
      'clearKey',
      'saveConfig',
      'status'
    ])
  })
})
