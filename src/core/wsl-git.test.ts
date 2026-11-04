import { describe, expect, it } from 'vitest'
import { gitReadFailure, localGitCommand, wslRepoRef } from './wsl-git'

const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

describe('wslRepoRef', () => {
  it.each([
    [UNC, 'Ubuntu', '/home/me/repo', '//wsl.localhost/Ubuntu'],
    ['//wsl.localhost/Ubuntu/home/me/repo', 'Ubuntu', '/home/me/repo', '//wsl.localhost/Ubuntu'],
    ['\\\\wsl$\\Debian\\srv', 'Debian', '/srv', '//wsl$/Debian'],
    ['\\\\WSL.LOCALHOST\\Ubuntu-22.04', 'Ubuntu-22.04', '/', '//WSL.LOCALHOST/Ubuntu-22.04']
  ])('reads %s', (cwd, distro, linuxPath, windowsRoot) => {
    expect(wslRepoRef(cwd, 'win32')).toEqual({ distro, linuxPath, windowsRoot })
  })

  it.each(['C:\\repo', '/home/me/repo', '\\\\server\\share\\repo', '\\\\wsl.localhost\\-rf\\x'])(
    'is not a WSL repository: %s',
    (cwd) => expect(wslRepoRef(cwd, 'win32')).toBeNull()
  )

  it('applies only on a Windows core', () => {
    expect(wslRepoRef(UNC, 'linux')).toBeNull()
  })
})

describe('localGitCommand', () => {
  it('leaves every other path as a plain local git', () => {
    const cmd = localGitCommand('/repo', ['status'], { maxBuffer: 1 }, 'linux')
    expect(cmd).toMatchObject({ file: 'git', args: ['status'], options: { cwd: '/repo', maxBuffer: 1 } })
    expect(cmd.mapOutput('a')).toBe('a')
  })

  it('runs inside the distribution, with no UNC working directory', () => {
    const cmd = localGitCommand(UNC, ['status'], { env: { GIT_TERMINAL_PROMPT: '0' } }, 'win32')
    expect(cmd.file).toMatch(/wsl\.exe$/)
    expect(cmd.args).toEqual(['-d', 'Ubuntu', '--exec', 'git', '-C', '/home/me/repo', 'status'])
    expect(cmd.options.cwd).toBeUndefined()
    expect(cmd.options.windowsHide).toBe(true)
  })

  it('forwards the no-prompt variable, keeping any WSLENV already set', () => {
    const bare = localGitCommand(UNC, ['push'], { env: {} }, 'win32')
    expect(bare.options.env?.WSLENV).toBe('GIT_TERMINAL_PROMPT')
    const kept = localGitCommand(UNC, ['push'], { env: { WSLENV: 'A/u' } }, 'win32')
    expect(kept.options.env?.WSLENV).toBe('A/u:GIT_TERMINAL_PROMPT')
  })

  it('translates a path argument in the same distribution only', () => {
    const add = localGitCommand(
      UNC,
      ['worktree', 'add', '//wsl.localhost/Ubuntu/home/me/wt', 'branch', '\\\\wsl$\\Debian\\x'],
      {},
      'win32'
    )
    expect(add.args.slice(6)).toEqual(['worktree', 'add', '/home/me/wt', 'branch', '\\\\wsl$\\Debian\\x'])
  })

  it('maps the repository root back to a path Windows can open', () => {
    const cmd = localGitCommand(UNC, ['rev-parse', '--show-toplevel'], {}, 'win32')
    expect(cmd.mapOutput('/home/me/repo')).toBe('//wsl.localhost/Ubuntu/home/me/repo')
  })

  it('maps only the path lines of a worktree listing', () => {
    const cmd = localGitCommand(UNC, ['worktree', 'list', '--porcelain'], {}, 'win32')
    expect(cmd.mapOutput('worktree /home/me/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/me/wt')).toBe(
      'worktree //wsl.localhost/Ubuntu/home/me/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree //wsl.localhost/Ubuntu/home/me/wt'
    )
  })

  it('does not rewrite output of commands that do not print absolute paths', () => {
    const cmd = localGitCommand(UNC, ['log'], {}, 'win32')
    expect(cmd.mapOutput('worktree /home/me/repo')).toBe('worktree /home/me/repo')
  })
})

describe('gitReadFailure', () => {
  it('reads a folder with no repository as an answer, in any language', () => {
    expect(gitReadFailure('fatal: not a git repository (or any of the parent directories): .git')).toBeNull()
    expect(gitReadFailure('fatal: no es un repositorio git')).toBeNull()
    expect(gitReadFailure('')).toBeNull()
  })

  it('reports a refused folder, which does not say a repository is absent', () => {
    const err = "fatal: detected dubious ownership in repository at '/x'\n\tgit config --global --add safe.directory /x"
    expect(gitReadFailure(err)).toBe(err)
  })

  it('reports git never getting to answer', () => {
    expect(gitReadFailure('spawn git ENOENT')).toBe('spawn git ENOENT')
    expect(gitReadFailure('ssh: connect to host h port 22: Connection refused')).toContain('ssh')
  })
})
