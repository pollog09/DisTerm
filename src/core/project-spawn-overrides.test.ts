// `makeProjectSpawnOverrides` — the ONE decision a spawn asks about a project's settings.
//
// Two rules carry the whole file. (1) A LOCAL value is the user's own typing on this machine and is
// always consumed. (2) A SHARED value arrived through git (or off a remote host) and is consumed
// only while the family's shared-content hash is trusted AT THIS LOCATION — the same verdict
// `project-settings:launch-info` reports, computed by the same helper, so the two can never drift.
// Everything else is fail-open: a spawn must never be blocked, delayed or failed by this reader.
import { describe, it, expect, vi } from 'vitest'
import { makeProjectSpawnOverrides } from './project-spawn-overrides'
import { hashTrustContent, localTrustKey, sshTrustKey } from './project-trust-store'
import { projectTrustContent, type ProjectSettingsSnapshot } from '../shared/project-settings'
import type { ProjectSetupTargetInfo } from './project-setup-runner-local'

const CWD = '/repo/app'
const KEY = localTrustKey(CWD)

function snapshot(
  shared: ProjectSettingsSnapshot['shared'],
  local?: ProjectSettingsSnapshot['local']
): ProjectSettingsSnapshot {
  return { shared, local }
}

function sharedDoc(doc: object): ProjectSettingsSnapshot['shared'] {
  return { version: 1, rev: 1, savedAt: '', ...doc } as ProjectSettingsSnapshot['shared']
}

/** A reader over one project, with a trust store that only knows the hashes it was handed. */
function make(opts: {
  snap?: ProjectSettingsSnapshot | null
  info?: ProjectSetupTargetInfo | null
  trusted?: string[]
  readSettings?: () => Promise<ProjectSettingsSnapshot | null>
  isTrusted?: () => Promise<boolean>
}) {
  const asked: Array<[string, string, string]> = []
  const requested: Array<[string, string]> = []
  const read = makeProjectSpawnOverrides({
    readSettings: opts.readSettings ?? (async () => opts.snap ?? null),
    targetInfo: () => (opts.info === undefined ? { cwd: CWD, name: 'app' } : opts.info),
    trust: {
      isTrusted: async (key, family, hash) => {
        asked.push([key, family, hash])
        if (opts.isTrusted) return opts.isTrusted()
        return (opts.trusted ?? []).includes(hash)
      }
    },
    requestTrust: (projectId, family) => {
      requested.push([projectId, family])
    }
  })
  return { read, asked, requested }
}

describe('makeProjectSpawnOverrides — env', () => {
  it('applies a LOCAL env with no trust question at all', async () => {
    const { read, asked, requested } = make({
      snap: snapshot(null, { agents: { env: { FOO: 'bar' } } })
    })
    expect(await read('p1')).toEqual({ env: { FOO: 'bar' } })
    expect(asked).toEqual([])
    expect(requested).toEqual([])
  })

  it('applies a SHARED env once the agents family is trusted at this location', async () => {
    const doc = { agents: { env: { API: 'k' } } }
    const hash = hashTrustContent(projectTrustContent('agents', doc)!)
    const { read, asked, requested } = make({ snap: snapshot(sharedDoc(doc)), trusted: [hash] })
    expect(await read('p1')).toEqual({ env: { API: 'k' } })
    expect(asked).toEqual([[KEY, 'agents', hash]])
    expect(requested).toEqual([])
  })

  it('OMITS a shared env that is not trusted, and asks for trust exactly once', async () => {
    const doc = { agents: { env: { API: 'k' } } }
    const { read, requested } = make({ snap: snapshot(sharedDoc(doc)), trusted: [] })
    expect(await read('p1')).toBeNull()
    expect(requested).toEqual([['p1', 'agents']])
  })

  it('uses the SSH location key when the project lives on a remote host', async () => {
    const doc = { agents: { env: { API: 'k' } } }
    const hash = hashTrustContent(projectTrustContent('agents', doc)!)
    const ssh = { server: { host: 'h', user: 'u', port: 2222 }, remoteCwd: '/srv/app' }
    const { read, asked } = make({
      snap: snapshot(sharedDoc(doc)),
      info: { name: 'app', ssh },
      trusted: [hash]
    })
    expect(await read('p1')).toEqual({ env: { API: 'k' } })
    expect(asked[0][0]).toBe(sshTrustKey(ssh))
  })

  it('a local env SHADOWS the shared one and is never gated (the resolver already picked it)', async () => {
    const { read, asked } = make({
      snap: snapshot(sharedDoc({ agents: { env: { API: 'shared' } } }), {
        agents: { env: { API: 'mine' } }
      })
    })
    expect(await read('p1')).toEqual({ env: { API: 'mine' } })
    expect(asked).toEqual([])
  })
})

