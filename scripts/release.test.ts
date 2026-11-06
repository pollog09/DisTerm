import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'fs'
import path from 'path'
import { testTmpDir } from '../src/core/test-tmp'
// @ts-expect-error -- plain .mjs repo tooling, deliberately outside the typechecked projects.
import { bumpVersion, parseArgs, planRelease } from './release.mjs'

const SCRIPT = path.resolve(__dirname, 'release.mjs')
const READY = { branch: 'main', clean: true, upToDate: true, tagExists: false }

describe('bumpVersion', () => {
  it.each([
    ['0.4.5', 'patch', '0.4.6'],
    ['0.4.5', 'minor', '0.5.0'],
    ['0.4.5', 'major', '1.0.0'],
    ['1.9.9', 'patch', '1.9.10'],
    ['0.4.5-beta.1', 'patch', null],
    ['0.4', 'patch', null],
    ['0.4.5', 'huge', null]
  ])('%s + %s = %s', (current, bump, expected) => {
    expect(bumpVersion(current, bump)).toBe(expected)
  })
})

describe('planRelease', () => {
  it('plans the bump, the commit, the tag and one atomic push', () => {
    expect(planRelease('0.4.5', 'patch', READY)).toEqual({
      ok: true,
      next: '0.4.6',
      tag: 'v0.4.6',
      steps: [
        ['npm', 'version', '0.4.6', '--no-git-tag-version'],
        ['git', 'add', 'package.json', 'package-lock.json'],
        ['git', 'commit', '-m', 'chore(release): v0.4.6'],
        ['git', 'tag', '-a', 'v0.4.6', '-m', 'v0.4.6'],
        ['git', 'push', '--atomic', 'origin', 'main', 'v0.4.6']
      ],
      undoPush: [
        ['git', 'tag', '-d', 'v0.4.6'],
        ['git', 'reset', '--soft', 'HEAD~1'],
        ['git', 'checkout', 'HEAD', '--', 'package.json', 'package-lock.json']
      ]
    })
  })

  it('names the bumped version in every step for a minor bump', () => {
    const plan = planRelease('0.4.5', 'minor', READY)
    expect(plan.ok && plan.tag).toBe('v0.5.0')
    expect(plan.ok && plan.steps[4]).toEqual(['git', 'push', '--atomic', 'origin', 'main', 'v0.5.0'])
  })

  it.each([
    [{ ...READY, branch: 'feat/x' }, 'on branch "feat/x", releases are cut from main'],
    [{ ...READY, clean: false }, 'the working tree has uncommitted changes'],
    [{ ...READY, upToDate: false }, 'main is not the same commit as origin/main: pull or push first'],
    [{ ...READY, tagExists: true }, 'tag v0.4.6 already exists']
  ])('refuses %o', (state, reason) => {
    expect(planRelease('0.4.5', 'patch', state)).toEqual({ ok: false, reason })
  })

  it('refuses an unknown bump and a version that is not X.Y.Z', () => {
    expect(planRelease('0.4.5', 'huge', READY)).toEqual({
      ok: false,
      reason: 'unknown bump "huge": use patch, minor or major'
    })
    expect(planRelease('0.4.5-rc.1', 'patch', READY)).toEqual({
      ok: false,
      reason: 'package.json version "0.4.5-rc.1" is not X.Y.Z'
    })
  })

  it('reports the first refusal when several apply', () => {
    expect(planRelease('0.4.5', 'patch', { branch: 'dev', clean: false, upToDate: false, tagExists: true })).toEqual({
      ok: false,
      reason: 'on branch "dev", releases are cut from main'
    })
  })
})

describe('parseArgs', () => {
  it.each([
    [[], { bump: 'patch', dryRun: false }],
    [['minor'], { bump: 'minor', dryRun: false }],
    [['--dry-run', 'major'], { bump: 'major', dryRun: true }],
    [['huge'], { error: 'unexpected argument "huge"' }],
    [['patch', 'minor'], { error: 'unexpected argument "minor"' }],
    [['--force'], { error: 'unexpected argument "--force"' }]
  ])('%j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected)
  })

  it.each([
    [{ npm_config_dry_run: 'true' }, { bump: 'patch', dryRun: true }],
    [{ npm_config_dry_run: 'false' }, { bump: 'patch', dryRun: false }],
    [{ npm_config_dry_run: '' }, { bump: 'patch', dryRun: false }],
    [{}, { bump: 'patch', dryRun: false }]
  ])('reads npm’s own --dry-run from %j', (env, expected) => {
    expect(parseArgs([], env)).toEqual(expected)
  })
})

