import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testTmpDir } from '../test-tmp'
import {
  buildShipConfig,
  mergeAgents,
  newShipScriptNonce,
  MCP_FILE_MAX_BYTES,
  reduceMcpFile,
  parseAgentFile,
  parseMcpServers,
  parseRemoteShipOutput,
  readLocalShipInput,
  remoteShipScript,
  type RawShipInput
} from './discover'

const agentFile = (name: string, description = `the ${name}`): string =>
  `---\nname: ${name}\ndescription: ${description}\ntools: Read, Edit, Bash\nmodel: inherit\ncolor: blue\n---\n\nBody text.\n`

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const PATHS = { machine: { kind: 'local' as const, label: '' }, projectGraphPath: '/p/.claude/ship-graph.json', globalGraphPath: '/g/ship-graph.json' }

describe('parseAgentFile', () => {
  it('reads the frontmatter a real agent file has', () => {
    expect(parseAgentFile('implementer.md', agentFile('implementer'), 'global')).toEqual({
      name: 'implementer',
      fileName: 'implementer.md',
      description: 'the implementer',
      model: 'inherit',
      color: 'blue',
      tools: ['Read', 'Edit', 'Bash'],
      scope: 'global'
    })
  })

  it('falls back to the filename, and a file that is not an agent yields no secrets', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n'
    expect(parseAgentFile('stolen.md', key, 'project')).toEqual({ name: 'stolen', fileName: 'stolen.md', scope: 'project' })
  })

  it('keeps the file it came from only as a bare .md leaf, the one thing the model picker resolves', () => {
    const text = agentFile('a')
    expect(parseAgentFile('a.md', text, 'global')?.fileName).toBe('a.md')
    for (const bad of ['../a.md', 'x/a.md', '.hidden.md', 'a.txt', 'a.md\nb.md']) {
      expect(parseAgentFile(bad, text, 'global')?.fileName, bad).toBeUndefined()
    }
  })

  it('drops a colour Claude Code does not have, and a name that is not a name', () => {
    expect(parseAgentFile('a.md', '---\nname: a\ncolor: url(javascript:x)\n---\n', 'global')!.color).toBeUndefined()
    expect(parseAgentFile('$(x).md', '---\nname: $(rm -rf ~)\n---\n', 'global')).toBeNull()
  })

  it('keeps a description to one bounded line', () => {
    const a = parseAgentFile('a.md', `---\nname: a\ndescription: ${'x'.repeat(2000)}\u001b[31m\n---\n`, 'global')!
    expect(a.description!.length).toBeLessThanOrEqual(280)
    expect(a.description).not.toContain('\u001b')
  })
})

describe('mergeAgents', () => {
  it('a project agent wins over the global one by name, and says so', () => {
    const merged = mergeAgents(
      [{ name: 'impl', scope: 'global', description: 'global' }, { name: 'docs', scope: 'global' }],
      [{ name: 'impl', scope: 'project', description: 'project' }, { name: 'extra', scope: 'project' }]
    )
    expect(merged.map((a) => a.name)).toEqual(['docs', 'extra', 'impl'])
    expect(merged.find((a) => a.name === 'impl')).toMatchObject({ description: 'project', scope: 'project', overridesGlobal: true })
    expect(merged.find((a) => a.name === 'extra')!.overridesGlobal).toBeUndefined()
  })
})

describe('buildShipConfig', () => {
  const scope = (over: Partial<RawShipInput['global']> = {}): RawShipInput['global'] => ({ agents: [], commands: [], workflows: [], skills: [], graph: null, ...over })
  const good = (id: string): string => JSON.stringify({ pipelines: [{ id, stages: [{ id: 's', agent: 'a' }] }] })

  it('no file means no pipelines and no source: observation only', () => {
    const c = buildShipConfig({ global: scope(), project: scope(), truncated: [] }, PATHS)
    expect(c).toMatchObject({ pipelines: [], graphSource: null, projectGraphExists: false, globalGraphExists: false })
  })

  it('the project file overrides the global one whole', () => {
    const c = buildShipConfig({ global: scope({ graph: good('g') }), project: scope({ graph: good('p') }), truncated: [] }, PATHS)
    expect(c.graphSource).toBe('project')
    expect(c.pipelines.map((p) => p.id)).toEqual(['p'])
    expect(c.globalGraphExists).toBe(true)
  })

  it('a malformed project file warns and falls back; it does not crash or read as no process', () => {
    const c = buildShipConfig({ global: scope({ graph: good('g') }), project: scope({ graph: '{oops' }), truncated: [] }, PATHS)
    expect(c.graphSource).toBe('global')
    expect(c.pipelines.map((p) => p.id)).toEqual(['g'])
    expect(c.warnings[0]).toMatch(/^Project ship-graph\.json: not valid JSON/)
    expect(c.projectGraphExists).toBe(true) // the row offers Open, not a Create that would refuse
  })

  it('malformed everywhere is no pipelines and two warnings', () => {
    const c = buildShipConfig({ global: scope({ graph: 'x' }), project: scope({ graph: 'y' }), truncated: [] }, PATHS)
    expect(c.pipelines).toEqual([])
    expect(c.graphSource).toBeNull()
    expect(c.warnings).toHaveLength(2)
  })

  it('names are merged across both scopes without extensions', () => {
    const c = buildShipConfig({
      global: scope({ commands: ['ship-change.md'], workflows: ['review.js'], skills: ['grill'] }),
      project: scope({ commands: ['ship-change.md', 'other.md'] }),
      truncated: ['cut']
    }, PATHS)
    expect(c.commands).toEqual(['other', 'ship-change'])
    expect(c.workflows).toEqual(['review'])
    expect(c.skills).toEqual(['grill'])
    expect(c.warnings).toContain('cut')
  })
})

