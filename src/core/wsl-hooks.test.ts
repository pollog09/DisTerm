// @vitest-environment node
import { execFile, spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Settings } from '../shared/types'
import { buildManagedScript } from './agents/hooks/managed-script'
import type { SettingsRunner } from './agents/hooks/remote-settings-file'
import { testTmpDir } from './test-tmp'
import { ensureWslHooks, ensureWslHooksBounded, resetWslHooksForTest, wslHookEnv } from './wsl-hooks'

const enabled = { agentIntegrations: { agents: { claude: 'enabled' }, origin: 'asked' } } as unknown as Settings
const declined = { agentIntegrations: { agents: { claude: 'declined' }, origin: 'asked' } } as unknown as Settings
const unanswered = {} as Settings

/** The generated commands under a real /bin/sh, against a sandbox home standing in for the distro. */
function shellRunner(home: string): SettingsRunner {
  return (command, stdin) =>
    new Promise((resolve) => {
      const child = execFile('/bin/sh', ['-c', command], { env: { PATH: process.env.PATH, HOME: home } }, (err, stdout) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout })
      )
      child.stdin?.on('error', () => {})
      child.stdin?.end(stdin ?? '')
    })
}

describe('wslHookEnv', () => {
  const hookEnv = {
    NODETERM_NODE_ID: 'n1',
    NODETERM_HOOK_VERSION: '2',
    NODETERM_HOOK_ENDPOINT: 'C:\\data\\hook-endpoint.env',
    NODETERM_PERM_WAIT_SECS: '45',
    NODETERM_CANVAS_CONTROL: '1'
  }

  it('forwards the hook identity with paths converted, and nothing that cannot work in the distro', () => {
    const out = wslHookEnv(hookEnv, { SystemRoot: 'D:\\Windows' })
    expect(out.NODETERM_WSL_CURL).toBe('D:\\Windows\\System32\\curl.exe')
    const entries = out.WSLENV.split(':')
    expect(entries).toEqual(
      expect.arrayContaining(['NODETERM_NODE_ID', 'NODETERM_HOOK_VERSION', 'NODETERM_HOOK_ENDPOINT/p', 'NODETERM_WSL_CURL/p'])
    )
    expect(out.WSLENV).not.toMatch(/PERM_WAIT|CANVAS_CONTROL/)
  })

  it("keeps the user's own WSLENV and replaces only a name it forwards", () => {
    const out = wslHookEnv(hookEnv, { WSLENV: 'GOPATH/l:NODETERM_HOOK_ENDPOINT:FOO' })
    const entries = out.WSLENV.split(':')
    expect(entries).toEqual(expect.arrayContaining(['GOPATH/l', 'FOO', 'NODETERM_HOOK_ENDPOINT/p']))
    expect(entries).not.toContain('NODETERM_HOOK_ENDPOINT')
  })

  it('adds nothing to a session with no hook identity', () => {
    expect(wslHookEnv({}, { WSLENV: 'FOO' })).toEqual({})
  })
})