/** A clone of a local bare remote holding a package.json and lockfile at 0.4.5. No network. */
function fixtureRepo(): { work: string; origin: string } {
  const root = testTmpDir('nt-release-')
  const origin = path.join(root, 'origin.git')
  const work = path.join(root, 'work')
  const run = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  run(root, 'init', '-q', '--bare', '-b', 'main', origin)
  run(root, 'clone', '-q', origin, work)
  run(work, 'checkout', '-q', '-B', 'main')
  run(work, 'config', 'user.email', 'release-test@example.invalid')
  run(work, 'config', 'user.name', 'release test')
  run(work, 'config', 'commit.gpgsign', 'false')
  run(work, 'config', 'tag.gpgsign', 'false')
  // A global hooks path would run the developer's own hooks on the fixture's commit and push.
  fs.mkdirSync(path.join(root, 'no-hooks'))
  run(work, 'config', 'core.hooksPath', path.join(root, 'no-hooks'))
  const pkg = { name: 'node-terminal', version: '0.4.5', private: true, scripts: { release: `node "${SCRIPT}"` } }
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  const lock = { name: 'node-terminal', version: '0.4.5', lockfileVersion: 3, requires: true, packages: { '': pkg } }
  fs.writeFileSync(path.join(work, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n')
  run(work, 'add', '.')
  run(work, 'commit', '-q', '-m', 'init')
  run(work, 'push', '-q', 'origin', 'main')
  return { work, origin }
}

/** The test run's own env, minus an npm dry-run flag it may have been started with. */
function scriptEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // npm turns on Node's compile cache, which would leave a node-compile-cache dir in the run's tmp.
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', ...extra }
  if (!('npm_config_dry_run' in extra)) delete env.npm_config_dry_run
  return env
}

function release(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: scriptEnv() })
}

const DRY_RUN_PATCH = [
  'release: 0.4.5 -> 0.4.6 (v0.4.6), dry run, nothing will change',
  '  npm version 0.4.6 --no-git-tag-version',
  '  git add package.json package-lock.json',
  "  git commit -m 'chore(release): v0.4.6'",
  '  git tag -a v0.4.6 -m v0.4.6',
  '  git push --atomic origin main v0.4.6',
  ''
].join('\n')

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim()

