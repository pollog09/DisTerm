import { execFile } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentSockToPin,
  clearAgentProbeCache,
  parseIdentityAgent,
  probeAgentSockToPin,
  probeArgs
} from './agent-probe'
import type { SshConnection } from '../../shared/ssh'

const conn: SshConnection = { host: 'h.example.com', user: 'deploy', port: 2222 }
const AMBIENT = '/tmp/launchd.abc/Listeners'

beforeEach(() => clearAgentProbeCache())

describe('parseIdentityAgent', () => {
  // Every shape below was measured against a real `ssh -G` (OpenSSH 9.6) — see agent-probe.ts.
  it('reads the identityagent line verbatim', () => {
    expect(parseIdentityAgent('user deploy\nidentityagent SSH_AUTH_SOCK\nport 22\n')).toBe(
      'SSH_AUTH_SOCK'
    )
    expect(parseIdentityAgent('identityagent $MYVAR\n')).toBe('$MYVAR')
    expect(parseIdentityAgent('identityagent /tmp/some.sock\n')).toBe('/tmp/some.sock')
    expect(parseIdentityAgent('identityagent none\n')).toBe('none')
  })
  it('returns undefined when the line is absent (OpenSSH omits it when unset — measured)', () => {
    expect(parseIdentityAgent('user deploy\nhostname h\nport 22\n')).toBeUndefined()
  })
  it('does not match a value that merely CONTAINS the word (e.g. a banner line)', () => {
    expect(parseIdentityAgent('remotecommand echo identityagent SSH_AUTH_SOCK\n')).toBeUndefined()
  })
})

describe('agentSockToPin', () => {
  it('pins for the env-reference spellings — the shapes the app-agent env override breaks', () => {
    // `IdentityAgent SSH_AUTH_SOCK` and `$SSH_AUTH_SOCK` are connect-time env reads; under our
    // SSH_AUTH_SOCK override they resolve to the app-private agent instead of the login agent.
    expect(agentSockToPin('SSH_AUTH_SOCK', AMBIENT)).toBe(AMBIENT)
    expect(agentSockToPin('$SSH_AUTH_SOCK', AMBIENT)).toBe(AMBIENT)
  })
  it('pins when the resolved value equals the ambient socket (the ${SSH_AUTH_SOCK} parse-time form)', () => {
    // `${SSH_AUTH_SOCK}` expands at config-PARSE time, so the probe (run with the ambient env)
    // sees the ambient path itself. Pinning an identical literal is also a no-op, so equality is
    // safe for both readings.
    expect(agentSockToPin(AMBIENT, AMBIENT)).toBe(AMBIENT)
  })
  it('leaves everything else alone: none, unrelated literal, other env vars, absent line', () => {
    expect(agentSockToPin('none', AMBIENT)).toBeUndefined()
    expect(agentSockToPin('/tmp/other.sock', AMBIENT)).toBeUndefined()
    // `$MYVAR` reads a variable we never touch — the child inherits it correctly already.
    expect(agentSockToPin('$MYVAR', AMBIENT)).toBeUndefined()
    expect(agentSockToPin(undefined, AMBIENT)).toBeUndefined()
  })
  it('never pins without an ambient socket, or an ambient value unsafe as one -o token', () => {
    expect(agentSockToPin('SSH_AUTH_SOCK', undefined)).toBeUndefined()
    expect(agentSockToPin('SSH_AUTH_SOCK', '')).toBeUndefined()
    // ssh tokenizes the -o value with its config parser: whitespace would split it. A relative
    // path is no login-agent socket. Fail open (no pin) rather than emit a broken option.
    expect(agentSockToPin('SSH_AUTH_SOCK', '/tmp/has space/agent.sock')).toBeUndefined()
    expect(agentSockToPin('SSH_AUTH_SOCK', 'relative/agent.sock')).toBeUndefined()
  })
})

describe('probeArgs', () => {
  it('mirrors the master argv facts: -G + port + identity file + destination, no extraArgs', () => {
    expect(probeArgs({ ...conn, identityFile: '/k/id' })).toEqual([
      '-G',
      '-p',
      '2222',
      '-i',
      '/k/id',
      'deploy@h.example.com'
    ])
    expect(probeArgs(conn)).toEqual(['-G', '-p', '2222', 'deploy@h.example.com'])
  })
})

