import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { updateDelivery } from '../shared/update-platform'

/**
 * Release guard for the one Windows release path, release-windows.yml: a tag push builds the
 * installer with the update feed stamped in and publishes it as the latest, non-prerelease GitHub
 * Release, which is the feed itself (docs/adr/0001-unsigned-windows-auto-update.md). Text-level
 * (the repo carries no YAML parser), on workflows regular enough for it.
 */
const WORKFLOWS = path.resolve(__dirname, '../../.github/workflows')
const FEED = 'https://github.com/pollog09/DisTerm/releases/latest/download'

const read = (file: string): string =>
  fs.readFileSync(path.join(WORKFLOWS, file), 'utf8').replace(/\r\n/g, '\n')

/** Only the shell lines: comments explain the omissions and would match the negative checks. */
const commands = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')

/** One job's text, up to the next job. */
function jobBlock(text: string, job: string): string {
  const start = text.indexOf(`\n  ${job}:\n`)
  expect(start, `job ${job} not found`).toBeGreaterThanOrEqual(0)
  const rest = text.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

/** The first `run:` line of a job: the first command it executes. */
const firstRun = (block: string): string | undefined =>
  commands(block)
    .split('\n')
    .find((l) => /^\s+run: /.test(l))
    ?.trim()

/** Job names under `jobs:`. */
const jobNames = (text: string): string[] =>
  [...text.slice(text.indexOf('\njobs:\n')).matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1])

describe('release-windows.yml', () => {
  const text = read('release-windows.yml')
  const cmds = commands(text)
  const at = (needle: string): number => {
    const i = cmds.indexOf(needle)
    expect(i, needle).toBeGreaterThanOrEqual(0)
    return i
  }

  it('runs on a version tag push, and only then', () => {
    expect(text).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- 'v\*'\n\n/m)
    expect(text).not.toContain('workflow_dispatch')
  })

  it('may write the release', () => {
    expect(text).toMatch(/^permissions:\n {2}contents: write\b/m)
  })

  it('stamps the GitHub latest-release feed, and that feed makes a Windows build self-install', () => {
    const feed = /^ {2}FEED: (\S+)$/m.exec(text)?.[1]
    expect(feed).toBe(FEED)
    expect(
      updateDelivery({ isPackaged: true, updateMode: undefined, feed, platform: 'win32', hasAppImage: false })
    ).toBe('self-install')
  })

  it('has one job, and it runs the project-limit deadline guard as its first command', () => {
    expect(jobNames(text)).toEqual(['release-win'])
    expect(firstRun(jobBlock(text, 'release-win'))).toBe('run: node scripts/check-project-limit-deadline.mjs')
  })

  it('refuses a tag that is not package.json’s version, before installing anything', () => {
    const check = at('if [ "v${version}" != "${GITHUB_REF_NAME}" ]; then')
    expect(at('check-project-limit-deadline')).toBeLessThan(check)
    expect(check).toBeLessThan(at('run: npm ci'))
  })

  it('runs one release at a time across every tag, and never cancels a running one', () => {
    expect(text).toMatch(/^concurrency:\n {2}group: release-windows\n {2}cancel-in-progress: false\n/m)
    expect(text).not.toMatch(/group: .*github\.ref/)
  })

  it('refuses a tag that is not on main, with full history fetched, before installing anything', () => {
    expect(jobBlock(text, 'release-win')).toMatch(/- uses: actions\/checkout@v7\n {8}with:\n {10}fetch-depth: 0\b/)
    const fetch = at('git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main\n')
    const ancestry = at('if ! git merge-base --is-ancestor HEAD origin/main; then')
    expect(at('check-project-limit-deadline')).toBeLessThan(fetch)
    expect(fetch).toBeLessThan(ancestry)
    expect(ancestry).toBeLessThan(at('run: npm ci'))
  })

  it('asks the release gate before installing anything, and again right before the upload', () => {
    const early = at('run: node scripts/release-win-gate.mjs "${GITHUB_REF_NAME}"\n')
    const late = cmds.indexOf('node scripts/release-win-gate.mjs "$tag"\n')
    expect(early).toBeLessThan(at('run: npm ci'))
    expect(at('grep -qx "path: ${installer}"')).toBeLessThan(late)
    expect(late).toBeLessThan(at('gh release create'))
    expect(late).toBeLessThan(at('gh release upload'))
  })

  it('builds dist:win with the feed in the app and in electron-builder’s publish config', () => {
    expect(cmds).toContain(
      'run: npm run dist:win -- "-c.extraMetadata.distermUpdateFeed=${FEED}" -c.publish.provider=generic "-c.publish.url=${FEED}"\n'
    )
    expect(at('run: npm ci')).toBeLessThan(at('npm run dist:win'))
  })

  it('checks latest.yml names this version’s installer before uploading', () => {
    const verify = at('grep -qx "path: ${installer}"')
    expect(cmds).toContain('grep -qx "version: ${version}"')
    expect(at('npm run dist:win')).toBeLessThan(verify)
    expect(verify).toBeLessThan(at('gh release upload'))
  })

  it('uploads the installer, the zip and latest.yml, and no blockmap', () => {
    const upload = cmds.split('\n').find((l) => l.includes('gh release upload'))!
    expect(upload).toContain('"dist/DisTerm-Setup-${version}.exe" dist/DisTerm-*-win.zip dist/latest.yml --clobber')
    expect(cmds).not.toContain('blockmap')
    expect(cmds).not.toContain('dist/*.yml')
  })

  it('publishes the draft only after the upload, as latest and not a prerelease', () => {
    expect(at('--verify-tag --draft')).toBeLessThan(at('gh release upload'))
    expect(at('gh release upload')).toBeLessThan(at('--draft=false --prerelease=false --latest'))
    expect(cmds).not.toMatch(/--prerelease(?!=false)/)
  })

  it('talks to no upstream service', () => {
    expect(text).not.toContain('nodeterm.dev')
    expect(text).not.toContain('verify-feed')
  })
})