describe('the release script against a local remote', () => {
  it('a dry run prints the plan and changes nothing', () => {
    const { work, origin } = fixtureRepo()
    const before = { head: git(work, 'rev-parse', 'HEAD'), remote: git(origin, 'rev-parse', 'main') }
    const r = release(work, '--dry-run', 'minor')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe(
      [
        'release: 0.4.5 -> 0.5.0 (v0.5.0), dry run, nothing will change',
        '  npm version 0.5.0 --no-git-tag-version',
        '  git add package.json package-lock.json',
        "  git commit -m 'chore(release): v0.5.0'",
        '  git tag -a v0.5.0 -m v0.5.0',
        '  git push --atomic origin main v0.5.0',
        ''
      ].join('\n')
    )
    expect(git(work, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(git(origin, 'rev-parse', 'main')).toBe(before.remote)
    expect(git(work, 'tag')).toBe('')
    expect(git(work, 'status', '--porcelain')).toBe('')
  })

  it.each([
    ['npm_config_dry_run=true', process.execPath, [SCRIPT], { npm_config_dry_run: 'true' }],
    ['npm run release --dry-run', 'npm', ['run', '--silent', 'release', '--dry-run'], {}]
  ])('%s is a dry run too, not a release', (_name, cmd, args, extra) => {
    const { work, origin } = fixtureRepo()
    const before = { head: git(work, 'rev-parse', 'HEAD'), remote: git(origin, 'rev-parse', 'main') }
    const shell = process.platform === 'win32' && cmd === 'npm'
    const r = spawnSync(cmd, args, { cwd: work, encoding: 'utf8', env: scriptEnv(extra), shell })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(DRY_RUN_PATCH)
    expect(git(work, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(git(origin, 'rev-parse', 'main')).toBe(before.remote)
    expect(git(work, 'tag')).toBe('')
    expect(git(work, 'status', '--porcelain')).toBe('')
  })

  it('bumps both version files, commits, tags and pushes main and the tag', () => {
    const { work, origin } = fixtureRepo()
    const r = release(work)
    expect(r.status, r.stderr).toBe(0)
    const pkg = JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8'))
    const lock = JSON.parse(fs.readFileSync(path.join(work, 'package-lock.json'), 'utf8'))
    expect([pkg.version, lock.version, lock.packages[''].version]).toEqual(['0.4.6', '0.4.6', '0.4.6'])
    expect(git(origin, 'log', '-1', '--format=%s', 'main')).toBe('chore(release): v0.4.6')
    expect(git(origin, 'rev-parse', 'v0.4.6^{commit}')).toBe(git(origin, 'rev-parse', 'main'))
    expect(git(origin, 'show', 'main:package.json')).toContain('"version": "0.4.6"')
  })

  it('takes back its own commit and tag when the remote refuses the push, so a rerun works', () => {
    const { work, origin } = fixtureRepo()
    const hooks = path.join(origin, 'hooks')
    // Set explicitly: a developer's global core.hooksPath would otherwise replace the bare repo's hooks.
    spawnSync('git', ['config', 'core.hooksPath', hooks], { cwd: origin })
    const hook = path.join(hooks, 'pre-receive')
    fs.writeFileSync(hook, '#!/bin/sh\necho "push refused by test hook" >&2\nexit 1\n', { mode: 0o755 })
    const start = git(work, 'rev-parse', 'HEAD')

    const refused = release(work)
    expect(refused.status).toBe(1)
    expect(refused.stderr.slice(refused.stderr.indexOf('release: step failed'))).toBe(
      [
        'release: step failed (exit 1): git push --atomic origin main v0.4.6',
        "release: the push did not land; undoing this run's commit and tag v0.4.6:",
        '  git tag -d v0.4.6',
        "  git reset --soft 'HEAD~1'",
        '  git checkout HEAD -- package.json package-lock.json',
        'release: back at 0.4.5 with no tag; fix the push and run it again',
        ''
      ].join('\n')
    )
    expect(git(work, 'rev-parse', 'HEAD')).toBe(start)
    expect(git(work, 'tag')).toBe('')
    expect(git(work, 'status', '--porcelain')).toBe('')
    expect(JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8')).version).toBe('0.4.5')
    expect(git(origin, 'log', '-1', '--format=%s', 'main')).toBe('init')

    fs.rmSync(hook)
    const rerun = release(work)
    expect(rerun.status, rerun.stderr).toBe(0)
    expect(git(origin, 'log', '-1', '--format=%s', 'main')).toBe('chore(release): v0.4.6')
    expect(git(origin, 'rev-parse', 'v0.4.6^{commit}')).toBe(git(origin, 'rev-parse', 'main'))
  })

  it('refuses a dirty tree and an existing tag without touching anything', () => {
    const { work, origin } = fixtureRepo()
    fs.appendFileSync(path.join(work, 'package.json'), '\n')
    const dirty = release(work)
    expect(dirty.status).toBe(1)
    expect(dirty.stderr).toBe('release: refused, the working tree has uncommitted changes\n')
    spawnSync('git', ['checkout', '--', 'package.json'], { cwd: work })

    spawnSync('git', ['tag', 'v0.4.6'], { cwd: work })
    const tagged = release(work)
    expect(tagged.status).toBe(1)
    expect(tagged.stderr).toBe('release: refused, tag v0.4.6 already exists\n')
    expect(git(origin, 'log', '-1', '--format=%s', 'main')).toBe('init')
  })

  it('refuses when main is behind origin/main', () => {
    const { work, origin } = fixtureRepo()
    const other = path.join(path.dirname(work), 'other')
    spawnSync('git', ['clone', '-q', origin, other])
    spawnSync('git', ['-c', 'user.email=a@b.invalid', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'ahead'], { cwd: other })
    spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: other })
    const r = release(work, '--dry-run')
    expect(r.status).toBe(1)
    expect(r.stderr).toBe('release: refused, main is not the same commit as origin/main: pull or push first\n')
  })
})
