#!/usr/bin/env node
// Cuts a DisTerm release: bumps the version, commits, tags and pushes main and the tag in one atomic
// push. The tag push is what starts .github/workflows/release-windows.yml, which builds and publishes
// the Windows installer and the update feed (docs/reference/packaging.md, docs/adr/0001).
//
// Usage: npm run release [-- patch|minor|major] [-- --dry-run]
//   `--dry-run` must come after `--`: npm reads a bare --dry-run as its own flag.
//
// The decision is `planRelease`, pure and table-tested (scripts/release.test.ts). This file only
// reads the repo's state and runs the steps the plan returns.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUMPS = ['patch', 'minor', 'major']
const REMOTE = 'origin'
const BRANCH = 'main'

/**
 * @param {string} current
 * @param {'patch' | 'minor' | 'major'} bump
 * @returns {string | null} null when `current` is not a plain X.Y.Z or `bump` is unknown
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
 * @typedef {{ branch: string, clean: boolean, upToDate: boolean, tagExists: boolean }} RepoState
 * @typedef {{ ok: true, next: string, tag: string, steps: string[][] }
 *   | { ok: false, reason: string }} ReleasePlan
 */

/**
 * @param {string} current the version in package.json
 * @param {'patch' | 'minor' | 'major'} bump
 * @param {RepoState} state `tagExists` is about the tag of the bumped version
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
  if (state.tagExists) return { ok: false, reason: `tag ${tag} already exists` }
  return {
    ok: true,
    next,
    tag,
    steps: [
      ['npm', 'version', next, '--no-git-tag-version'],
      ['git', 'add', 'package.json', 'package-lock.json'],
      ['git', 'commit', '-m', `chore(release): ${tag}`],
      ['git', 'tag', '-a', tag, '-m', tag],
      // Atomic: the tag never reaches the remote without the commit it points at, or the reverse.
      ['git', 'push', '--atomic', REMOTE, BRANCH, tag]
    ]
  }
}

/**
 * @param {string[]} argv
 * @returns {{ bump: string, dryRun: boolean } | { error: string }}
 */
export function parseArgs(argv) {
  let bump = 'patch'
  let dryRun = false
  let seenBump = false
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true
    else if (BUMPS.includes(a) && !seenBump) {
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
 * Read-only: `ls-remote` asks the remote without fetching, so a dry run moves no ref.
 * Untracked files do not make the tree dirty: the release commit adds only the two version files.
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
  return { branch, clean, upToDate, tagExists: localTag || remoteTag.out !== '' }
}

const shellWord = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)

function main() {
  const args = parseArgs(process.argv.slice(2))
  if ('error' in args) {
    console.error(`release: ${args.error}\nusage: npm run release [-- patch|minor|major] [-- --dry-run]`)
    return 2
  }
  const cwd = process.cwd()
  const current = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).version
  const next = bumpVersion(current, /** @type {any} */ (args.bump))
  let state
  try {
    state = readRepoState(cwd, `v${next ?? current}`)
  } catch (err) {
    console.error(`release: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const plan = planRelease(current, /** @type {any} */ (args.bump), state)
  if (!plan.ok) {
    console.error(`release: refused, ${plan.reason}`)
    return 1
  }
  console.log(`release: ${current} -> ${plan.next} (${plan.tag})${args.dryRun ? ', dry run, nothing will change' : ''}`)
  for (const step of plan.steps) {
    console.log(`  ${step.map(shellWord).join(' ')}`)
    if (args.dryRun) continue
    const [cmd, ...rest] = step
    // npm is npm.cmd on Windows, which spawn only finds through a shell.
    const r = spawnSync(cmd, rest, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' })
    if (r.status !== 0) {
      console.error(`release: step failed (exit ${r.status}): ${step.join(' ')}`)
      return 1
    }
  }
  if (!args.dryRun) console.log(`release: pushed ${plan.tag}; the Windows release workflow builds and publishes it`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