describe('readLocalShipInput', () => {
  function machine(): { home: string; project: string; kit: string } {
    const root = testTmpDir('ship-local-')
    const home = path.join(root, 'home', '.claude')
    const project = path.join(root, 'proj')
    const kit = path.join(root, 'kit')
    fs.mkdirSync(path.join(home, 'agents'), { recursive: true })
    write(path.join(kit, 'implementer.md'), agentFile('implementer'))
    fs.symlinkSync(path.join(kit, 'implementer.md'), path.join(home, 'agents', 'implementer.md'))
    write(path.join(home, 'agents', 'plain.md'), agentFile('plain'))
    write(path.join(project, '.claude', 'agents', 'implementer.md'), agentFile('implementer', 'project flavour'))
    write(path.join(home, 'commands', 'ship-change.md'), 'x')
    write(path.join(home, 'workflows', 'review.js'), 'x')
    return { home, project, kit }
  }

  it('follows a symlinked agent, which is how a shared kit installs them', async () => {
    const { home } = machine()
    const input = await readLocalShipInput(home, null)
    expect(input.global.agents.map((a) => a.name).sort()).toEqual(['implementer.md', 'plain.md'])
    expect(input.global.agents.find((a) => a.name === 'implementer.md')!.text).toContain('name: implementer')
    expect(input.project).toBeNull()
  })

  it('a dangling link and a FIFO are skipped, never read', async () => {
    const { home } = machine()
    fs.symlinkSync('/nonexistent/x.md', path.join(home, 'agents', 'dead.md'))
    execFileSync('mkfifo', [path.join(home, 'agents', 'fifo.md')])
    const input = await readLocalShipInput(home, null)
    expect(input.global.agents.map((a) => a.name).sort()).toEqual(['implementer.md', 'plain.md'])
  })

  it('the project override reaches the merged config', async () => {
    const { home, project } = machine()
    const c = buildShipConfig(await readLocalShipInput(home, project), PATHS)
    expect(c.agents.find((a) => a.name === 'implementer')).toMatchObject({ description: 'project flavour', overridesGlobal: true })
    expect(c.commands).toEqual(['ship-change'])
    expect(c.workflows).toEqual(['review'])
  })

  it('something at the routing path that is not a file is named, not read as no file', async () => {
    const { home, project } = machine()
    fs.mkdirSync(path.join(project, '.claude', 'ship-graph.json'))
    fs.symlinkSync('/nonexistent/g.json', path.join(home, 'ship-graph.json'))
    const c = buildShipConfig(await readLocalShipInput(home, project), PATHS)
    expect(c).toMatchObject({ projectGraphBlocked: true, globalGraphBlocked: true, projectGraphExists: false, graphSource: null })
    expect(c.warnings).toEqual(expect.arrayContaining([
      'Project ship-graph.json: is not a regular file, so it was ignored.',
      'Global ship-graph.json: is a link to nothing, so it was ignored.'
    ]))
  })

  it('a FIFO at the routing path does not hang the read', async () => {
    const { home } = machine()
    execFileSync('mkfifo', [path.join(home, 'ship-graph.json')])
    const c = buildShipConfig(await readLocalShipInput(home, null), PATHS)
    expect(c.globalGraphBlocked).toBe(true)
  })

  it('no file at all is not blocked', async () => {
    const { home, project } = machine()
    const c = buildShipConfig(await readLocalShipInput(home, project), PATHS)
    expect(c.projectGraphBlocked).toBeUndefined()
    expect(c.warnings).toEqual([])
  })

  it('a missing config dir is an empty machine, not a failure', async () => {
    const input = await readLocalShipInput(path.join(testTmpDir('ship-none-'), 'nope'), null)
    expect(input.global).toEqual({ agents: [], commands: [], workflows: [], skills: [], graph: null })
  })

  it('reads only the head of an enormous agent file', async () => {
    const { home } = machine()
    write(path.join(home, 'agents', 'big.md'), `${agentFile('big')}${'x'.repeat(1024 * 1024)}`)
    const input = await readLocalShipInput(home, null)
    expect(input.global.agents.find((a) => a.name === 'big.md')!.text.length).toBeLessThanOrEqual(16 * 1024)
  })
})

