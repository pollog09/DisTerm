import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { testTmpDir } from './test-tmp'
import { fakePlatform } from './platform-fake'

const broadcast = vi.fn()
let bareRoot: string
let GitService: typeof import('./git-service').GitService

const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()

beforeAll(async () => {
  bareRoot = testTmpDir('dis-clone-bare-')
  mkdirSync(path.join(bareRoot, 'owner'))
  const bare = path.join(bareRoot, 'owner', 'repo.git')
  run(bareRoot, 'init', '--bare', '-b', 'main', bare)
  const work = testTmpDir('dis-clone-work-')
  run(work, 'init', '-b', 'main')
  writeFileSync(path.join(work, 'README.md'), 'cloned\n')
  run(work, 'add', '.')
  run(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init')
  run(work, 'push', bare, 'main')
  // Sends the https URL the service builds to the local bare repository. GIT_ENV is read at import.
  vi.stubEnv('GIT_CONFIG_COUNT', '1')
  vi.stubEnv('GIT_CONFIG_KEY_0', `url.file://${bareRoot}/.insteadOf`)
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/')
  vi.resetModules()
  const { initPlatform } = await import('./platform')
  initPlatform({ ...fakePlatform(), broadcast })
  GitService = (await import('./git-service')).GitService
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('GitService.clone, unattended', () => {
  it('clones into the chosen name, creating the parent, and stays off the dialog progress channel', async () => {
    const parent = path.join(testTmpDir('dis-clone-'), 'Documents', 'Distriib')
    const result = await new GitService().clone(parent, 'owner/repo', { dirName: 'Exotic Garage' })
    expect(result).toEqual({ ok: true, message: path.join(parent, 'Exotic Garage') })
    expect(existsSync(path.join(parent, 'Exotic Garage', 'README.md'))).toBe(true)
    expect(broadcast.mock.calls.filter(([channel]) => String(channel).includes('clone'))).toEqual([])
  })

  it('refuses a folder that already exists and leaves it alone', async () => {
    const parent = testTmpDir('dis-clone-')
    mkdirSync(path.join(parent, 'Taken'))
    writeFileSync(path.join(parent, 'Taken', 'mine.txt'), 'x')
    const result = await new GitService().clone(parent, 'owner/repo', { dirName: 'Taken' })
    expect(result).toEqual({
      ok: false,
      message: `Destination already exists: ${path.join(parent, 'Taken')}. Pick another folder or open it directly.`
    })
    expect(existsSync(path.join(parent, 'Taken', 'mine.txt'))).toBe(true)
  })

  it.each(['..', '.', 'a/b', 'a\\b', ''])('refuses the folder name %j', async (dirName) => {
    const parent = testTmpDir('dis-clone-')
    expect(await new GitService().clone(parent, 'owner/repo', { dirName })).toEqual({
      ok: false,
      message: 'Could not derive a folder name from that URL.'
    })
  })

  it('removes its own claim when the clone fails, so the next sync can retry', async () => {
    const parent = testTmpDir('dis-clone-')
    const result = await new GitService().clone(parent, 'owner/missing', { dirName: 'Web' })
    expect(result.ok).toBe(false)
    expect(existsSync(path.join(parent, 'Web'))).toBe(false)
  })

  it('gives up at the watchdog and frees the single-flight slot', async () => {
    const parent = testTmpDir('dis-clone-')
    const service = new GitService()
    const result = await service.clone(parent, 'owner/repo', { dirName: 'Slow', timeoutMs: 0 })
    expect(result).toEqual({ ok: false, message: 'aborted' })
    expect((await service.clone(parent, 'owner/repo', { dirName: 'Next' })).ok).toBe(true)
  })

  it('the interactive clone still derives its folder from the URL', async () => {
    const parent = testTmpDir('dis-clone-')
    expect(await new GitService().clone(parent, 'owner/repo')).toEqual({ ok: true, message: path.join(parent, 'repo') })
  })
})
