import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { testTmpDir } from '../test-tmp'
import { aggregateLedger, helperUsd, leftOutReason, parseLedgerLine } from './ledger'
import { parseSwitches, readSwitches, switchesView, withSwitch, writeSwitch } from './switches'
import { bundleHash, installTokenSavers, installedIn, syncMarketplace, uninstallTokenSavers } from './install'
import { readLedgerTail } from './service'
import { parseLatestUsage } from '../context-tail'
import { TOKEN_SAVER_IDS, type LedgerLine } from '../../shared/token-savers'

const line = (o: Partial<LedgerLine> & Record<string, unknown> = {}): string =>
  JSON.stringify({
    ts: '2026-11-11T10:00:00.000Z',
    session: 's1',
    nodeId: 'n1',
    tool_use_id: null,
    mod: 'input-router',
    action: 'read → notes',
    before: 10_000,
    after: 500,
    helper: { model: 'claude-haiku-5-5', in: 10_000, out: 400 },
    measured: 'estimated',
    ...o
  })

const mkTmp = (): string => testTmpDir('token-savers-')

describe('parseLedgerLine', () => {
  it('reads a full line', () => {
    const l = parseLedgerLine(line({ usd_saved: 0.12 }))
    expect(l).toMatchObject({ mod: 'input-router', before: 10_000, after: 500, nodeId: 'n1', usd_saved: 0.12 })
  })
  it('refuses lines without numbers, a mod or a timestamp', () => {
    expect(parseLedgerLine('not json')).toBeNull()
    expect(parseLedgerLine('[]')).toBeNull()
    expect(parseLedgerLine(line({ before: 'x' as never }))).toBeNull()
    expect(parseLedgerLine(line({ mod: '' }))).toBeNull()
    expect(parseLedgerLine(line({ ts: 'yesterday' }))).toBeNull()
  })
  it('treats an unknown measured value as estimated and a bad helper as none', () => {
    const l = parseLedgerLine(line({ measured: 'maybe' as never, helper: { in: 3 } as never }))
    expect(l?.measured).toBe('estimated')
    expect(l?.helper).toBeNull()
  })
})

describe('leftOutReason', () => {
  const base = parseLedgerLine(line())!
  it('counts believable lines and dollar-only lines', () => {
    expect(leftOutReason(base)).toBe('')
    expect(leftOutReason({ ...base, before: 0, after: 0, usd_saved: 1 })).toBe('')
  })
  it('leaves out huge befores, huge cuts and growth', () => {
    expect(leftOutReason({ ...base, before: 600_000, after: 1000 })).toMatch(/500,000/)
    expect(leftOutReason({ ...base, before: 200_000, after: 100 })).toMatch(/1000x/)
    expect(leftOutReason({ ...base, before: 10, after: 20 })).toMatch(/larger/)
  })
})

describe('helperUsd', () => {
  it('prices the helper at list price and unknown models at zero', () => {
    const l = parseLedgerLine(line())!
    expect(helperUsd(l)).toBeCloseTo((10_000 * 0.1 + 400 * 0.5) / 1e6)
    expect(helperUsd({ ...l, helper: { model: 'haiku', in: 1e6, out: 0 } })).toBeCloseTo(0.1)
    expect(helperUsd({ ...l, helper: { model: 'claude-opus-5-5', in: 1e6, out: 0 } })).toBeCloseTo(4)
    expect(helperUsd({ ...l, helper: { model: 'mystery', in: 1e6, out: 0 } })).toBe(0)
  })
})

describe('aggregateLedger', () => {
  const now = Date.parse('2026-11-11T12:00:00.000Z')
  it('totals by day, node and mod, newest row first', () => {
    const text = [
      line({ ts: '2026-11-10T10:00:00.000Z' }),
      line({ nodeId: 'n2', mod: 'model-router', before: 0, after: 0, usd_saved: 0.5 }),
      line(),
      'garbage'
    ].join('\n')
    const a = aggregateLedger(text, now)
    expect(a.skipped).toBe(1)
    expect(a.all.actions).toBe(3)
    expect(a.all.saved).toBe(19_000)
    expect(a.byNode.n1.saved).toBe(19_000)
    expect(a.byNode.n2.usdSaved).toBe(0.5)
    expect(a.byMod['model-router'].actions).toBe(1)
    expect(a.rows[0].mod).toBe('input-router')
    expect(a.rows[0].ts).toBe('2026-11-11T10:00:00.000Z')
  })
  it('counts a tool_use_id once, and a real line is never replaced by an estimate', () => {
    const text = [
      line({ tool_use_id: 't1', after: 900 }),
      line({ tool_use_id: 't1', after: 700, measured: 'real' }),
      line({ tool_use_id: 't1', after: 100 })
    ].join('\n')
    const a = aggregateLedger(text, now)
    expect(a.all.actions).toBe(1)
    expect(a.rows[0].after).toBe(700)
    expect(a.rows[0].measured).toBe('real')
  })
  it('keeps left-out lines as rows but out of every total', () => {
    const a = aggregateLedger(line({ before: 900_000 }), now)
    expect(a.all.actions).toBe(0)
    expect(a.all.leftOut).toBe(1)
    expect(a.rows[0].leftOut).not.toBe('')
  })
})

describe('switches', () => {
  it('off is false, on removes the key, unknown keys survive', () => {
    const off = withSwitch({ other: 1 }, 'input-router', false)
    expect(off).toEqual({ other: 1, 'input-router': false })
    expect(withSwitch(off, 'input-router', true)).toEqual({ other: 1 })
    expect(switchesView(off)['input-router']).toBe(false)
    expect(switchesView({})['model-router']).toBe(true)
  })
  it('a broken file reads as all on', () => {
    expect(parseSwitches('{oops')).toEqual({})
    expect(parseSwitches('[1]')).toEqual({})
  })
  it('round-trips through the file', async () => {
    const file = path.join(mkTmp(), 'nested', 'switches.json')
    await writeSwitch(file, 'model-router', false)
    expect(await readSwitches(file)).toEqual({ 'model-router': false })
    await writeSwitch(file, 'model-router', true)
    expect(await readSwitches(file)).toEqual({})
  })
})