describe('ensureWslHooks (real sh)', () => {
  function distro(withClaude = true): { home: string; config: string; script: string; run: SettingsRunner } {
    const home = testTmpDir('nt-wslhooks-')
    if (withClaude) mkdirSync(path.join(home, '.claude'))
    return {
      home,
      config: path.join(home, '.claude', 'settings.json'),
      script: path.join(home, '.nodeterm', 'agent-hooks', 'claude.sh'),
      run: shellRunner(home)
    }
  }

  it('installs the script and merges beside the hooks the user already has', async () => {
    const d = distro()
    writeFileSync(d.config, JSON.stringify({ hooks: { SubagentStop: [{ matcher: 'x', hooks: [{ type: 'command', command: 'mine.sh' }] }] }, theme: 'dark' }))
    expect(await ensureWslHooks(enabled, d.run)).toBe('installed')
    expect(readFileSync(d.script, 'utf8')).toBe(buildManagedScript('claude', null))
    const cfg = JSON.parse(readFileSync(d.config, 'utf8'))
    expect(cfg.theme).toBe('dark')
    expect(JSON.stringify(cfg.hooks.SubagentStop)).toContain('mine.sh')
    expect(JSON.stringify(cfg.hooks.SubagentStop)).toContain('agent-hooks/claude.sh')
    expect(JSON.stringify(cfg.hooks.SessionStart)).toContain('agent-hooks/claude.sh')
  })

  it('installing twice leaves one entry per event', async () => {
    const d = distro()
    await ensureWslHooks(enabled, d.run)
    await ensureWslHooks(enabled, d.run)
    const cfg = JSON.parse(readFileSync(d.config, 'utf8'))
    expect(cfg.hooks.SessionStart).toHaveLength(1)
  })

  it('does not create a Claude config directory in a distro that has never run Claude', async () => {
    const d = distro(false)
    expect(await ensureWslHooks(enabled, d.run)).toBe('skipped')
    expect(existsSync(path.join(d.home, '.claude'))).toBe(false)
    expect(existsSync(d.script)).toBe(false)
  })

  it('a decline removes what we wrote and keeps what is the user\'s', async () => {
    const d = distro()
    writeFileSync(d.config, JSON.stringify({ hooks: { SubagentStop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } }))
    await ensureWslHooks(enabled, d.run)
    expect(await ensureWslHooks(declined, d.run)).toBe('removed')
    expect(existsSync(d.script)).toBe(false)
    const text = readFileSync(d.config, 'utf8')
    expect(text).toContain('mine.sh')
    expect(text).not.toContain('agent-hooks/claude.sh')
  })

  it('an unanswered machine touches nothing, not even to look', async () => {
    let calls = 0
    const run: SettingsRunner = async () => {
      calls++
      return { code: 0, stdout: '' }
    }
    expect(await ensureWslHooks(unanswered, run)).toBe('skipped')
    expect(calls).toBe(0)
  })

  it('leaves a settings file it cannot parse alone', async () => {
    const d = distro()
    writeFileSync(d.config, '{ not json')
    expect(await ensureWslHooks(enabled, d.run)).toBe('failed')
    expect(readFileSync(d.config, 'utf8')).toBe('{ not json')
  })

  it('refuses a home it cannot trust', async () => {
    expect(await ensureWslHooks(enabled, async () => ({ code: 0, stdout: '/tmp/$(id)' }))).toBe('failed')
  })
})

describe('ensureWslHooksBounded', () => {
  beforeEach(() => resetWslHooksForTest())

  it('opens the terminal when the distro is stuck, and never throws', async () => {
    const stuck: SettingsRunner = () => new Promise(() => {})
    await expect(ensureWslHooksBounded('Stuck', enabled, () => stuck, 5)).resolves.toBeUndefined()
    const broken: SettingsRunner = async () => {
      throw new Error('wsl.exe missing')
    }
    await expect(ensureWslHooksBounded('Broken', enabled, () => broken, 50)).resolves.toBeUndefined()
  })

  it('does the work once per answer, and again when the answer changes or it failed', async () => {
    const home = testTmpDir('nt-wslhooks-')
    mkdirSync(path.join(home, '.claude'))
    let runners = 0
    const make = (): SettingsRunner => {
      runners++
      return shellRunner(home)
    }
    await ensureWslHooksBounded('U', enabled, make, 10_000)
    await ensureWslHooksBounded('U', enabled, make, 10_000)
    expect(runners).toBe(1)
    await ensureWslHooksBounded('U', declined, make, 10_000)
    expect(runners).toBe(2)
    let failing = 0
    const failed = (): SettingsRunner => {
      failing++
      return async () => ({ code: 1, stdout: '' })
    }
    await ensureWslHooksBounded('V', enabled, failed, 10_000)
    await ensureWslHooksBounded('V', enabled, failed, 10_000)
    expect(failing).toBe(2)
  })
})