describe('probeAgentSockToPin', () => {
  it('never asks ssh about a WSL host, and pins nothing for it', async () => {
    const run = vi.fn(async () => 'identityagent SSH_AUTH_SOCK\n')
    const wsl = { ...conn, host: 'ubuntu-0123456789abcdef.wsl.nodeterm.invalid' }
    expect(await probeAgentSockToPin(wsl, { run, env: { SSH_AUTH_SOCK: AMBIENT } })).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })

  it('answers from the injected runner and memoizes per endpoint', async () => {
    let calls = 0
    const run = async (): Promise<string> => {
      calls++
      return 'identityagent SSH_AUTH_SOCK\n'
    }
    const env = { SSH_AUTH_SOCK: AMBIENT }
    expect(await probeAgentSockToPin(conn, { run, env })).toBe(AMBIENT)
    expect(await probeAgentSockToPin(conn, { run, env })).toBe(AMBIENT)
    expect(calls).toBe(1)
    // A different endpoint probes on its own.
    expect(await probeAgentSockToPin({ ...conn, host: 'other' }, { run, env })).toBe(AMBIENT)
    expect(calls).toBe(2)
  })
  it('skips the subprocess entirely when there is no ambient agent', async () => {
    let calls = 0
    const run = async (): Promise<string> => {
      calls++
      return 'identityagent SSH_AUTH_SOCK\n'
    }
    expect(await probeAgentSockToPin(conn, { run, env: {} })).toBeUndefined()
    expect(calls).toBe(0)
  })
  it('a failed probe answers undefined — the pre-#427 command line, never a blocked connect', async () => {
    const run = async (): Promise<string> => {
      throw new Error('ssh -G blew up')
    }
    await expect(
      probeAgentSockToPin(conn, { run, env: { SSH_AUTH_SOCK: AMBIENT } })
    ).resolves.toBeUndefined()
  })
  it('re-probes after the TTL so a config fix lands on the next reconnect', async () => {
    let calls = 0
    let t = 0
    const run = async (): Promise<string> => {
      calls++
      return 'identityagent SSH_AUTH_SOCK\n'
    }
    const deps = { run, env: { SSH_AUTH_SOCK: AMBIENT }, now: () => t }
    await probeAgentSockToPin(conn, deps)
    t = 20_000
    await probeAgentSockToPin(conn, deps)
    expect(calls).toBe(2)
  })
})

// The probe's real substrate is `ssh -G` output, and the -G dialect is OpenSSH's, not ours — so
// run the REAL binary against a fixture config (same discipline as remote-claude-usage.test.ts
// running its generated sh for real). `-F` pins the config; ssh resolves ~/.ssh/config off
// pw_dir, so HOME games would not isolate it.
const realSsh = ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh'].find((p) =>
  existsSync(p)
)
describe.skipIf(!realSsh || process.platform === 'win32')('probe against a real ssh -G', () => {
  let dir: string
  let cfg: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nt-agent-probe-'))
    cfg = path.join(dir, 'cfg')
    writeFileSync(
      cfg,
      [
        'Host env-form',
        '  IdentityAgent SSH_AUTH_SOCK',
        'Host literal-form',
        '  IdentityAgent /tmp/some.sock',
        'Host plain',
        ''
      ].join('\n')
    )
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const runReal =
    (env: NodeJS.ProcessEnv) =>
    (args: string[]): Promise<string> =>
      new Promise((resolve, reject) => {
        // Splice the fixture config right after -G; the rest of the argv is the production shape.
        execFile(
          realSsh!,
          [args[0], '-F', cfg, ...args.slice(1)],
          { timeout: 5000, env },
          (err, stdout) => (err ? reject(err) : resolve(stdout ?? ''))
        )
      })

  it('pins a host whose config says IdentityAgent SSH_AUTH_SOCK, and only that host', async () => {
    const env = { ...process.env, SSH_AUTH_SOCK: AMBIENT }
    const probe = (host: string): Promise<string | undefined> =>
      probeAgentSockToPin({ host, user: 'u' }, { run: runReal(env), env })
    expect(await probe('env-form')).toBe(AMBIENT)
    expect(await probe('literal-form')).toBeUndefined()
    expect(await probe('plain')).toBeUndefined()
  })
})