describe('syncMarketplace', () => {
  it('writes the bundle, skips when the stamp matches, and removes files the bundle dropped', async () => {
    const dir = mkTmp()
    const v1 = { '.claude-plugin/marketplace.json': '{}', 'plugins/a/hooks/old.ts': 'x' }
    expect(await syncMarketplace(dir, v1)).toBe(true)
    expect(await syncMarketplace(dir, v1)).toBe(false)
    const v2 = { '.claude-plugin/marketplace.json': '{"v":2}' }
    expect(await syncMarketplace(dir, v2)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'plugins/a/hooks/old.ts'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, '.claude-plugin/marketplace.json'), 'utf8')).toBe('{"v":2}')
    expect(fs.readFileSync(path.join(dir, '.bundle-hash'), 'utf8').trim()).toBe(bundleHash(v2))
  })
  it('refuses a path that climbs out', async () => {
    await expect(syncMarketplace(mkTmp(), { '../evil': 'x' })).rejects.toThrow(/Bad bundled path/)
  })
})

describe('install / uninstall', () => {
  const calls: Array<{ args: string[]; dir: string }> = []
  const run = (out: { ok: boolean; out: string } = { ok: true, out: '' }) =>
    async (args: string[], dir: string) => {
      calls.push({ args, dir })
      return out
    }
  afterEach(() => void calls.splice(0))

  it('refuses an old Claude Code without running anything', async () => {
    const r = await installTokenSavers({ run: run(), dirs: () => ['/c'], version: async () => '2.1.200 (Claude Code)', marketplace: '/m' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/2\.1\.287/)
    expect(calls).toHaveLength(0)
  })
  it('adds the marketplace and installs every mod in every config dir', async () => {
    const r = await installTokenSavers({ run: run(), dirs: () => ['/a', '/b'], version: async () => '2.1.322', marketplace: '/m' })
    expect(r).toEqual({ ok: true, error: null })
    expect(calls.filter((c) => c.args[1] === 'marketplace').map((c) => c.dir)).toEqual(['/a', '/b'])
    expect(calls.filter((c) => c.args[1] === 'install')).toHaveLength(TOKEN_SAVER_IDS.length * 2)
    expect(calls[1].args).toEqual(['plugin', 'install', 'input-router@disterm-token-savers', '--scope', 'user'])
  })
  it('treats "already" as success and other failures as the error', async () => {
    expect((await installTokenSavers({ run: run({ ok: false, out: 'already installed' }), dirs: () => ['/a'], version: async () => '2.1.322', marketplace: '/m' })).ok).toBe(true)
    const bad = await installTokenSavers({ run: run({ ok: false, out: 'boom\nreal reason' }), dirs: () => ['/a'], version: async () => '2.1.322', marketplace: '/m' })
    expect(bad.error).toBe('Adding the marketplace failed: real reason')
  })
  it('uninstall ignores "not installed"', async () => {
    const r = await uninstallTokenSavers({ run: run({ ok: false, out: 'Plugin not installed' }), dirs: () => ['/a'] })
    expect(r.ok).toBe(false) // the marketplace removal still failed with an unknown reason
    const r2 = await uninstallTokenSavers({ run: run({ ok: false, out: 'not found' }), dirs: () => ['/a'] })
    expect(r2).toEqual({ ok: true, error: null })
  })
  it('installedIn reads enabledPlugins and leaves other keys alone', async () => {
    const dir = mkTmp()
    const enabled = Object.fromEntries(TOKEN_SAVER_IDS.map((id) => [`${id}@disterm-token-savers`, true]))
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ enabledPlugins: { ...enabled, 'x@y': true } }))
    expect(await installedIn(dir)).toBe(true)
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'x@y': true } }))
    expect(await installedIn(dir)).toBe(false)
    expect(await installedIn(path.join(dir, 'missing'))).toBe(false)
  })
})

describe('readLedgerTail', () => {
  it('drops the torn first line when it starts mid-file', async () => {
    const file = path.join(mkTmp(), 'l.jsonl')
    fs.writeFileSync(file, `${line({ action: 'first' })}\n${line({ action: 'second' })}\n`)
    const whole = await readLedgerTail(file)
    expect(whole.partial).toBe(false)
    const tail = await readLedgerTail(file, line().length + 4)
    expect(tail.partial).toBe(true)
    expect(tail.text).not.toContain('"first"')
  })
})

describe('parseLatestUsage cache clock', () => {
  const rec = (usage: Record<string, unknown>, ts?: string): string =>
    JSON.stringify({ type: 'assistant', ...(ts && { timestamp: ts }), message: { model: 'claude-opus-5-5', usage } })
  it('reads the reply time and a 1-hour TTL from the cache write split', () => {
    const r = parseLatestUsage(rec({ input_tokens: 5, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 } }, '2026-11-11T10:00:00.000Z'))
    expect(r).toMatchObject({ used: 15, at: Date.parse('2026-11-11T10:00:00.000Z'), ttlMs: 3_600_000 })
  })
  it('defaults to 5 minutes and omits both when the transcript says nothing', () => {
    expect(parseLatestUsage(rec({ input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 3 } }))?.ttlMs).toBe(300_000)
    const bare = parseLatestUsage(rec({ input_tokens: 5 }))
    expect(bare).not.toHaveProperty('at')
    expect(bare).not.toHaveProperty('ttlMs')
  })
})
