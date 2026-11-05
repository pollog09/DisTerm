import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The installer's output is read by a person in a terminal, but also captured: the desktop's
// "Share with team" dialog streams it over an ssh exec channel (no pty) into a log, and the
// nightly auto-update runs it under systemd into the journal. There the colour escapes arrived
// as literal `\033[36m` text in front of every line (device run, 2026-10-03). Only the helper
// block is run here: the whole script needs systemd, git and a network.
const SCRIPT = readFileSync(join(__dirname, 'install-server.sh'), 'utf8').replace(/\r\n/g, '\n')

function helpers(): string {
  const start = SCRIPT.indexOf('# ---- pretty output')
  const end = SCRIPT.indexOf('# ---- preflight', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return SCRIPT.slice(start, end)
}

function run(env: Record<string, string> = {}): { stdout: string; stderr: string } {
  const r = spawnSync('bash', ['-c', `set -euo pipefail\n${helpers()}\ninfo one\nok two\nwarn three`], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  expect(r.status).toBe(0)
  return { stdout: r.stdout, stderr: r.stderr }
}

describe.skipIf(process.platform === 'win32')('install-server.sh output', () => {
  it('writes no escape codes when its output is not a terminal', () => {
    const { stdout, stderr } = run()
    expect(stdout).toBe('→ one\n✓ two\n')
    expect(stderr).toBe('⚠ three\n')
  })

  it('fail() still exits 1 and names the reason, uncoloured', () => {
    const r = spawnSync('bash', ['-c', `set -euo pipefail\n${helpers()}\nfail broken\necho unreachable`], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('✗ broken\n')
  })
})

// Never upstream's code, whichever way the checkout got there. Runs the script's own guard and update
// blocks under real /bin/sh against real git and local repositories, one of them at an upstream-named
// path, so that "installed upstream's code" is something a checkout's files can show.
describe.skipIf(process.platform === 'win32')('install-server.sh source check', () => {
  const between = (from: string, to: string): string => {
    const start = SCRIPT.indexOf(from)
    const end = SCRIPT.indexOf(to, start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return SCRIPT.slice(start, end)
  }
  const BLOCK = [
    helpers(),
    between('# ---- where the code comes from', '# ---- Node.js: use'),
    between('# ---- clone or update', 'cd "$APP_DIR"')
  ].join('\n')

  const GIT_ENV = {
    PATH: '/usr/bin:/bin:/usr/local/bin',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t'
  }
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim()
  }

  let root: string
  let app: string
  let upstream: string
  let mine: string

  /** A repository on `main` holding one file named `marker`. */
  function repo(dir: string, marker: string): string {
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, marker), marker)
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', marker)
    return `file://${dir}`
  }

  function runBlock(env: Record<string, string> = {}): { status: number | null; stderr: string } {
    const r = spawnSync('/bin/sh', ['-c', `set -eu\nAPP_DIR='${app}'\n${BLOCK}`], {
      encoding: 'utf8',
      env: { ...GIT_ENV, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: r.status, stderr: r.stderr }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nt-install-src-'))
    app = join(root, 'app')
    // Mixed case on purpose: the match must not depend on how a url was typed.
    upstream = repo(join(root, 'EnesKirca', 'NodeTerm'), 'upstream.txt')
    mine = repo(join(root, 'me', 'mine'), 'mine.txt')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const cloneUpstream = (): void => {
    git(root, 'clone', '-q', upstream, app)
  }

  it('an upstream checkout with NODETERM_REPO_URL set installs the clone, never upstream', () => {
    cloneUpstream()
    // A commit upstream made after the clone: a fetch from there would bring it in.
    const up = join(root, 'EnesKirca', 'NodeTerm')
    writeFileSync(join(up, 'newer-upstream.txt'), 'x')
    git(up, 'add', '.')
    git(up, 'commit', '-qm', 'newer')

    expect(runBlock({ NODETERM_REPO_URL: mine }).status).toBe(0)
    expect(git(app, 'remote', 'get-url', 'origin')).toBe(mine)
    expect(existsSync(join(app, 'mine.txt'))).toBe(true)
    expect(existsSync(join(app, 'upstream.txt'))).toBe(false)
    expect(existsSync(join(app, 'newer-upstream.txt'))).toBe(false)
  })

  it('an upstream checkout with nothing to replace it refuses and fetches nothing', () => {
    cloneUpstream()
    const before = git(app, 'rev-parse', 'HEAD')
    const up = join(root, 'EnesKirca', 'NodeTerm')
    writeFileSync(join(up, 'newer-upstream.txt'), 'x')
    git(up, 'add', '.')
    git(up, 'commit', '-qm', 'newer')

    const r = runBlock()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Not updating from upstream')
    expect(git(app, 'rev-parse', 'origin/main')).toBe(before)
  })

  it('NODETERM_REPO_URL naming upstream refuses, in any case', () => {
    for (const url of ['https://github.com/eneskirca/nodeterm', 'git@GitHub.com:EnesKirca/NODETERM.git']) {
      const r = runBlock({ NODETERM_REPO_URL: url })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('Not installing from upstream')
    }
    expect(existsSync(app)).toBe(false)
  })

  it('no source and no checkout refuses', () => {
    const r = runBlock()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('No source to install from')
    expect(existsSync(app)).toBe(false)
  })

  it('your own checkout updates from its own origin, and a first install clones the url given', () => {
    expect(runBlock({ NODETERM_REPO_URL: mine }).status).toBe(0)
    expect(existsSync(join(app, 'mine.txt'))).toBe(true)
    const own = join(root, 'me', 'mine')
    writeFileSync(join(own, 'second.txt'), 'x')
    git(own, 'add', '.')
    git(own, 'commit', '-qm', 'second')
    expect(runBlock().status).toBe(0)
    expect(existsSync(join(app, 'second.txt'))).toBe(true)
  })
})
