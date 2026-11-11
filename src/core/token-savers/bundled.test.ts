// The token-saver mods ship as text in bundled.generated.ts (docs/reference/token-savers.md § Install).
// These fail when that text drifts from resources/claude-mods, or a plugin's common.ts copy drifts
// from the shared source, or the bundle stops matching the ids DisTerm switches.
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_MODS } from './bundled.generated'
import { TOKEN_SAVERS_MARKETPLACE, TOKEN_SAVER_IDS } from '../../shared/token-savers'

const ROOT = path.join(__dirname, '..', '..', '..')
const MODS = path.join(ROOT, 'resources', 'claude-mods')

describe('bundled token-saver mods', () => {
  it('match resources/claude-mods (run `npm run mods:bundle`)', async () => {
    const { collect } = (await import(path.join(ROOT, 'scripts', 'bundle-claude-mods.mjs'))) as {
      collect: () => Record<string, string>
    }
    expect(BUNDLED_MODS).toEqual(collect())
  })

  it('each plugin carries an exact copy of shared/common.ts', () => {
    const shared = fs.readFileSync(path.join(MODS, 'shared', 'common.ts'), 'utf8')
    for (const id of TOKEN_SAVER_IDS) expect(BUNDLED_MODS[`plugins/${id}/hooks/common.ts`], id).toBe(shared)
  })

  it('the marketplace lists exactly the mods DisTerm switches, each with a manifest and a module', () => {
    const market = JSON.parse(BUNDLED_MODS['.claude-plugin/marketplace.json']) as {
      name: string
      plugins: { name: string; source: string }[]
    }
    expect(market.name).toBe(TOKEN_SAVERS_MARKETPLACE)
    expect(market.plugins.map((p) => p.name).sort()).toEqual([...TOKEN_SAVER_IDS].sort())
    for (const p of market.plugins) {
      expect(p.source).toBe(`./plugins/${p.name}`)
      const manifest = JSON.parse(BUNDLED_MODS[`plugins/${p.name}/.claude-plugin/plugin.json`]) as { name: string }
      expect(manifest.name).toBe(p.name)
      const hooks = JSON.parse(BUNDLED_MODS[`plugins/${p.name}/hooks/hooks.json`]) as { modules: string[] }
      for (const m of hooks.modules) expect(BUNDLED_MODS[`plugins/${p.name}/hooks/${m.replace(/^\.\//, '')}`], m).toBeTypeOf('string')
    }
  })

  it('every bundled path stays inside the marketplace folder', () => {
    for (const k of Object.keys(BUNDLED_MODS)) expect(k.split('/').some((s) => s === '..' || s === '')).toBe(false)
  })
})