describe('makeProjectSpawnOverrides — shell', () => {
  it('never lets a SHARED file name a WSL distribution, even once trusted', async () => {
    const doc = { terminal: { shell: 'wsl:Ubuntu' } }
    const hash = hashTrustContent(projectTrustContent('shell', doc)!)
    const { read, requested } = make({ snap: snapshot(sharedDoc(doc)), trusted: [hash] })
    expect(await read('p1')).toBeNull()
    expect(requested).toEqual([])
  })

  it('lets this machine’s LOCAL settings name a WSL distribution', async () => {
    const { read } = make({ snap: snapshot(null, { terminal: { shell: 'wsl:Ubuntu' } }) })
    expect(await read('p1')).toEqual({ shell: 'wsl:Ubuntu' })
  })

  it('applies a LOCAL shell with no trust question', async () => {
    const { read, asked } = make({ snap: snapshot(null, { terminal: { shell: '/bin/fish' } }) })
    expect(await read('p1')).toEqual({ shell: '/bin/fish' })
    expect(asked).toEqual([])
  })

  it('applies a SHARED shell once the shell family is trusted', async () => {
    const doc = { terminal: { shell: '/bin/zsh' } }
    const hash = hashTrustContent(projectTrustContent('shell', doc)!)
    const { read } = make({ snap: snapshot(sharedDoc(doc)), trusted: [hash] })
    expect(await read('p1')).toEqual({ shell: '/bin/zsh' })
  })

  it('OMITS an untrusted shared shell and asks for trust', async () => {
    const { read, requested } = make({
      snap: snapshot(sharedDoc({ terminal: { shell: '/bin/zsh' } })),
      trusted: []
    })
    expect(await read('p1')).toBeNull()
    expect(requested).toEqual([['p1', 'shell']])
  })

  it('asks for BOTH families when both are shared and neither is trusted', async () => {
    const { read, requested } = make({
      snap: snapshot(sharedDoc({ agents: { env: { A: '1' } }, terminal: { shell: '/bin/zsh' } })),
      trusted: []
    })
    expect(await read('p1')).toBeNull()
    expect(requested).toEqual([
      ['p1', 'agents'],
      ['p1', 'shell']
    ])
  })
})

describe('makeProjectSpawnOverrides — fail open', () => {
  it('answers null when the project has no settings at all', async () => {
    expect(await make({ snap: null }).read('p1')).toBeNull()
  })

  it('answers null when nothing in the document is a spawn override', async () => {
    const { read } = make({ snap: snapshot(sharedDoc({ setup: { setupScript: 'make' } })) })
    expect(await read('p1')).toBeNull()
  })

  it('answers null (never throws) when the settings read rejects', async () => {
    const { read } = make({
      readSettings: () => Promise.reject(new Error('EIO'))
    })
    await expect(read('p1')).resolves.toBeNull()
  })

  it('treats a trust store that throws as NOT trusted, and still answers', async () => {
    const { read, requested } = make({
      snap: snapshot(sharedDoc({ agents: { env: { A: '1' } } })),
      isTrusted: () => Promise.reject(new Error('EACCES'))
    })
    await expect(read('p1')).resolves.toBeNull()
    expect(requested).toEqual([['p1', 'agents']])
  })

  it('survives a requestTrust that throws — the ask is fire-and-forget', async () => {
    const read = makeProjectSpawnOverrides({
      readSettings: async () => snapshot(sharedDoc({ agents: { env: { A: '1' } } })),
      targetInfo: () => ({ cwd: CWD, name: 'app' }),
      trust: { isTrusted: async () => false },
      requestTrust: () => {
        throw new Error('no window')
      }
    })
    await expect(read('p1')).resolves.toBeNull()
  })

  it('does not wait on requestTrust (a dialog stays open for minutes)', async () => {
    let settle: (() => void) | undefined
    const read = makeProjectSpawnOverrides({
      readSettings: async () => snapshot(sharedDoc({ agents: { env: { A: '1' } } })),
      targetInfo: () => ({ cwd: CWD, name: 'app' }),
      trust: { isTrusted: async () => false },
      requestTrust: () => new Promise<boolean>((r) => (settle = () => r(true)))
    })
    await expect(read('p1')).resolves.toBeNull()
    expect(settle).toBeTypeOf('function')
  })

  it('a cwd-less inline canvas still resolves (no shared doc to gate)', async () => {
    const { read } = make({ snap: snapshot(null, { agents: { env: { A: '1' } } }), info: null })
    expect(await read('p1')).toEqual({ env: { A: '1' } })
  })

  it('registers no requestTrust at all without one wired', async () => {
    const read = makeProjectSpawnOverrides({
      readSettings: async () => snapshot(sharedDoc({ terminal: { shell: '/bin/zsh' } })),
      targetInfo: () => ({ cwd: CWD, name: 'app' }),
      trust: { isTrusted: async () => false }
    })
    await expect(read('p1')).resolves.toBeNull()
  })
})

describe('makeProjectSpawnOverrides — literal values only', () => {
  // `${env:VAR}` expansion is a CUSTOM-AGENT feature (custom-agent-env.ts), deliberately NOT
  // inherited here: a project's settings.json is git-shared hostile input, and expansion would turn
  // an approved-looking literal into a read of this machine's process environment.
  it('passes a ${env:…}-shaped value through verbatim', async () => {
    const { read } = make({
      snap: snapshot(null, { agents: { env: { TOKEN: '${env:ANTHROPIC_API_KEY}' } } })
    })
    expect(await read('p1')).toEqual({ env: { TOKEN: '${env:ANTHROPIC_API_KEY}' } })
  })
})

describe('makeProjectSpawnOverrides — hash rule shared with launch-info', () => {
  it('asks the trust store the SAME (key, family, hash) the launch-info verdict asks', async () => {
    const doc = { agents: { launchCmd: 'claude --yolo', env: { A: '1' } } }
    const { read, asked } = make({ snap: snapshot(sharedDoc(doc)), trusted: [] })
    await read('p1')
    // Hashed from the SHARED document alone, covering launchCmd AND env together.
    expect(asked).toEqual([[KEY, 'agents', hashTrustContent(projectTrustContent('agents', doc)!)]])
  })

  it('never gates a family whose shared half is empty (nothing to approve)', async () => {
    const spy = vi.fn(async () => false)
    const read = makeProjectSpawnOverrides({
      readSettings: async () => snapshot(sharedDoc({}), { agents: { env: { A: '1' } } }),
      targetInfo: () => ({ cwd: CWD, name: 'app' }),
      trust: { isTrusted: spy }
    })
    expect(await read('p1')).toEqual({ env: { A: '1' } })
    expect(spy).not.toHaveBeenCalled()
  })
})
