#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUMPS = ['patch', 'minor', 'major']
const REMOTE = 'origin'
const BRANCH = 'main'

/**
 * @typedef {'patch' | 'minor' | 'major'} Bump
 * @param {string} current
 * @param {Bump} bump
 * @returns {string | null}
 */
export function bumpVersion(current, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
  if (!m) return null
  const [major, minor, patch] = m.slice(1).map(Number)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`
  return null
}

/**
 * @typedef {{ branch: string, clean: boolean, upToDate: boolean, nextTagExists: boolean }} RepoState
 * @typedef {{ ok: true, next: string, tag: string, steps: string[][], undoPush: string[][] }
 *   | { ok: false, reason: string }} ReleasePlan
 */

/**
 * @param {string} current
 * @param {Bump} bump
 * @param {RepoState} state
 * @returns {ReleasePlan}
 */
export function planRelease(current, bump, state) {
  if (!BUMPS.includes(bump)) return { ok: false, reason: `unknown bump "${bump}": use patch, minor or major` }
  const next = bumpVersion(current, bump)
  if (next === null) return { ok: false, reason: `package.json version "${current}" is not X.Y.Z` }
  const tag = `v${next}`
  if (state.branch !== BRANCH) return { ok: false, reason: `on branch "${state.branch}", releases are cut from ${BRANCH}` }
  if (!state.clean) return { ok: false, reason: 'the working tree has uncommitted changes' }
  if (!state.upToDate) return { ok: false, reason: `${BRANCH} is not the same commit as ${REMOTE}/${BRANCH}: pull or push first` }
  if (state.nextTagExists) return { ok: false, reason: `tag ${tag} already exists` }
  return {
    ok: true,
    next,
    tag,
    steps: [
      ['npm', 'version', next, '--no-git-tag-version'],
      ['git', 'add', 'package.json', 'package-lock.json'],
      ['git', 'commit', '-m', `chore(release): ${tag}`],
      ['git', 'tag', '-a', tag, '-m', tag],
      ['git', 'push', '--atomic', REMOTE, BRANCH, tag]
    ],
    undoPush: [
      ['git', 'tag', '-d', tag],
      ['git', 'reset', '--soft', 'HEAD~1'],
      ['git', 'checkout', 'HEAD', '--', 'package.json', 'package-lock.json']
    ]
  }
}

/** @param {string} a @returns {a is Bump} */
const isBump = (a) => BUMPS.includes(a)

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ bump: Bump, dryRun: boolean } | { error: string }}
 */
export function parseArgs(argv, env = {}) {
  /** @type {Bump} */
  let bump = 'patch'
  // A bare `npm run release --dry-run` reaches the script only as npm_config_dry_run=true.
  let dryRun = !['', 'false', '0'].includes(env.npm_config_dry_run ?? '')
  let seenBump = false
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true
    else if (isBump(a) && !seenBump) {
      bump = a
      seenBump = true
    } else return { error: `unexpected argument "${a}"` }
  }
  return { bump, dryRun }
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

/**
 * @param {string} cwd
 * @param {string} tag
 * @returns {RepoState}
 */
export function readRepoState(cwd, tag) {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out
  const clean = git(cwd, ['status', '--porcelain', '--untracked-files=no']).out === ''
  const head = git(cwd, ['rev-parse', 'HEAD']).out
  const remote = git(cwd, ['ls-remote', REMOTE, `refs/heads/${BRANCH}`])
  if (!remote.ok) throw new Error(`cannot reach ${REMOTE}: ${remote.err}`)
  const upToDate = remote.out.split(/\s+/)[0] === head
  const localTag = git(cwd, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).ok
  const remoteTag = git(cwd, ['ls-remote', '--tags', REMOTE, `refs/tags/${tag}`])
  if (!remoteTag.ok) throw new Error(`cannot list ${REMOTE}'s tags: ${remoteTag.err}`)
  return { branch, clean, upToDate, nextTagExists: localTag || remoteTag.out !== '' }
}

/**
 * @param {string} cwd
 * @param {Extract<ReleasePlan, { ok: true }>} plan
 * @param {string} current
 * @param {string} startHead
 */
function undoPush(cwd, plan, current, startHead) {
  const head = git(cwd, ['rev-parse', 'HEAD']).out
  const isThisRunsCommit =
    git(cwd, ['rev-parse', 'HEAD~1']).out === startHead && git(cwd, ['rev-parse', `${plan.tag}^{commit}`]).out === head
  const remoteTag = git(cwd, ['ls-remote', '--tags', REMOTE, `refs/tags/${plan.tag}`])
  const canAskRemote = remoteTag.ok
  const remoteHasTag = remoteTag.out !== ''
  let keep = null
  if (!isThisRunsCommit) keep = 'they are not the ones this run made'
  else if (!canAskRemote) keep = `cannot ask ${REMOTE} whether the push landed`
  else if (remoteHasTag) keep = `${REMOTE} has ${plan.tag}, so the push may have landed`
  if (keep) {
    console.error(`release: left the release commit and tag ${plan.tag} in place: ${keep}`)
    return
  }
  console.error(`release: the push did not land; undoing this run's commit and tag ${plan.tag}:`)
  for (const step of plan.undoPush) {
    console.error(`  ${step.map(shellWord).join(' ')}`)
    const r = git(cwd, step.slice(1))
    if (!r.ok) {
      console.error(`release: undo step failed: ${r.err}`)
      return
    }
  }
  console.error(`release: back at ${current} with no tag; fix the push and run it again`)
}

const shellWord = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)

function main() {
  const args = parseArgs(process.argv.slice(2), process.env)
  if ('error' in args) {
    console.error(`release: ${args.error}\nusage: npm run release [-- patch|minor|major] [-- --dry-run]`)
    return 2
  }
  const cwd = process.cwd()
  const current = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).version
  const next = bumpVersion(current, args.bump)
  let state
  try {
    state = readRepoState(cwd, `v${next ?? current}`)
  } catch (err) {
    console.error(`release: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const plan = planRelease(current, args.bump, state)
  if (!plan.ok) {
    console.error(`release: refused, ${plan.reason}`)
    return 1
  }
  console.log(`release: ${current} -> ${plan.next} (${plan.tag})${args.dryRun ? ', dry run, nothing will change' : ''}`)
  const startHead = git(cwd, ['rev-parse', 'HEAD']).out
  for (const [i, step] of plan.steps.entries()) {
    console.log(`  ${step.map(shellWord).join(' ')}`)
    if (args.dryRun) continue
    const [cmd, ...rest] = step
    // npm is npm.cmd on Windows, which spawn only finds through a shell.
    const r = spawnSync(cmd, rest, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' })
    if (r.status !== 0) {
      console.error(`release: step failed (exit ${r.status}): ${step.join(' ')}`)
      if (i === plan.steps.length - 1) undoPush(cwd, plan, current, startHead)
      return 1
    }
  }
  if (!args.dryRun) console.log(`release: pushed ${plan.tag}; the Windows release workflow builds and publishes it`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
