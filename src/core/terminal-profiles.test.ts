import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  listTerminalProfiles,
  parseWslDistroList,
  resolveWslLaunch,
  WSL_CWD_GUARD,
  type ExecResult,
  type ProfileExec
} from './terminal-profiles'

const utf16 = (s: string): Buffer => Buffer.from(s, 'utf16le')
const ok = (stdout: Buffer | string): ExecResult => ({
  code: 0,
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0)
})

describe('parseWslDistroList', () => {
  it('reads the UTF-16LE CRLF output wsl.exe writes and drops Docker Desktop', () => {
    const raw = utf16('docker-desktop\r\nUbuntu\r\nRedHatEnterpriseLinux-9.8\r\n')
    expect(parseWslDistroList(raw)).toEqual(['Ubuntu', 'RedHatEnterpriseLinux-9.8'])
  })

  it('reads UTF-8 output (WSL_UTF8=1), a BOM, and a name with spaces', () => {
    expect(parseWslDistroList(Buffer.from('My Distro\nDebian\n'))).toEqual(['My Distro', 'Debian'])
    expect(parseWslDistroList(utf16('\ufeffUbuntu\r\n'))).toEqual(['Ubuntu'])
  })
})

describe('listTerminalProfiles', () => {
  it('offers nothing on a non-Windows core and never runs wsl.exe there', async () => {
    const exec = vi.fn<ProfileExec>()
    await expect(listTerminalProfiles('linux', exec)).resolves.toEqual([])
    expect(exec).not.toHaveBeenCalled()
  })

  it('lists each distribution as an encoded shell value', async () => {
    const exec: ProfileExec = async () => ok(utf16('Ubuntu\r\nMy Distro\r\n'))
    const rows = await listTerminalProfiles('win32', exec)
    expect(rows.filter((r) => r.kind === 'wsl')).toEqual([
      { value: 'wsl:Ubuntu', label: 'WSL: Ubuntu', kind: 'wsl' },
      { value: 'wsl:My%20Distro', label: 'WSL: My Distro', kind: 'wsl' }
    ])
  })

  it.each<[string, ProfileExec]>([
    ['exits non-zero', async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })],
    ['cannot be started', async () => Promise.reject(new Error('ENOENT'))]
  ])('keeps the Windows rows when wsl.exe %s', async (_name, exec) => {
    const rows = await listTerminalProfiles('win32', exec)
    expect(rows.map((r) => r.kind)).toEqual(['default', 'windows', 'windows', 'windows'])
  })
})

describe('resolveWslLaunch', () => {
  it('translates a Windows directory with the distribution’s own wslpath', async () => {
    const exec = vi.fn<ProfileExec>(async () => ok('/mnt/c/My Project\n'))
    const plan = await resolveWslLaunch('My Distro', 'C:\\My Project', exec)
    expect(exec.mock.calls[0][1]).toEqual([
      '-d',
      'My Distro',
      '--exec',
      'wslpath',
      '-a',
      '-u',
      'C:\\My Project'
    ])
    expect(plan.file.toLowerCase()).toMatch(/^[a-z]:\\windows\\system32\\wsl\.exe$/)
    expect(plan.args).toEqual([
      '-d',
      'My Distro',
      '--exec',
      'sh',
      '-c',
      WSL_CWD_GUARD,
      'nodeterm-wsl',
      '/mnt/c/My Project'
    ])
  })

  it('keeps a Linux path as it is and asks the distribution nothing', async () => {
    const exec = vi.fn<ProfileExec>()
    const plan = await resolveWslLaunch('Ubuntu', '/home/me/app', exec)
    expect(exec).not.toHaveBeenCalled()
    expect(plan.args.at(-1)).toBe('/home/me/app')
  })

  it('leaves the directory to the guard’s $HOME when there is none', async () => {
    const exec = vi.fn<ProfileExec>()
    const plan = await resolveWslLaunch('Ubuntu', undefined, exec)
    expect(exec).not.toHaveBeenCalled()
    expect(plan.args.at(-1)).toBe('nodeterm-wsl')
  })

  it('fails with the real reason when the path cannot be translated', async () => {
    const exec: ProfileExec = async () => ({
      code: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('wslpath: Z:\\nope\n')
    })
    await expect(resolveWslLaunch('Ubuntu', 'Z:\\nope', exec)).rejects.toThrow(
      'WSL could not open "Z:\\nope" in Ubuntu: wslpath: Z:\\nope'
    )
  })
})

describe.skipIf(process.platform === 'win32')('WSL_CWD_GUARD', () => {
  const run = (...args: string[]) =>
    spawnSync('sh', ['-c', WSL_CWD_GUARD, 'nodeterm-wsl', ...args], {
      encoding: 'utf8',
      input: '',
      env: { ...process.env, HOME: os.tmpdir() }
    })

  it('stops with its own exit code when the directory is gone, starting no shell', () => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nt-wsl-guard-')), 'gone')
    try {
      const result = run(missing)
      expect(result.status).toBe(71)
      expect(result.stderr).toContain(path.basename(missing))
    } finally {
      fs.rmSync(path.dirname(missing), { recursive: true, force: true })
    }
  })

  it('execs a login shell inside a directory with spaces', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt wsl guard '))
    try {
      const result = spawnSync('sh', ['-c', WSL_CWD_GUARD, 'nodeterm-wsl', dir], {
        encoding: 'utf8',
        input: 'printf "__CWD=%s\\n" "$PWD"\nexit 0\n',
        env: { ...process.env, HOME: dir }
      })
      expect(result.status).toBe(0)
      const printed = /__CWD=(.*)/.exec(result.stdout)?.[1]
      expect(printed && fs.realpathSync(printed)).toBe(fs.realpathSync(dir))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