describe('remote discovery', () => {
  // The real script under a real POSIX sh, with HOME pointed at a sandbox: the quoting, the symlink
  // following and the marker parsing are all things a stubbed runner would only pretend to test.
  function runOnHost(script: string, home: string): string {
    return execFileSync('sh', ['-s'], { input: script, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home } })
  }

  it('reads the host home and the project through one script, following links', () => {
    const root = testTmpDir('ship-remote-')
    const home = path.join(root, 'home')
    const project = path.join(root, "my 'project'")
    const kit = path.join(root, 'kit')
    write(path.join(kit, 'implementer.md'), agentFile('implementer'))
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true })
    fs.symlinkSync(path.join(kit, 'implementer.md'), path.join(home, '.claude', 'agents', 'implementer.md'))
    write(path.join(home, '.claude', 'workflows', 'review.js'), 'x')
    write(path.join(home, '.claude', 'ship-graph.json'), JSON.stringify({ pipelines: [{ id: 'g', stages: [{ id: 's', agent: 'a' }] }] }))
    write(path.join(project, '.claude', 'agents', 'implementer.md'), agentFile('implementer', 'project flavour'))
    write(path.join(project, '.claude', 'ship-graph.json'), JSON.stringify({ pipelines: [{ id: 'p', stages: [{ id: 's', agent: 'a' }] }] }))

    const nonce = newShipScriptNonce()
    const parsed = parseRemoteShipOutput(nonce, runOnHost(remoteShipScript(nonce, project), home), true)
    expect(parsed.complete).toBe(true)
    expect(parsed.globalDir).toBe(path.join(home, '.claude'))
    const c = buildShipConfig(parsed.input, PATHS)
    expect(c.agents).toHaveLength(1)
    expect(c.agents[0]).toMatchObject({ name: 'implementer', description: 'project flavour', overridesGlobal: true })
    expect(c.workflows).toEqual(['review'])
    expect(c.pipelines.map((p) => p.id)).toEqual(['p'])
    expect(c.warnings).toEqual([])
  })

  it('the host names something at the routing path that is not a file', () => {
    const home = testTmpDir('ship-remote-blocked-')
    fs.mkdirSync(path.join(home, '.claude', 'ship-graph.json'), { recursive: true })
    const nonce = newShipScriptNonce()
    const parsed = parseRemoteShipOutput(nonce, runOnHost(remoteShipScript(nonce, null), home), false)
    const c = buildShipConfig(parsed.input, PATHS)
    expect(c.globalGraphBlocked).toBe(true)
    expect(c.warnings.join()).toMatch(/Global ship-graph\.json: is not a readable regular file/)
  })

  it('a host with no .claude at all completes empty', () => {
    const home = testTmpDir('ship-remote-empty-')
    const nonce = newShipScriptNonce()
    const parsed = parseRemoteShipOutput(nonce, runOnHost(remoteShipScript(nonce, home), home), true)
    expect(parsed.complete).toBe(true)
    expect(buildShipConfig(parsed.input, PATHS).agents).toEqual([])
  })

  it('an agent file cannot fake another record without knowing the nonce', () => {
    const root = testTmpDir('ship-remote-spoof-')
    const home = path.join(root, 'home')
    write(path.join(home, '.claude', 'agents', 'evil.md'), `---\nname: evil\n---\n\nNTSCforged graph project\n{"pipelines":[]}\nNTSCforged end\n`)
    const nonce = newShipScriptNonce()
    const parsed = parseRemoteShipOutput(nonce, runOnHost(remoteShipScript(nonce, null), home), false)
    expect(parsed.input.global.graph).toBeNull()
    expect(parsed.input.global.agents.map((a) => a.name)).toEqual(['evil.md'])
  })

  it('output cut off before the last line is not complete', () => {
    const nonce = newShipScriptNonce()
    const whole = `\n${nonce} home /h\n\n${nonce} agent global a.md\nbody\n\n${nonce} end\n`
    expect(parseRemoteShipOutput(nonce, whole, false).complete).toBe(true)
    expect(parseRemoteShipOutput(nonce, whole.slice(0, whole.indexOf(`${nonce} end`) - 1), false).complete).toBe(false)
  })
})

