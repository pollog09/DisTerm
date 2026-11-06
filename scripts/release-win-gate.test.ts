import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'fs'
import path from 'path'
import { testTmpDir } from '../src/core/test-tmp'
// @ts-expect-error -- plain .mjs repo tooling, deliberately outside the typechecked projects.
import { parseReleaseRows, windowsReleaseGate } from './release-win-gate.mjs'

const SCRIPT = path.resolve(__dirname, 'release-win-gate.mjs')
const full = (tag: string) => ({ tag, draft: false, prerelease: false })
const PUBLISHED_AGAIN =
  'release v0.4.6 is already published; rerunning would replace the installer people update from. Cut a new version with npm run release.'

describe('windowsReleaseGate', () => {
  it.each([
    ['no release yet', []],
    ['a draft from a failed earlier run', [{ tag: 'v0.4.6', draft: true, prerelease: false }]],
    ['a prerelease release.yml made for mac and Linux', [{ tag: 'v0.4.6', draft: false, prerelease: true }]],
    ['older published releases', [full('v0.4.5'), full('v0.3.12')]],
    ['a newer prerelease or draft only', [{ tag: 'v0.5.0', draft: false, prerelease: true }, { tag: 'v0.4.7', draft: true, prerelease: false }]]
  ])('lets v0.4.6 publish over %s', (_name, releases) => {
    expect(windowsReleaseGate('v0.4.6', releases)).toEqual({ ok: true })
  })

  it('refuses a tag whose release is already published', () => {
    expect(windowsReleaseGate('v0.4.6', [full('v0.4.6')])).toEqual({ ok: false, reason: PUBLISHED_AGAIN })
  })

  it('refuses a tag older than a published release, naming the newest', () => {
    expect(windowsReleaseGate('v0.4.9', [full('v0.4.10'), full('v0.5.1'), full('v0.4.8')])).toEqual({
      ok: false,
      reason:
        'v0.5.1 is already published and is newer than v0.4.9; publishing v0.4.9 as latest would move every Windows install back to it.'
    })
  })

  it('compares numerically, not as text', () => {
    expect(windowsReleaseGate('v0.4.10', [full('v0.4.9')])).toEqual({ ok: true })
    expect(windowsReleaseGate('v0.4.9', [full('v0.4.10')]).ok).toBe(false)
  })

  it('refuses a tag that is not vX.Y.Z', () => {
    expect(windowsReleaseGate('v0.4.6-rc.1', [])).toEqual({ ok: false, reason: 'v0.4.6-rc.1 is not vX.Y.Z' })
  })
})

describe('parseReleaseRows', () => {
  it('reads the lines the gh query prints', () => {
    expect(parseReleaseRows('v0.4.6 true false\nv0.4.5 false false\r\nv0.4.4 false true\n')).toEqual([
      { tag: 'v0.4.6', draft: true, prerelease: false },
      { tag: 'v0.4.5', draft: false, prerelease: false },
      { tag: 'v0.4.4', draft: false, prerelease: true }
    ])
  })
})

describe.skipIf(process.platform === 'win32')('the gate script with a stand-in gh', () => {
  function run(tag: string, releases: string) {
    const bin = testTmpDir('nt-release-gate-')
    const argsFile = path.join(bin, 'args')
    fs.writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '${releases}'\n`,
      { mode: 0o755 }
    )
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: 'pollog09/DisTerm' }
    const r = spawnSync(process.execPath, [SCRIPT, tag], { encoding: 'utf8', env })
    return { ...r, ghArgs: fs.readFileSync(argsFile, 'utf8') }
  }

  it('asks gh for every release, drafts included, and refuses a published tag', () => {
    const r = run('v0.4.6', 'v0.4.6 false false\\nv0.4.5 false false\\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toBe(`::error::${PUBLISHED_AGAIN}\n`)
    expect(r.ghArgs).toBe(
      ['api', '--paginate', 'repos/pollog09/DisTerm/releases', '--jq', '.[] | "\\(.tag_name) \\(.draft) \\(.prerelease)"', ''].join('\n')
    )
  })

  it('passes a draft for the newest version', () => {
    const r = run('v0.4.6', 'v0.4.6 true false\\nv0.4.5 false false\\n')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('release gate: v0.4.6 may be published as the latest release\n')
  })
})
