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

import { handoffsFrom, parseEffort, parseKeepWarm } from './service'
import { KEEP_WARM_MAX_MS, type LedgerRow } from '../../shared/token-savers'

describe('phase 2 snapshot inputs', () => {
  const now = Date.parse('2026-11-11T12:00:00Z')
  it('keeps recent, valid effort suggestions only', () => {
    const raw = JSON.stringify({
      n1: { level: 'low', why: 'lookup', at: now - 1000 },
      n2: { level: 'turbo', at: now },
      n3: { level: 'high', at: now - 2 * 86_400_000 },
      'bad id!': { level: 'low', at: now }
    })
    expect(parseEffort(raw, now)).toEqual({ n1: { level: 'low', why: 'lookup', at: now - 1000 } })
    expect(parseEffort('{oops', now)).toEqual({})
  })
  it('drops expired keep-warm entries and clamps a too-long one', () => {
    const raw = JSON.stringify({ a: { until: now - 1, ttlMs: 300_000 }, b: { until: now + 9e9, ttlMs: 3_600_000 }, c: { until: now + 1000, ttlMs: 7 } })
    const k = parseKeepWarm(raw, now)
    expect(Object.keys(k).sort()).toEqual(['b', 'c'])
    expect(k.b).toEqual({ until: now + KEEP_WARM_MAX_MS, ttlMs: 3_600_000 })
    expect(k.c.ttlMs).toBe(300_000)
  })
  it('takes the newest handoff per node, jailed to the handoffs folder', () => {
    const dir = '/home/u/.nodeterm/token-savers/handoffs'
    const row = (o: Partial<LedgerRow>): LedgerRow =>
      ({ mod: 'handoff', nodeId: 'n1', ts: '2026-11-11T11:00:00Z', file: `${dir}/n1-1.md`, ...o }) as LedgerRow
    const out = handoffsFrom(
      [
        row({ file: `${dir}/n1-2.md`, ts: '2026-11-11T11:30:00Z' }),
        row({}),
        row({ nodeId: 'n2', file: '/etc/passwd' }),
        row({ nodeId: 'n3', file: `${dir}/../../evil.md` }),
        row({ nodeId: 'n4', file: `${dir}/x.sh` }),
        row({ nodeId: 'n5', mod: 'input-router' })
      ],
      dir
    )
    expect(out).toEqual({ n1: { file: `${dir}/n1-2.md`, at: Date.parse('2026-11-11T11:30:00Z') } })
  })
})

describe('keep-warm IPC', () => {
  it('writes an opt-in, refuses bad input, and turns off with 0 minutes', async () => {
    const { svc, call } = boot({ veto: false, claude: 'enabled' })
    await svc.ready()
    const on = await call(IPC.tokenSaversSetKeepWarm, 'node-1', 60, 3_600_000)
    expect(on.keepWarm['node-1'].ttlMs).toBe(3_600_000)
    await expect(call(IPC.tokenSaversSetKeepWarm, '../x', 60, 300_000)).rejects.toThrow(/Bad node/)
    await expect(call(IPC.tokenSaversSetKeepWarm, 'node-1', 999, 300_000)).rejects.toThrow(/Bad duration/)
    expect((await call(IPC.tokenSaversSetKeepWarm, 'node-1', 0, 300_000)).keepWarm).toEqual({})
  })
})
