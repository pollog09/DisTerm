// THE STALE-CWD SIGNAL, PROVEN AGAINST A REAL TMUX (issue #464).
//
// Unit tests pin what `classifyPaneCwd` does with an answer; whether tmux actually gives that
// answer for a session whose start directory was deleted — and keeps giving it after a same-named
// directory is re-created (a DIFFERENT inode, the whole point of the issue) — is a property of
// tmux and the kernel, so it is measured here on a private socket, exactly like the other
// realtmux suites.
//
// Also proven, because the issue asks it explicitly: a NEW session created after the re-creation
// starts in the re-created directory — the spawn path was never the broken half.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { classifyPaneCwd } from './pane-cwd'
import { makeTmuxTmpdir } from './tmux-test-socket'

const SOCKET = `nt-cwd-${process.pid}`

let tmp: string
let tmuxOk = false

function tmux(args: string[], opts?: { cwd?: string }): string {
  return execFileSync('tmux', ['-L', SOCKET, ...args], {
    env: { ...process.env, TMUX_TMPDIR: tmp },
    cwd: opts?.cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString()
}

/** The exact probe `PtyManager.paneCwdStale` runs: exact-match target, one format. The trailing
 *  colon is load-bearing and MEASURED here (tmux 3.4): a bare `=name` target-pane resolves
 *  NOTHING silently — exit 0, every format empty — while `=name:` is "exactly this session, its
 *  active pane". The first assertion below (`'ok'`, not `'unknown'`) is what pins it. */
function panePath(session: string): string {
  return tmux(['display-message', '-p', '-t', `=${session}:`, '#{pane_current_path}']).replace(
    /\r?\n$/,
    ''
  )
}

/**
 * Wait until the pane runs its command. tmux makes a new pane's child the terminal's foreground
 * process BEFORE that child changes into its `-c` directory, so a query in that gap reads the
 * server's own directory. On a starved runner the gap is long enough to land in (ubuntu-latest,
 * tmux 3.6, the full suite: both tests below read the checkout instead of their start dir). The
 * child execs the command only after the chdir, so once tmux names `sleep` the directory is final.
 */
function waitForPane(session: string): void {
  const until = Date.now() + 10_000
  while (tmux(['display-message', '-p', '-t', `=${session}:`, '#{pane_current_command}']).trim() !== 'sleep') {
    if (Date.now() > until) throw new Error(`the pane in ${session} never started its command`)
  }
}

const dirExists = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

beforeAll(() => {
  if (process.platform === 'win32') return // no tmux on Windows — the session host owns that world
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    tmuxOk = true
  } catch {
    return // no tmux on this host — every test below self-skips
  }
  tmp = makeTmuxTmpdir('ntcwd-', SOCKET)
})

afterAll(() => {
  if (!tmuxOk) return
  try {
    tmux(['kill-server'])
  } catch {
    /* already gone */
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('pane_current_path across delete → recreate (real tmux)', () => {
  it('a deleted-then-recreated start dir stays STALE for the live session, and a healthy one is ok', () => {
    if (!tmuxOk) return
    const dir = path.join(tmp, 'proj')
    fs.mkdirSync(dir)
    // `sleep` rather than an interactive shell: the pane's process-group leader holds the cwd and
    // sits still, so the measurement has no prompt/rc-file noise in it.
    // `-f /dev/null` on the server-starting call: a contributor's ~/.tmux.conf must not join the
    // measurement (the private socket makes this call the one that boots the server).
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'victim', '-c', dir, 'sleep 60'])
    waitForPane('victim')

    // Healthy: tmux names the directory and it exists.
    expect(classifyPaneCwd(panePath('victim'), dirExists)).toBe('ok')

    // Deleted: the shell keeps the inode; the classifier must call it stale.
    fs.rmSync(dir, { recursive: true, force: true })
    const afterDelete = panePath('victim')
    expect(classifyPaneCwd(afterDelete, dirExists)).toBe('stale')

    // Recreated at the same path — a different inode, so nothing self-heals. This is the exact
    // reported state: the folder EXISTS again, and the verdict must still be stale.
    fs.mkdirSync(dir)
    const afterRecreate = panePath('victim')
    expect(dirExists(dir)).toBe(true)
    expect(classifyPaneCwd(afterRecreate, dirExists)).toBe('stale')
    if (process.platform === 'linux') {
      // The measured Linux signal, pinned so a kernel/tmux change that stops emitting it turns
      // this suite red instead of silently disabling the banner: /proc's readlink names the dead
      // inode with the " (deleted)" suffix, before AND after the same-named mkdir.
      expect(afterDelete.endsWith(' (deleted)')).toBe(true)
      expect(afterRecreate.endsWith(' (deleted)')).toBe(true)
    }
  })

  it('a NEW session created after the recreation starts in the recreated directory', () => {
    if (!tmuxOk) return
    const dir = path.join(tmp, 'proj2')
    fs.mkdirSync(dir)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir)
    tmux(['new-session', '-d', '-s', 'fresh', '-c', dir, 'sleep 60'])
    waitForPane('fresh')
    const reported = panePath('fresh')
    expect(classifyPaneCwd(reported, dirExists)).toBe('ok')
    expect(fs.realpathSync(reported)).toBe(fs.realpathSync(dir))
  })
})
