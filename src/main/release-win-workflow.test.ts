import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Release guard for the Windows job: it builds the ordinary package, publishes no update feed
 * (DisTerm has none) and never promotes a release. Text-level, like the job's own artifact-contract
 * step; no YAML parser needed for a job block this regular.
 */
const WORKFLOW = path.resolve(__dirname, '../../.github/workflows/release.yml')

function jobBlock(text: string, job: string): string {
  const start = text.indexOf(`\n  ${job}:\n`)
  expect(start, `job ${job} not found in release.yml`).toBeGreaterThanOrEqual(0)
  const rest = text.slice(start + 1)
  // The next top-level job: a line indented exactly two spaces that names a key.
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

/** Only the shell lines — comments explain the omissions and would match the negative checks. */
function commands(block: string): string {
  return block
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
}

describe('release.yml release-win', () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8')
  const job = commands(jobBlock(text, 'release-win'))

  it('builds the ordinary Windows package', () => {
    expect(job).toMatch(/run: npm run dist:win\s*\n/)
  })

  it('uploads the installer and zip by their DisTerm names, and no feed file', () => {
    const upload = job.split('\n').find((l) => l.includes('gh release upload'))
    expect(upload).toBeDefined()
    expect(upload).toContain('dist/DisTerm-Setup-*.exe')
    expect(upload).toContain('dist/DisTerm-*-win.zip')
    expect(upload).not.toContain('latest.yml')
  })

  it('uploads no blockmap and no broad yml glob', () => {
    expect(job).not.toContain('blockmap')
    expect(job).not.toContain('dist/*.yml')
  })

  it('is still not a gate on the mac+linux publish', () => {
    const publish = commands(jobBlock(text, 'publish'))
    expect(publish).toMatch(/needs: \[release-mac, release-linux\]/)
    expect(publish).not.toContain('release-win')
  })
})

describe('release.yml as a whole', () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8')

  it('runs by hand only', () => {
    expect(text).toMatch(/^on:\n {2}workflow_dispatch:\n/m)
    expect(text).not.toMatch(/^ {2}push:/m)
  })

  it('verifies no feed and promotes nothing', () => {
    expect(text).not.toContain('verify-feed')
    expect(text).not.toContain('nodeterm.dev')
    expect(commands(text)).not.toContain('--latest')
  })
})
