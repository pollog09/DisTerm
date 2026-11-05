// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RELAY_UNAVAILABLE_REASON } from '@shared/relay-availability'
import { PhoneSection } from './PhoneSection'
import { resetRelayAvailabilityForTest } from '@renderer/state/relayAvailability'

// With no relay in the build the section stays in the nav, says why, and its controls do not act.
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  resetRelayAvailabilityForTest()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    pairing: {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      onDone: vi.fn(() => () => undefined),
      probeSsh: vi.fn(async () => true),
      listDevices: vi.fn(async () => []),
      webhookStatus: vi.fn(async () => ({ ok: true, value: null })),
      webhookEndpoint: vi.fn(async () => 'https://api.test')
    },
    remoteHost: { setPhoneAccess: vi.fn(), relayConfigured: vi.fn(async () => false) },
    shell: { openExternal: vi.fn() }
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(): Promise<void> {
  await act(async () => root.render(<PhoneSection isActive />))
  await act(async () => {
    await Promise.resolve()
  })
}

describe('PhoneSection with no relay configured', () => {
  it('says why and disables pairing and the remote-access switch', async () => {
    await render()
    expect(host.textContent).toContain(RELAY_UNAVAILABLE_REASON)
    const pair = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Start pairing'))
    expect(pair?.disabled).toBe(true)
    const toggle = host.querySelector<HTMLButtonElement>('button[role="switch"]')
    expect(toggle?.disabled).toBe(true)
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
  })
})
