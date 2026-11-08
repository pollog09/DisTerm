import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Release guard: every packaging script builds EVERYTHING the app loads at runtime before it hands
 * `out/` to electron-builder.
 *
 * `npm run build` is the one definition of "everything": the electron-vite bundles, the session
 * host (`host:build`) and the standalone Codex relay (`build:codex-relay` →
 * `out/main/codex-relay.js`, which `loadCodexRelayBundle` in src/main/index.ts uploads to an SSH
 * host for managed Codex accounts). The packaging scripts used to spell the steps out themselves,
 * and the list drifted: `dist`, `dist:linux`, `dist:win` and `release` all ran
 * `electron-vite build && npm run host:build` and never built the relay. MEASURED on the published
 * v0.3.7 artifacts: the macOS and Windows `app.asar` carry no `out/main/codex-relay.js` at all,
 * while the Linux `.deb` — built by release.yml with `npm run build` — does. Nothing reported it:
 * a missing bundle reads as "no managed Codex runtime" (`''`), by design, so the feature was
 * simply absent on two of three platforms.
 *
 * So packaging calls `npm run build` and adds nothing of its own, and a step added to `build`
 * reaches every package with no second list to update.
 */
const PKG = path.resolve(__dirname, '../../package.json')

describe('packaging scripts', () => {
  const scripts: Record<string, string> = JSON.parse(fs.readFileSync(PKG, 'utf8')).scripts ?? {}
  const packaging = Object.entries(scripts).filter(([, cmd]) => cmd.includes('electron-builder'))

  it('finds the packaging scripts it is guarding', () => {
    // An empty list would make every assertion below vacuously green.
    expect(packaging.map(([name]) => name).sort()).toEqual(
      expect.arrayContaining(['dist', 'dist:linux', 'dist:win', 'release:mac'])
    )
  })

  it('`build` produces every runtime bundle, the Codex relay included', () => {
    expect(scripts.build).toContain('electron-vite build')
    expect(scripts.build).toContain('npm run host:build')
    expect(scripts.build).toContain('npm run build:codex-relay')
  })

  it.each(packaging)('%s runs the full `npm run build` before electron-builder', (name, cmd) => {
    const build = cmd.indexOf('npm run build ')
    expect(
      build,
      `${name} must run \`npm run build\`, not its own list of build steps — a hand-written list ` +
        'is how the Codex relay went missing from the macOS and Windows packages.'
    ).toBeGreaterThanOrEqual(0)
    expect(build).toBeLessThan(cmd.indexOf('electron-builder'))
    expect(cmd, `${name} repeats a step \`npm run build\` already runs`).not.toContain('electron-vite build')
    expect(cmd).not.toContain('npm run host:build')
  })
})

/**
 * Every installer carries THIRD-PARTY-NOTICES.md in its resources. The BSD-3-Clause packages the agent
 * graph's 3D view bundles (ngraph.*) ask for their notice "in the documentation and/or other materials
 * provided with the distribution", and the build strips licence comments, so this file is where it is.
 *
 * electron-builder 26 concatenates the top-level `extraResources` with the platform's own list rather
 * than letting one replace the other (`app-builder-lib/out/fileMatcher.js`, `getFileMatchers`: the
 * top-level list, then `customBuildOptions[name]`, which is `config.mac`/`win`/`linux`). The effective
 * list below follows that rule, and the rule itself is pinned, so an upgrade that changes it fails here.
 */
describe('third-party notices ship in every installer', () => {
  const build = JSON.parse(fs.readFileSync(PKG, 'utf8')).build as Record<string, unknown>
  type Entry = string | { from?: string; to?: string; filter?: string[] }
  const list = (v: unknown): Entry[] => (v == null ? [] : Array.isArray(v) ? (v as Entry[]) : [v as Entry])
  const effective = (platform: 'mac' | 'win' | 'linux'): Entry[] => [
    ...list(build.extraResources),
    ...list((build[platform] as Record<string, unknown> | undefined)?.extraResources)
  ]
  const shipsNotices = (e: Entry): boolean =>
    typeof e === 'string' ? e === 'THIRD-PARTY-NOTICES.md' : e.from === 'THIRD-PARTY-NOTICES.md' && (e.to === undefined || e.to === 'THIRD-PARTY-NOTICES.md') && !e.filter

  it.each(['mac', 'win', 'linux'] as const)('%s', (platform) => {
    expect(effective(platform).filter(shipsNotices), JSON.stringify(effective(platform))).toHaveLength(1)
  })

  it('the file is there to ship', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../../THIRD-PARTY-NOTICES.md'))).toBe(true)
  })

  it('electron-builder still adds the platform list after the top-level one', () => {
    const src = fs.readFileSync(require.resolve('app-builder-lib/out/fileMatcher.js'), 'utf8')
    const top = src.indexOf('addPatterns(config[name]);')
    const own = src.indexOf('addPatterns(options.customBuildOptions[name]);')
    expect(top).toBeGreaterThan(0)
    expect(own).toBeGreaterThan(top)
  })
})
