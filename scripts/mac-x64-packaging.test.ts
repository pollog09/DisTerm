// Intel Macs ship from this one codebase. This machine-independent test pins the packaging facts
// that make that true. It cannot prove the build runs on darwin-x64: that needs a Mac.
import { spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testTmpDir } from '../src/core/test-tmp'

const ROOT = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))

/** Run a package.json script for real, with `npm` and `electron-builder` stubbed on PATH to log. */
function runScript(name: string, builderExit: number, rebuildExit = 0): { status: number | null; calls: string[] } {
  const dir = testTmpDir('mac-x64-')
  const log = join(dir, 'calls.log')
  const stub = (tool: string, exit: number): void => {
    const file = join(dir, tool)
    writeFileSync(file, `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit ${exit}\n`)
    chmodSync(file, 0o755)
  }
  stub('npm', 0)
  writeFileSync(join(dir, 'npm'), `#!/bin/sh\necho "npm $*" >> "${log}"\nif [ "$*" = "run rebuild" ]; then exit ${rebuildExit}; fi\nexit 0\n`)
  stub('electron-builder', builderExit)
  const r = spawnSync('sh', ['-c', pkg.scripts[name]], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: 'utf8' })
  return { status: r.status, calls: readFileSync(log, 'utf8').trim().split('\n') }
}

describe('Intel Mac packaging', () => {
  it('dist:mac:x64 builds for x64 and never arm64', () => {
    const { calls, status } = runScript('dist:mac:x64', 0)
    expect(status).toBe(0)
    const builder = calls.find((c) => c.startsWith('electron-builder'))!
    expect(builder).toContain('--mac --x64')
    expect(builder).not.toContain('arm64')
    expect(builder).toContain('-c.mac.identity=null')
  })

  it('restores the native node-pty afterwards, or `npm run dev` on Apple silicon breaks', () => {
    const { calls } = runScript('dist:mac:x64', 0)
    expect(calls[calls.length - 1]).toBe('npm run rebuild')
    expect(calls.findIndex((c) => c.startsWith('electron-builder'))).toBeLessThan(calls.length - 1)
  })

  it('restores it even when the build fails, and keeps the build failure as the exit status', () => {
    const { calls, status } = runScript('dist:mac:x64', 3)
    expect(calls[calls.length - 1]).toBe('npm run rebuild')
    expect(status).toBe(3)
  })

  it('a build that worked but a restore that failed is a failure, or an x64 node-pty goes unnoticed', () => {
    expect(runScript('dist:mac:x64', 0, 1).status).toBe(1)
  })

  it('when both fail, the build failure is the one reported', () => {
    expect(runScript('dist:mac:x64', 3, 1).status).toBe(3)
  })

  it('every mac target and the release build include x64', () => {
    const targets = pkg.build.mac.target as Array<{ arch: string[] }>
    expect(targets.length).toBeGreaterThan(0)
    for (const t of targets) expect(t.arch).toContain('x64')
    expect(pkg.scripts['release:mac']).toContain('--x64')
  })

  it('the graph layout dependency is pure JS: no install script, no platform pin', () => {
    expect(pkg.devDependencies['@dagrejs/dagre']).toBeDefined()
    for (const name of ['node_modules/@dagrejs/dagre', 'node_modules/@dagrejs/graphlib']) {
      const entry = lock.packages[name]
      expect(entry, name).toBeDefined()
      expect(entry.hasInstallScript, name).toBeUndefined()
      expect(entry.os, name).toBeUndefined()
      expect(entry.cpu, name).toBeUndefined()
    }
  })
})