describe.skipIf(process.platform === 'win32')('the hook script in a WSL pane (real sh, recording curl.exe)', () => {
  /** A fake curl.exe and wslpath, and an endpoint file, so the REAL generated script runs. */
  function pane() {
    const root = testTmpDir('nt-wslscript-')
    const bin = path.join(root, 'bin')
    const win = path.join(root, 'mnt', 'c', 'Windows', 'System32')
    mkdirSync(bin, { recursive: true })
    mkdirSync(win, { recursive: true })
    const argvLog = path.join(root, 'argv.log')
    const stdinLog = path.join(root, 'stdin.log')
    const fake = (log: string) =>
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${log}'\ncat >> '${stdinLog}'\nprintf 200\n`
    const curlExe = path.join(win, 'curl.exe')
    writeFileSync(curlExe, fake(argvLog))
    chmodSync(curlExe, 0o755)
    const linuxCurlLog = path.join(root, 'linux-curl.log')
    writeFileSync(path.join(bin, 'curl'), fake(linuxCurlLog))
    chmodSync(path.join(bin, 'curl'), 0o755)
    writeFileSync(path.join(bin, 'wslpath'), `#!/bin/sh\nprintf '\\\\\\\\wsl.localhost\\\\Ubuntu%s' "$2"\n`)
    chmodSync(path.join(bin, 'wslpath'), 0o755)
    const endpoint = path.join(root, 'hook-endpoint.env')
    writeFileSync(endpoint, "NODETERM_HOOK_PORT='57923'\nNODETERM_HOOK_TOKEN='sekret-bearer'\nNODETERM_HOOK_VERSION='2'\n")
    const scriptFile = path.join(root, 'claude.sh')
    writeFileSync(scriptFile, buildManagedScript('claude', null))
    const run = (env: Record<string, string>) =>
      spawnSync('/bin/sh', [scriptFile], {
        input: '{"hook_event_name":"Stop","session_id":"s1"}',
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, NODETERM_NODE_ID: 'n1', NODETERM_HOOK_ENDPOINT: endpoint, ...env }
      })
    return { root, curlExe, argvLog, stdinLog, linuxCurlLog, run }
  }
  const waitFor = async (file: string): Promise<string> => {
    for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setTimeout(r, 50))
    return readFileSync(file, 'utf8')
  }

  it('posts through curl.exe with paths it can open, and the bearer off the command line', async () => {
    const p = pane()
    expect(p.run({ NODETERM_WSL_CURL: p.curlExe }).status).toBe(0)
    const argv = await waitFor(p.argvLog)
    expect(argv).toContain('http://127.0.0.1:57923/hook/claude')
    expect(argv).toContain('NUL')
    expect(argv).not.toContain('/dev/null')
    expect(argv).toMatch(/payload@\\\\wsl\.localhost\\Ubuntu\/.*payload-\d+\.tmp/)
    expect(argv).toContain('nodeId=n1')
    expect(argv).not.toContain('sekret-bearer')
    expect(readFileSync(p.stdinLog, 'utf8')).toContain('sekret-bearer')
    expect(existsSync(p.linuxCurlLog)).toBe(false)
  })

  it('every other session runs the curl it always ran', async () => {
    const p = pane()
    expect(p.run({}).status).toBe(0)
    const argv = await waitFor(p.linuxCurlLog)
    expect(argv).toContain('/dev/null')
    expect(argv).toMatch(/payload@\/.*payload-\d+\.tmp/)
    expect(existsSync(p.argvLog)).toBe(false)
  })

  it('ignores a value that does not name curl.exe', async () => {
    const p = pane()
    const evil = path.join(p.root, 'evil')
    writeFileSync(evil, `#!/bin/sh\ntouch '${evil}.ran'\n`)
    chmodSync(evil, 0o755)
    p.run({ NODETERM_WSL_CURL: evil })
    await waitFor(p.linuxCurlLog)
    expect(existsSync(`${evil}.ran`)).toBe(false)
  })
})
