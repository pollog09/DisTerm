// The Claude CLI inside a distribution. The command runs for real under /bin/sh against a fake home,
// because it is generated shell, and it carries the only proof that markers survive a chatty profile.
import { execFile } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNKNOWN_CLAUDE_CLI_CAPS } from '../shared/types'
import {
  parseWslClaudeProbe,
  resetWslClaudeCliCapsForTest,
  wslClaudeCliCaps,
  wslClaudeProbeCommand,
  type WslClaudeProbeDeps
} from './claude-cli'

const exec = promisify(execFile)

const deps = (over: Partial<WslClaudeProbeDeps> = {}): WslClaudeProbeDeps & { run: ReturnType<typeof vi.fn> } =>
  ({
    run: vi.fn(async () => '__NT_WSL_V_START__2.1.318 (Claude Code)__NT_WSL_V_END____NT_WSL_H_START__  --session-id <uuid>  x__NT_WSL_H_END__'),
    running: async () => ['Ubuntu'],
    ...over
  }) as never

beforeEach(() => resetWslClaudeCliCapsForTest())

describe('parseWslClaudeProbe', () => {
  it('reads version and help between the markers, ignoring what a profile printed', () => {
    const caps = parseWslClaudeProbe(
      'Welcome — Ubuntu 22.04.3 LTS\n__NT_WSL_V_START__2.1.318 (Claude Code)__NT_WSL_V_END____NT_WSL_H_START__ --session-id <uuid> __NT_WSL_H_END__\nbye 9.9.9'
    )
    expect(caps.version).toBe('2.1.318 (Claude Code)')
    expect(caps.autoPermissionMode).toBe(true)
    expect(caps.sessionIdFlag).toBe(true)
  })

  it.each([null, '', 'Welcome — Ubuntu 22.04.3 LTS', '__NT_WSL_V_START____NT_WSL_V_END__'])(
    'answers the unknown for %j, never a modern CLI',
    (out) => {
      expect(parseWslClaudeProbe(out)).toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
    }
  )
})

describe('wslClaudeCliCaps', () => {
  it('asks nothing off Windows', async () => {
    const d = deps()
    await expect(wslClaudeCliCaps('wsl:Ubuntu', {}, d, 'linux')).resolves.toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
    expect(d.run).not.toHaveBeenCalled()
  })

  it.each(['wsl:-d', 'pwsh', '', 42, undefined])('refuses %j before running anything', async (shell) => {
    const d = deps()
    await expect(wslClaudeCliCaps(shell, {}, d, 'win32')).resolves.toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
    expect(d.run).not.toHaveBeenCalled()
  })

  it('does not boot a stopped distribution when asked only if running', async () => {
    const d = deps({ running: async () => ['Debian'] })
    await expect(wslClaudeCliCaps('wsl:Ubuntu', { ifRunning: true }, d, 'win32')).resolves.toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
    expect(d.run).not.toHaveBeenCalled()
  })

  it('treats WSL not answering as not running', async () => {
    const d = deps({ running: async () => null })
    await wslClaudeCliCaps('wsl:Ubuntu', { ifRunning: true }, d, 'win32')
    expect(d.run).not.toHaveBeenCalled()
  })

  it('remembers a found CLI, per distribution', async () => {
    const d = deps()
    await wslClaudeCliCaps('wsl:Ubuntu', {}, d, 'win32')
    await wslClaudeCliCaps('wsl:Ubuntu', {}, d, 'win32')
    expect(d.run).toHaveBeenCalledTimes(1)
    await wslClaudeCliCaps('wsl:Debian', {}, d, 'win32')
    expect(d.run).toHaveBeenCalledTimes(2)
  })

  it('does not remember a miss: the distribution may not have been up', async () => {
    const d = deps({ run: vi.fn(async () => null) as never })
    await wslClaudeCliCaps('wsl:Ubuntu', {}, d, 'win32')
    await wslClaudeCliCaps('wsl:Ubuntu', {}, d, 'win32')
    expect(d.run).toHaveBeenCalledTimes(2)
  })

  it('runs one probe for many callers at once, as a cold restore of a whole canvas is', async () => {
    const d = deps()
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => wslClaudeCliCaps('wsl:Ubuntu', {}, d, 'win32'))
    )
    expect(d.run).toHaveBeenCalledTimes(1)
    expect(answers.every((c) => c.version === '2.1.318 (Claude Code)')).toBe(true)
  })

  it('does not let a must-not-boot ask answer one that may boot', async () => {
    const d = deps({ running: async () => [] })
    const [quiet, booting] = await Promise.all([
      wslClaudeCliCaps('wsl:Ubuntu', { ifRunning: true }, d, 'win32'),
      wslClaudeCliCaps('wsl:Ubuntu', {}, d, 'win32')
    ])
    expect(quiet.version).toBeNull()
    expect(booting.version).toBe('2.1.318 (Claude Code)')
  })

  it('asks again after a miss has settled', async () => {
    const d = deps({ run: vi.fn(async () => null) as never })
    await Promise.all([wslClaudeCliCaps('wsl:Ubuntu', {}, d, 'win32'), wslClaudeCliCaps('wsl:Ubuntu', {}, d, 'win32')])
    expect(d.run).toHaveBeenCalledTimes(1)
    await wslClaudeCliCaps('wsl:Ubuntu', {}, d, 'win32')
    expect(d.run).toHaveBeenCalledTimes(2)
  })

  it('never rejects', async () => {
    const d = deps({ run: vi.fn(async () => { throw new Error('boom') }) as never })
    await expect(wslClaudeCliCaps('wsl:Ubuntu', {}, d, 'win32')).resolves.toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
  })
})

