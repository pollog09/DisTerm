#!/usr/bin/env node
// Decides whether release-windows.yml may publish a tag as the latest GitHub Release, which is the
// Windows update feed. Refuses a tag whose release is already published (a rerun would replace the
// installer people update from) and a tag older than a published release (it would move every
// install back). A draft, or a prerelease that release.yml made for the mac and Linux packages, may
// be filled in and published.
//
// Usage: node scripts/release-win-gate.mjs vX.Y.Z   (GITHUB_REPOSITORY and GH_TOKEN from Actions)
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** @param {string} tag @returns {number[] | null} */
const semver = (tag) => {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)
  return m ? m.slice(1).map(Number) : null
}

/** @param {number[]} a @param {number[]} b */
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/**
 * @typedef {{ tag: string, draft: boolean, prerelease: boolean }} ReleaseRow
 * @param {string} tag this run's tag
 * @param {ReleaseRow[]} releases every release on the repo, drafts included
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function windowsReleaseGate(tag, releases) {
  const mine = semver(tag)
  if (!mine) return { ok: false, reason: `${tag} is not vX.Y.Z` }
  const published = releases.filter((r) => !r.draft && !r.prerelease)
  if (published.some((r) => r.tag === tag)) {
    return {
      ok: false,
      reason: `release ${tag} is already published; rerunning would replace the installer people update from. Cut a new version with npm run release.`
    }
  }
  const newer = published
    .map((r) => ({ tag: r.tag, v: semver(r.tag) }))
    .filter((r) => r.v !== null && compare(r.v, mine) > 0)
    .sort((a, b) => compare(/** @type {number[]} */ (b.v), /** @type {number[]} */ (a.v)))[0]
  if (newer) {
    return {
      ok: false,
      reason: `${newer.tag} is already published and is newer than ${tag}; publishing ${tag} as latest would move every Windows install back to it.`
    }
  }
  return { ok: true }
}

/** @param {string} out lines of "<tag> <draft> <prerelease>" @returns {ReleaseRow[]} */
export function parseReleaseRows(out) {
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length === 3)
    .map(([tag, draft, prerelease]) => ({ tag, draft: draft === 'true', prerelease: prerelease === 'true' }))
}

function main() {
  const tag = process.argv[2]
  const repo = process.env.GITHUB_REPOSITORY
  if (!tag || !repo) {
    console.error('::error::usage: GITHUB_REPOSITORY=owner/repo node scripts/release-win-gate.mjs vX.Y.Z')
    return 2
  }
  const r = spawnSync(
    'gh',
    ['api', '--paginate', `repos/${repo}/releases`, '--jq', '.[] | "\\(.tag_name) \\(.draft) \\(.prerelease)"'],
    { encoding: 'utf8' }
  )
  if (r.status !== 0) {
    console.error(`::error::cannot list the releases of ${repo}: ${(r.stderr ?? '').trim() || r.error?.message}`)
    return 1
  }
  const verdict = windowsReleaseGate(tag, parseReleaseRows(r.stdout))
  if (!verdict.ok) {
    console.error(`::error::${verdict.reason}`)
    return 1
  }
  console.log(`release gate: ${tag} may be published as the latest release`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