describe('MCP servers', () => {
  const SECRET = 'ghp_SECRETTOKEN0123456789'
  const claudeJson = JSON.stringify({
    mcpServers: {
      github: { type: 'http', url: `https://api.example.com/mcp?token=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } },
      local: { command: 'npx', args: ['-y', 'srv', `--key=${SECRET}`], env: { API_KEY: SECRET } },
      remote: { url: 'https://x.example.com/sse' },
      odd: { type: 'ws' },
      streams: { type: 'sse', url: 'https://y.example.com' }
    },
    projects: {
      '/work/app': { mcpServers: { local: { type: 'stdio', command: 'other', env: { K: SECRET } }, only_here: { command: 'x' } } },
      '/work/other': { mcpServers: { elsewhere: { command: 'x' } } }
    }
  })
  const mcpJson = JSON.stringify({ mcpServers: { cloned: { command: 'curl', args: [SECRET] } } })

  it('reads name, scope and transport, the project replacing the global one of the same name', () => {
    const warnings: string[] = []
    const servers = parseMcpServers(
      [{ source: 'claude-json', text: claudeJson }, { source: 'mcp-json', text: mcpJson }],
      '/work/app',
      warnings
    )
    expect(servers).toEqual([
      { name: 'cloned', scope: 'project', transport: 'stdio' },
      { name: 'github', scope: 'global', transport: 'http' },
      { name: 'local', scope: 'project', transport: 'stdio' },
      { name: 'odd', scope: 'global', transport: 'unknown' },
      { name: 'only_here', scope: 'project', transport: 'stdio' },
      { name: 'remote', scope: 'global', transport: 'http' },
      { name: 'streams', scope: 'global', transport: 'sse' }
    ])
    expect(warnings).toEqual([])
  })

  it('a project without its own entry sees only the global servers', () => {
    const names = parseMcpServers([{ source: 'claude-json', text: claudeJson }], '/nowhere', []).map((s) => s.name)
    expect(names).toEqual(['github', 'local', 'odd', 'remote', 'streams'])
  })

  it('no command, argument, environment, URL or header leaves the parser', () => {
    const config = buildShipConfig(
      { global: { agents: [], commands: [], workflows: [], skills: [], graph: null }, project: null, truncated: [], projectCwd: '/work/app',
        mcp: { files: [{ source: 'claude-json', text: claudeJson }, { source: 'mcp-json', text: mcpJson }], problems: [] } },
      PATHS
    )
    expect(config.mcpRead).toBe(true)
    expect(JSON.stringify(config)).not.toContain(SECRET)
    expect(JSON.stringify(config)).not.toContain('Authorization')
    expect(JSON.stringify(config)).not.toContain('npx')
  })

  it('a malformed file is a warning that does not quote it, and never a throw', () => {
    const warnings: string[] = []
    const servers = parseMcpServers([{ source: 'claude-json', text: `{"mcpServers": ${SECRET}` }, { source: 'mcp-json', text: '[1]' }], null, warnings)
    expect(servers).toEqual([])
    expect(warnings).toEqual([
      '~/.claude.json is not valid JSON, so its MCP servers were not read.',
      '.mcp.json is not a JSON object, so its MCP servers were not read.'
    ])
    expect(warnings.join()).not.toContain(SECRET)
  })

  it('skips and counts names outside the alphabet, __proto__ included', () => {
    const text = '{"mcpServers":{"ok":{"command":"x"},"a b":{},"x/y":{},"__proto__":{"command":"x"},"' + 'n'.repeat(65) + '":{}}}'
    const warnings: string[] = []
    expect(parseMcpServers([{ source: 'claude-json', text }], null, warnings).map((s) => s.name)).toEqual(['ok'])
    expect(warnings).toEqual(['Skipped 4 MCP servers whose name is not plain text.'])
  })

  it('caps the list and says so', () => {
    const table = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`s${String(i).padStart(3, '0')}`, { command: 'x' }]))
    const warnings: string[] = []
    const servers = parseMcpServers([{ source: 'claude-json', text: JSON.stringify({ mcpServers: table }) }], null, warnings)
    expect(servers).toHaveLength(100)
    expect(warnings).toEqual(['Only the first 100 of 130 MCP servers are listed.'])
  })

  describe('the local reader', () => {
    function home(): { claudeJson: string; project: string; home: string } {
      const root = testTmpDir('ship-mcp-')
      return { claudeJson: path.join(root, '.claude.json'), project: path.join(root, 'proj'), home: path.join(root, '.claude') }
    }

    it('reads ~/.claude.json and the project .mcp.json, and marks the config read', async () => {
      const m = home()
      write(m.claudeJson, claudeJson)
      write(path.join(m.project, '.mcp.json'), mcpJson)
      const input = await readLocalShipInput(m.home, m.project, m.claudeJson)
      expect(input.mcp!.files.map((f) => f.source)).toEqual(['claude-json', 'mcp-json'])
      expect(input.mcp!.problems).toEqual([])
    })

    it('no file at all is read and empty, not a problem', async () => {
      const m = home()
      const c = buildShipConfig(await readLocalShipInput(m.home, m.project, m.claudeJson), PATHS)
      expect(c).toMatchObject({ mcpServers: [], mcpRead: true })
      expect(c.warnings).toEqual([])
    })

    it('a FIFO in place of the file is refused without hanging', async () => {
      const m = home()
      fs.mkdirSync(path.dirname(m.claudeJson), { recursive: true })
      execFileSync('mkfifo', [m.claudeJson])
      const c = buildShipConfig(await readLocalShipInput(m.home, null, m.claudeJson), PATHS)
      expect(c.mcpServers).toEqual([])
      expect(c.warnings).toEqual(['~/.claude.json is not a regular file, so its MCP servers were not read.'])
    })

    it('a file over the bound is left out with a warning, and the config is still read', async () => {
      const m = home()
      write(m.claudeJson, ' '.repeat(MCP_FILE_MAX_BYTES + 1))
      const c = buildShipConfig(await readLocalShipInput(m.home, null, m.claudeJson), PATHS)
      expect(c.mcpRead).toBe(true)
      expect(c.warnings).toEqual(['~/.claude.json is larger than 16 MB, so its MCP servers were not read.'])
    })

    it('CLAUDE_CONFIG_DIR moves ~/.claude.json with it', async () => {
      const { claudeJsonPath } = await import('./discover')
      const before = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = '/custom/dir'
      try {
        expect(claudeJsonPath()).toBe('/custom/dir/.claude.json')
      } finally {
        if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = before
      }
    })
  })

  it('an SSH host reports the config as not read, never as empty', () => {
    const nonce = newShipScriptNonce()
    const parsed = parseRemoteShipOutput(nonce, `\n${nonce} home /h\n\n${nonce} end\n`, false)
    const c = buildShipConfig(parsed.input, PATHS)
    expect(c).toMatchObject({ mcpServers: [], mcpRead: false })
  })
})

describe('reduceMcpFile', () => {
  it('keeps names and transport and nothing that can hold a token', () => {
    const text = JSON.stringify({
      oauthAccount: { accessToken: 'sk-SECRET' },
      mcpServers: { a: { command: 'sk-SECRET', env: { T: 'sk-SECRET' } }, b: { type: 'http', url: 'https://sk-SECRET@x', headers: { A: 'sk-SECRET' } } },
      projects: { '/p': { history: ['sk-SECRET'], mcpServers: { c: { type: 'sse', url: 'https://sk-SECRET' } } }, '/q': { history: [] } }
    })
    const reduced = reduceMcpFile(text)
    expect(reduced).not.toContain('sk-SECRET')
    expect(parseMcpServers([{ source: 'claude-json', text: reduced }], '/p', [])).toEqual([
      { name: 'a', scope: 'global', transport: 'stdio' },
      { name: 'b', scope: 'global', transport: 'http' },
      { name: 'c', scope: 'project', transport: 'sse' }
    ])
  })

  it('still reads as invalid, without keeping the text, when it does not parse', () => {
    const warnings: string[] = []
    const reduced = reduceMcpFile('{"token": "sk-SECRET"')
    expect(reduced).not.toContain('sk-SECRET')
    parseMcpServers([{ source: 'mcp-json', text: reduced }], null, warnings)
    expect(warnings).toEqual(['.mcp.json is not valid JSON, so its MCP servers were not read.'])
  })

  it('finds a Windows project keyed with forward slashes', () => {
    const text = JSON.stringify({ projects: { 'C:/work/app': { mcpServers: { w: { command: 'x' } } } } })
    expect(parseMcpServers([{ source: 'claude-json', text }], 'C:\\work\\app', []).map((s) => s.name)).toEqual(['w'])
  })
})