describe.skipIf(process.platform === 'win32')('wslClaudeProbeCommand under a real shell', () => {
  let home = ''
  beforeEach(() => {
    home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'wsl-claude-'))
    mkdirSync(join(home, '.local/bin'), { recursive: true })
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const fakeClaude = (body: string): void => {
    const file = join(home, '.local/bin/claude')
    writeFileSync(file, `#!/bin/sh\n${body}\n`)
    chmodSync(file, 0o755)
  }
  const probe = async (): Promise<string> =>
    (
      await exec('/bin/sh', ['-c', wslClaudeProbeCommand()], {
        env: { PATH: '/usr/bin:/bin', HOME: home }
      })
    ).stdout

  it('finds a Claude in ~/.local/bin, which a login profile may not add to PATH', async () => {
    fakeClaude('case "$1" in --version) echo "2.1.318 (Claude Code)";; --help) echo "  --session-id <uuid>";; esac')
    const caps = parseWslClaudeProbe(await probe())
    expect(caps.version).toBe('2.1.318 (Claude Code)')
    expect(caps.sessionIdFlag).toBe(true)
  })

  it('falls through to sh when the login shell cannot read the body, like fish', async () => {
    fakeClaude('case "$1" in --version) echo "2.1.318 (Claude Code)";; --help) echo "  --session-id <uuid>";; esac')
    const fish = join(home, 'fish')
    writeFileSync(fish, '#!/bin/sh\necho "fish: Unsupported use of =" >&2\nexit 127\n')
    chmodSync(fish, 0o755)
    const shim = join(home, 'shim')
    mkdirSync(shim)
    writeFileSync(join(shim, 'getent'), `#!/bin/sh\necho "me:x:1000:1000::${home}:${fish}"\n`)
    chmodSync(join(shim, 'getent'), 0o755)
    const { stdout } = await exec('/bin/sh', ['-c', wslClaudeProbeCommand()], {
      env: { PATH: `${shim}:/usr/bin:/bin`, HOME: home }
    })
    expect(parseWslClaudeProbe(stdout).version).toBe('2.1.318 (Claude Code)')
  })

  it('answers the unknown with no Claude installed', async () => {
    const out = await probe().catch(() => '')
    expect(parseWslClaudeProbe(out)).toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
  })
})
