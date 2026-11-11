// The service's consent gate (CONTRIBUTING.md § User-owned agent settings): install needs the Claude
// integration enabled, only an explicit decline removes, a veto touches nothing, and a failed removal
// is tried once per decline, not on every poll.
import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IPC } from '../../shared/ipc'
import type { TokenSaversSnapshot } from '../../shared/token-savers'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform, type FakePlatform } from '../platform-fake'
import { testTmpDir } from '../test-tmp'
import { CONSENT_REQUIRED, CONSENT_VETOED, pruneFullOutputs, startTokenSaversService, type TokenSaversConsent } from './service'

let p: FakePlatform
beforeEach(() => {
  p = fakePlatform()
  initPlatform(p)
})
afterEach(() => resetPlatformForTests())

function boot(c: TokenSaversConsent, installed = false, uninstallOk = true) {
  const state = { consent: c, installed, installs: 0, uninstalls: 0 }
  const svc = startTokenSaversService({
    home: testTmpDir('token-savers-svc-'),
    noTimers: true,
    consent: () => state.consent,
    isInstalled: async () => state.installed,
    sync: async () => {},
    install: async () => {
      state.installs++
      state.installed = true
      return { ok: true, error: null }
    },
    uninstall: async () => {
      state.uninstalls++
      if (uninstallOk) state.installed = false
      return uninstallOk ? { ok: true, error: null } : { ok: false, error: 'claude not found' }
    }
  })
  const call = (ch: string, ...a: unknown[]) => p.handlers[ch](...a) as Promise<TokenSaversSnapshot>
  return { svc, state, call }
}

describe('token savers consent', () => {
  it('refuses to install until the Claude integration is enabled, then installs', async () => {
    const { svc, state, call } = boot({ veto: false, claude: undefined })
    await svc.ready()
    expect((await call(IPC.tokenSaversInstall)).installError).toBe(CONSENT_REQUIRED)
    expect(state.installs).toBe(0)
    state.consent = { veto: false, claude: 'enabled' }
    const snap = await call(IPC.tokenSaversInstall)
    expect(state.installs).toBe(1)
    expect(snap.installed).toBe(true)
  })

  it('a veto refuses install and remove, and never removes on its own', async () => {
    const { svc, state, call } = boot({ veto: true, claude: 'declined' }, true)
    await svc.ready()
    await svc.refresh()
    expect(state.uninstalls).toBe(0)
    expect((await call(IPC.tokenSaversInstall)).installError).toBe(CONSENT_VETOED)
    expect((await call(IPC.tokenSaversUninstall)).installError).toBe(CONSENT_VETOED)
    expect(state.uninstalls).toBe(0)
  })

  it('"never asked" removes nothing; an explicit decline removes once', async () => {
    const { svc, state } = boot({ veto: false, claude: undefined }, true)
    await svc.ready()
    await svc.refresh()
    expect(state.uninstalls).toBe(0)
    state.consent = { veto: false, claude: 'declined' }
    await svc.refresh()
    expect(state.uninstalls).toBe(1)
    expect(svc.snapshot().installed).toBe(false)
  })

  it('a failed removal is not retried every poll, only after the consent changes again', async () => {
    const { svc, state } = boot({ veto: false, claude: 'declined' }, true, false)
    await svc.ready()
    await svc.refresh()
    await svc.refresh()
    expect(state.uninstalls).toBe(1)
    expect(svc.snapshot().installError).toBe('claude not found')
    state.consent = { veto: false, claude: 'enabled' }
    await svc.refresh()
    state.consent = { veto: false, claude: 'declined' }
    await svc.refresh()
    expect(state.uninstalls).toBe(2)
  })

  it('a switch answer carries the value just written', async () => {
    const { svc, call } = boot({ veto: false, claude: 'enabled' })
    await svc.ready()
    expect((await call(IPC.tokenSaversSetSwitch, 'model-router', false)).switches['model-router']).toBe(false)
    await expect(call(IPC.tokenSaversSetSwitch, 'nope', false)).rejects.toThrow(/Bad switch/)
  })
})

describe('pruneFullOutputs', () => {
  it('removes saved outputs older than the limit and keeps fresh ones', async () => {
    const dir = testTmpDir('token-savers-full-')
    const old = path.join(dir, 'old.txt')
    fs.writeFileSync(old, 'mail')
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x')
    const now = Date.now()
    fs.utimesSync(old, new Date(now - 8 * 86_400_000), new Date(now - 8 * 86_400_000))
    expect(await pruneFullOutputs(dir, now)).toBe(1)
    expect(fs.readdirSync(dir)).toEqual(['new.txt'])
    expect(await pruneFullOutputs(path.join(dir, 'missing'), now)).toBe(0)
  })
})