describe('release.yml', () => {
  const text = read('release.yml')

  it('runs by hand only', () => {
    expect(text).toMatch(/^on:\n {2}workflow_dispatch:\n/m)
    expect(text).not.toMatch(/^ {2}push:/m)
  })

  it('builds no Windows package, so release-windows.yml is the one Windows path', () => {
    expect(jobNames(text)).toEqual(['release-mac', 'release-linux', 'publish'])
    expect(commands(text)).not.toContain('dist:win')
    expect(commands(text)).not.toContain('--win')
  })

  it('runs the deadline guard first in every build job', () => {
    for (const job of ['release-mac', 'release-linux']) {
      expect(firstRun(jobBlock(text, job)), job).toBe('run: node scripts/check-project-limit-deadline.mjs')
    }
  })

  it('never changes the flags of a release that exists: it uploads, and creates a missing one as a prerelease', () => {
    const create =
      'gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1 || \\\n' +
      '            gh release create "$tag" --repo "$GITHUB_REPOSITORY" --title "$tag" --verify-tag --prerelease --notes "" || true\n'
    for (const job of ['release-mac', 'release-linux']) {
      const block = commands(jobBlock(text, job))
      expect(block, job).toContain(create)
      expect(block, job).toMatch(/until gh release upload "\$tag" .* --clobber --repo "\$GITHUB_REPOSITORY"; do\n/)
      expect(block, job).not.toContain('gh release edit')
      expect(block, job).not.toContain('softprops')
      expect(block, job).not.toContain('prerelease: true')
    }
    expect(commands(jobBlock(text, 'release-linux'))).toContain(
      'until gh release upload "$tag" dist/*.AppImage dist/*.deb dist/*.rpm --clobber --repo "$GITHUB_REPOSITORY"; do\n'
    )
  })

  it('promotes nothing and talks to no upstream service', () => {
    expect(commands(text)).not.toContain('--latest')
    expect(text).not.toContain('nodeterm.dev')
    expect(text).not.toContain('verify-feed')
  })
})
