import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const workflow = fs
  .readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')
  .replace(/\r\n/g, '\n')

/** Runs the real `release` script, with stand-ins for npm and electron-builder. */
describe.skipIf(process.platform === 'win32')('the release script', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-release-'))
    fs.writeFileSync(
      path.join(dir, 'npm'),
      '#!/bin/sh\necho "npm $*" >> "$LOG"\n[ "$2" = rebuild ] && exit "$REBUILD_CODE"\nexit 0\n',
      { mode: 0o755 }
    )
    fs.writeFileSync(
      path.join(dir, 'electron-builder'),
      '#!/bin/sh\necho "builder" >> "$LOG"\nexit "$BUILD_CODE"\n',
      { mode: 0o755 }
    )
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function run(opts: { build: number; rebuild: number; ci: boolean }) {
    const log = path.join(dir, 'log')
    const { CI: _ci, ...env } = process.env
    const result = spawnSync('sh', ['-c', pkg.scripts.release], {
      encoding: 'utf8',
      cwd: dir,
      env: {
        ...env,
        PATH: `${dir}:${process.env.PATH}`,
        LOG: log,
        BUILD_CODE: String(opts.build),
        REBUILD_CODE: String(opts.rebuild),
        ...(opts.ci ? { CI: 'true' } : {})
      }
    })
    return { status: result.status, stderr: result.stderr, log: fs.readFileSync(log, 'utf8') }
  }

  it('succeeds and restores native modules after a good build', () => {
    const r = run({ build: 0, rebuild: 0, ci: false })
    expect(r.status).toBe(0)
    expect(r.log.indexOf('builder')).toBeLessThan(r.log.indexOf('npm run rebuild'))
  })

  it('still restores after a failed build, and keeps the build’s exit code', () => {
    const r = run({ build: 3, rebuild: 7, ci: false })
    expect(r.status).toBe(3)
    expect(r.log).toContain('npm run rebuild')
  })

  it('fails locally when the restore fails, so node_modules is not left broken in silence', () => {
    const r = run({ build: 0, rebuild: 7, ci: false })
    expect(r.status).toBe(7)
    expect(r.stderr).toContain('restoring native modules failed')
  })

  // The workflow retries this script, so failing here would sign and notarize a good build again.
  it('only warns in CI, whose checkout is thrown away', () => {
    const r = run({ build: 0, rebuild: 7, ci: true })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('restoring native modules failed')
  })
})

describe('the Intel app in release-mac', () => {
  const at = (needle: string): number => {
    const i = workflow.indexOf(needle)
    expect(i, needle).toBeGreaterThanOrEqual(0)
    return i
  }

  it('adds the x64 sharp binary after npm ci and before the build', () => {
    const add = at('Add the x64 sharp binary for the Intel build')
    expect(at('caffeinate -dims npm ci')).toBeLessThan(add)
    expect(add).toBeLessThan(at('name: Build, sign & notarize'))
  })

  it('checks the packaged app before anything is published', () => {
    const verify = at('Verify the Intel app has its sharp binary')
    expect(at('name: Build, sign & notarize')).toBeLessThan(verify)
    expect(verify).toBeLessThan(at('name: Create GitHub Release'))
  })
})
