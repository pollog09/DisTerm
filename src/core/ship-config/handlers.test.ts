import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import { SHIP_LEASE_MS, SHIP_SHARED_CONFIG_MESSAGE, holdShipConfigLease } from '../../shared/ship-config'
import type { CorePlatform } from '../platform'
import { testTmpDir } from '../test-tmp'
import { SHIP_TEMPLATE_FILES, planShipTemplate, shipTemplateRel } from './template'
import {
  SHIP_POLL_LOCAL_MS,
  SHIP_POLL_REMOTE_MS,
  createShipGraph,
  createShipTemplate,
  readShipConfig,
  registerShipConfigHandlers,
  type ShipConfigRouter
} from './handlers'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const local = (cwd: string | null): ShipConfigRouter => ({ route: () => ({ kind: 'local', cwd }) })

/** A real POSIX sh standing in for the host at the far end of ssh. */
function hostRunner(home: string, extraEnv: Record<string, string> = {}) {
  return async (script: string): Promise<{ code: number; stdout: string }> => {
    try {
      const stdout = execFileSync('sh', ['-s'], { input: script, cwd: home, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '', HOME: home, ...extraEnv } })
      return { code: 0, stdout }
    } catch (err) {
      const e = err as { status?: number; stdout?: string }
      return { code: e.status ?? 1, stdout: e.stdout ?? '' }
    }
  }
}

describe('readShipConfig', () => {
  it('reads this machine for a local project, from CLAUDE_CONFIG_DIR when it is set', async () => {
    const dir = testTmpDir('ship-read-')
    vi.stubEnv('CLAUDE_CONFIG_DIR', dir)
    fs.mkdirSync(path.join(dir, 'agents'))
    fs.writeFileSync(path.join(dir, 'agents', 'a.md'), '---\nname: a\n---\n')
    const r = await readShipConfig('P', local(null))
    expect(r).toMatchObject({ ok: true, config: { machine: { kind: 'local' }, projectGraphPath: null, globalGraphPath: path.join(dir, 'ship-graph.json') } })
    expect(r.ok && r.config.agents.map((a) => a.name)).toEqual(['a'])
  })

  it('reads the HOST for an SSH project, never this machine', async () => {
    const localDir = testTmpDir('ship-read-')
    vi.stubEnv('CLAUDE_CONFIG_DIR', localDir)
    fs.mkdirSync(path.join(localDir, 'agents'))
    fs.writeFileSync(path.join(localDir, 'agents', 'local-only.md'), '---\nname: local-only\n---\n')
    const home = testTmpDir('ship-host-')
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'agents', 'on-host.md'), '---\nname: on-host\n---\n')
    const r = await readShipConfig('P', { route: () => ({ kind: 'remote', remoteCwd: home, host: 'box', runScript: hostRunner(home) }) })
    expect(r.ok && r.config.machine).toEqual({ kind: 'ssh', label: 'box' })
    expect(r.ok && r.config.agents.map((a) => a.name)).toEqual(['on-host'])
  })

  it('a dropped channel is a named failure, not an empty machine', async () => {
    const r = await readShipConfig('P', { route: () => ({ kind: 'remote', remoteCwd: '/x', host: 'box', runScript: async () => ({ code: 255, stdout: '' }) }) })
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('255') })
    const thrown = await readShipConfig('P', { route: () => ({ kind: 'remote', remoteCwd: '/x', host: 'box', runScript: async () => { throw new Error('gone') } }) })
    expect(thrown).toEqual({ ok: false, reason: expect.stringContaining('gone') })
  })

  it('an unsupported route says why, and a bad id is refused', async () => {
    await expect(readShipConfig('P', { route: () => ({ kind: 'unsupported', reason: 'Not connected.' }) })).resolves.toEqual({ ok: false, reason: 'Not connected.' })
    await expect(readShipConfig(7, local(null))).resolves.toMatchObject({ ok: false })
  })
})

describe('createShipGraph', () => {
  it('writes the example into a project and never over a file', async () => {
    const cwd = testTmpDir('ship-create-')
    const file = path.join(cwd, '.claude', 'ship-graph.json')
    await expect(createShipGraph('P', 'project', local(cwd))).resolves.toEqual({ ok: true, path: file })
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pipelines[0].id).toBe('ship-change')
    fs.writeFileSync(file, 'mine')
    await expect(createShipGraph('P', 'project', local(cwd))).resolves.toMatchObject({ ok: false, reason: 'exists' })
    expect(fs.readFileSync(file, 'utf8')).toBe('mine')
  })

  it('refuses a project file on a canvas with no folder, and an unknown scope', async () => {
    await expect(createShipGraph('P', 'project', local(null))).resolves.toMatchObject({ ok: false, reason: 'unsupported' })
    await expect(createShipGraph('P', '../../etc', local('/tmp'))).resolves.toMatchObject({ ok: false, reason: 'unsupported' })
  })

  it('writes on the host for an SSH project, with the same refusal', async () => {
    const home = testTmpDir('ship-create-host-')
    const cwd = path.join(home, "pro'ject")
    fs.mkdirSync(cwd)
    const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: cwd, host: 'box', runScript: hostRunner(home) }) }
    const file = path.join(cwd, '.claude', 'ship-graph.json')
    await expect(createShipGraph('P', 'project', router)).resolves.toEqual({ ok: true, path: file })
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pipelines[0].id).toBe('ship-change')
    fs.writeFileSync(file, 'mine')
    await expect(createShipGraph('P', 'project', router)).resolves.toMatchObject({ ok: false, reason: 'exists' })
    expect(fs.readFileSync(file, 'utf8')).toBe('mine')
  })
})

describe('createShipGraph reports the path the host really used', () => {
  it('a global file under the host\'s CLAUDE_CONFIG_DIR', async () => {
    const home = testTmpDir('ship-create-cfg-')
    const dir = path.join(home, 'custom-config')
    const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: home, host: 'box', runScript: hostRunner(home, { CLAUDE_CONFIG_DIR: dir }) }) }
    const file = path.join(dir, 'ship-graph.json')
    await expect(createShipGraph('P', 'global', router)).resolves.toEqual({ ok: true, path: file })
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.existsSync(path.join(home, '.claude', 'ship-graph.json'))).toBe(false)
    await expect(createShipGraph('P', 'global', router)).resolves.toMatchObject({ ok: false, reason: 'exists', message: `${file} already exists.` })
  })

  it('a script cut off by a dropped channel runs nothing and reports nothing, at any length', async () => {
    const home = testTmpDir('ship-create-cut-')
    const cwd = path.join(home, 'proj')
    const hostCwd = path.join(home, 'where-the-shell-runs')
    fs.mkdirSync(cwd)
    fs.mkdirSync(hostCwd)
    let whole = ''
    await createShipGraph('P', 'project', { route: () => ({ kind: 'remote', remoteCwd: cwd, host: 'box', runScript: async (s) => {
      whole = s
      return { code: 0, stdout: '' }
    } }) })
    const dir = path.join(cwd, '.claude')
    const file = path.join(dir, 'ship-graph.json')
    const bodyStart = whole.indexOf('{\n  "pipelines"')
    const bodyEnd = whole.indexOf("}\n'\ncase")
    expect(bodyEnd).toBeGreaterThan(bodyStart)
    expect(bodyStart).toBeGreaterThan(0)
    const lastLine = whole.lastIndexOf('nt_create_ship_graph\n')
    const cut = async (at: number): Promise<void> => {
      const r = await createShipGraph('P', 'project', { route: () => ({ kind: 'remote', remoteCwd: cwd, host: 'box', runScript: async (script) => {
        // sh -s on a piece of this call's script (its nonce is its own), in a neutral cwd: what a
        // dropped channel leaves.
        const out = spawnSync('sh', ['-s'], { input: script.slice(0, at), cwd: hostCwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home } })
        return { code: out.status ?? 1, stdout: out.stdout ?? '' }
      } }) })
      const label = JSON.stringify(whole.slice(Math.max(0, at - 24), at))
      expect(fs.readdirSync(hostCwd), `stray from ${label}`).toEqual([])
      if (at < lastLine + 'nt_create_ship_graph'.length) {
        expect(r.ok, `reported success from ${label}`).toBe(false)
        expect(fs.existsSync(dir), `ran part of the script from ${label}`).toBe(false)
      } else {
        expect(r.ok, label).toBe(true) // the call itself made it across
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).pipelines[0].id).toBe('ship-change')
      }
      fs.rmSync(dir, { recursive: true, force: true })
    }
    // Every byte of the script around the JSON, and a sample inside it, where every cut is the same.
    for (let at = 1; at < whole.length; at++) {
      if (at > bodyStart + 4 && at < bodyEnd - 4 && at % 40 !== 0) continue
      await cut(at)
    }
    await cut(whole.length)
  }, 60_000)

  it('exit 0 with no done marker is not a success: a shell that read nothing also exits 0', async () => {
    const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: '/p', host: 'box', runScript: async () => ({ code: 0, stdout: '' }) }) }
    await expect(createShipGraph('P', 'project', router)).resolves.toMatchObject({ ok: false, reason: 'failed' })
  })

  it('leaves no temp behind', async () => {
    const home = testTmpDir('ship-create-temp-')
    const cwd = path.join(home, 'proj')
    fs.mkdirSync(cwd)
    await createShipGraph('P', 'project', { route: () => ({ kind: 'remote', remoteCwd: cwd, host: 'box', runScript: hostRunner(home) }) })
    expect(fs.readdirSync(path.join(cwd, '.claude'))).toEqual(['ship-graph.json'])
  })

  it('a failed write on the host is a failure, not a success with a path', async () => {
    const home = testTmpDir('ship-create-fail-')
    const cwd = path.join(home, 'ro')
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    fs.chmodSync(path.join(cwd, '.claude'), 0o500)
    const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: cwd, host: 'box', runScript: hostRunner(home) }) }
    await expect(createShipGraph('P', 'project', router)).resolves.toMatchObject({ ok: false, reason: 'failed' })
    fs.chmodSync(path.join(cwd, '.claude'), 0o700)
  })
})

describe('createShipTemplate', () => {
  const ALL = SHIP_TEMPLATE_FILES.map(shipTemplateRel)
  // Permissions stop nobody as root, and POSIX modes do not apply on win32, so these cases mean nothing there.
  const cannotDenyAccess = process.platform === 'win32' || process.getuid?.() === 0
  /** A machine with an empty global config, so nothing of this one's leaks in. */
  const machine = (): { home: string; cwd: string; globalDir: string } => {
    const home = testTmpDir('ship-template-')
    const cwd = path.join(home, 'proj')
    const globalDir = path.join(home, '.claude')
    fs.mkdirSync(cwd)
    vi.stubEnv('CLAUDE_CONFIG_DIR', globalDir)
    return { home, cwd, globalDir }
  }
  const put = (file: string, text: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  const remote = (home: string, cwd: string): ShipConfigRouter => ({
    route: () => ({ kind: 'remote', remoteCwd: cwd, host: 'box', runScript: hostRunner(home, { CLAUDE_CONFIG_DIR: path.join(home, '.claude') }) })
  })

  describe.each(['local', 'remote'] as const)('%s', (where) => {
    const routerFor = (home: string, cwd: string): ShipConfigRouter => (where === 'local' ? local(cwd) : remote(home, cwd))

    it('writes the whole pipeline into the project, and the discovery reads it back as one', async () => {
      const { home, cwd } = machine()
      const router = routerFor(home, cwd)
      const r = await createShipTemplate('P', router)
      expect(r).toEqual({ ok: true, root: path.join(cwd, '.claude'), created: ALL, kept: [] })
      expect(fs.readdirSync(path.join(cwd, '.claude')).sort()).toEqual(['agents', 'commands', 'ship-graph.json'])
      expect(fs.readdirSync(path.join(cwd, '.claude', 'agents')).sort()).toEqual(['change-reviewer.md', 'doc-writer.md', 'implementer.md'])
      for (const file of SHIP_TEMPLATE_FILES) {
        expect(fs.readFileSync(path.join(cwd, '.claude', shipTemplateRel(file)), 'utf8')).toBe(file.text)
      }
      const read = await readShipConfig('P', router)
      if (!read.ok) throw new Error(read.reason)
      expect(read.config.graphSource).toBe('project')
      expect(read.config.warnings).toEqual([])
      expect(read.config.commands).toEqual(['ship-change'])
      expect(read.config.agents.map((a) => [a.name, a.scope])).toEqual([['change-reviewer', 'project'], ['doc-writer', 'project'], ['implementer', 'project']])
      expect(read.config.agents.every((a) => a.description && a.color)).toBe(true)
      expect(read.config.pipelines[0].stages.map((s) => s.agent)).toEqual(['implementer', 'doc-writer', 'change-reviewer'])
    })

    it('never overwrites a project file, and reports it as kept', async () => {
      const { home, cwd } = machine()
      const mine = path.join(cwd, '.claude', 'agents', 'implementer.md')
      put(mine, 'no frontmatter, a person wrote this')
      const r = await createShipTemplate('P', routerFor(home, cwd))
      expect(r.ok && r.kept).toEqual(['agents/implementer.md'])
      expect(r.ok && r.created).toEqual(ALL.filter((f) => f !== 'agents/implementer.md'))
      expect(fs.readFileSync(mine, 'utf8')).toBe('no frontmatter, a person wrote this')
    })

    it('does not shadow an agent or command the machine already has, by file or by declared name', async () => {
      const { home, cwd, globalDir } = machine()
      put(path.join(globalDir, 'agents', 'doc-writer.md'), '---\nname: doc-writer\n---\n')
      put(path.join(globalDir, 'agents', 'something-else.md'), '---\nname: change-reviewer\n---\n')
      put(path.join(globalDir, 'commands', 'ship-change.md'), 'mine\n')
      const r = await createShipTemplate('P', routerFor(home, cwd))
      expect(r.ok && [...r.kept].sort()).toEqual(['agents/change-reviewer.md', 'agents/doc-writer.md', 'commands/ship-change.md'])
      expect(fs.existsSync(path.join(cwd, '.claude', 'agents', 'doc-writer.md'))).toBe(false)
      expect(fs.existsSync(path.join(cwd, '.claude', 'commands'))).toBe(false)
      expect(fs.existsSync(path.join(cwd, '.claude', 'agents', 'implementer.md'))).toBe(true)
    })

    it('checks the exact global file too, for an agent a capped listing never read', async () => {
      const { home, cwd, globalDir } = machine()
      for (let i = 0; i < 100; i++) put(path.join(globalDir, 'agents', `a${String(i).padStart(3, '0')}.md`), '')
      put(path.join(globalDir, 'agents', 'implementer.md'), '---\nname: implementer\n---\n')
      const r = await createShipTemplate('P', routerFor(home, cwd))
      expect(r.ok && r.kept).toEqual(['agents/implementer.md'])
      expect(fs.existsSync(path.join(cwd, '.claude', 'agents', 'implementer.md'))).toBe(false)
    })

    it('does not write a routing file over a global one, which it would replace whole', async () => {
      const { home, cwd, globalDir } = machine()
      put(path.join(globalDir, 'ship-graph.json'), JSON.stringify({ pipelines: [{ id: 'g', name: 'G', stages: [{ id: 's', agent: 'x' }], edges: [] }] }))
      const r = await createShipTemplate('P', routerFor(home, cwd))
      expect(r.ok && r.kept).toEqual(['ship-graph.json'])
      expect(fs.existsSync(path.join(cwd, '.claude', 'ship-graph.json'))).toBe(false)
    })

    it('does not write over a global routing file with a typo, or something unreadable at that path', async () => {
      const { home, cwd, globalDir } = machine()
      put(path.join(globalDir, 'ship-graph.json'), '{ "pipelines": [ oops')
      const typo = await createShipTemplate('P', routerFor(home, cwd))
      expect(typo.ok && typo.kept).toEqual(['ship-graph.json'])
      expect(fs.existsSync(path.join(cwd, '.claude', 'ship-graph.json'))).toBe(false)

      fs.rmSync(path.join(globalDir, 'ship-graph.json'))
      fs.mkdirSync(path.join(globalDir, 'ship-graph.json'))
      const blocked = await createShipTemplate('P', routerFor(home, cwd))
      expect(blocked.ok && blocked.kept).toContain('ship-graph.json') // the agents are there from the call above
      expect(fs.existsSync(path.join(cwd, '.claude', 'ship-graph.json'))).toBe(false)
    })

    it('refuses a project whose .claude is the global config, writing nothing there', async () => {
      const { home, globalDir } = machine()
      put(path.join(globalDir, 'agents', 'doc-writer.md'), '---\nname: doc-writer\n---\n')
      const before = fs.readdirSync(globalDir)
      await expect(createShipTemplate('P', routerFor(home, home))).resolves.toEqual({ ok: false, reason: 'unsupported', message: SHIP_SHARED_CONFIG_MESSAGE })
      expect(fs.readdirSync(globalDir)).toEqual(before)
      expect(fs.readdirSync(path.join(globalDir, 'agents'))).toEqual(['doc-writer.md'])
    })

    it('refuses it before either folder exists, and does not create the global one', async () => {
      const { home, globalDir } = machine()
      await expect(createShipTemplate('P', routerFor(home, home))).resolves.toMatchObject({ reason: 'unsupported', message: SHIP_SHARED_CONFIG_MESSAGE })
      expect(fs.existsSync(globalDir)).toBe(false)
    })

    it('sees through links: to the home folder, and from .claude to the global config', async () => {
      const { home, cwd, globalDir } = machine()
      fs.mkdirSync(globalDir)
      const viaLink = path.join(home, 'home-link')
      fs.symlinkSync(home, viaLink)
      await expect(createShipTemplate('P', routerFor(home, viaLink))).resolves.toMatchObject({ reason: 'unsupported' })
      fs.symlinkSync(globalDir, path.join(cwd, '.claude'))
      await expect(createShipTemplate('P', routerFor(home, cwd))).resolves.toMatchObject({ reason: 'unsupported' })
      expect(fs.readdirSync(globalDir)).toEqual([])
    })

    it.each(['agents', 'commands'])('refuses a project whose %s folder links to the global one, writing nothing', async (sub) => {
      const { home, cwd, globalDir } = machine()
      fs.mkdirSync(path.join(globalDir, sub), { recursive: true })
      fs.mkdirSync(path.join(cwd, '.claude'))
      fs.symlinkSync(path.join(globalDir, sub), path.join(cwd, '.claude', sub))
      await expect(createShipTemplate('P', routerFor(home, cwd))).resolves.toEqual({ ok: false, reason: 'unsupported', message: SHIP_SHARED_CONFIG_MESSAGE })
      expect(fs.readdirSync(path.join(globalDir, sub))).toEqual([])
      expect(fs.readdirSync(path.join(cwd, '.claude'))).toEqual([sub])
    })

    it('a link to a global folder that does not exist yet does not bring it into being', async () => {
      const { home, cwd, globalDir } = machine()
      fs.mkdirSync(globalDir)
      fs.mkdirSync(path.join(cwd, '.claude'))
      fs.symlinkSync(path.join(globalDir, 'agents'), path.join(cwd, '.claude', 'agents'))
      const r = await createShipTemplate('P', routerFor(home, cwd))
      expect(r.ok).toBe(false)
      expect(fs.readdirSync(globalDir)).toEqual([])
    })

    it.skipIf(cannotDenyAccess).each(['agents', 'commands'])('a global %s folder that cannot be read is a failure, not absence', async (sub) => {
      const { home, cwd, globalDir } = machine()
      const locked = path.join(globalDir, sub)
      fs.mkdirSync(locked, { recursive: true })
      fs.chmodSync(locked, 0o000)
      try {
        const r = await createShipTemplate('P', routerFor(home, cwd))
        expect(r).toMatchObject({ ok: false, reason: 'failed' })
        expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false)
      } finally {
        fs.chmodSync(locked, 0o700)
      }
    })

    it.each(['agents', 'commands'])('refuses a %s folder linked to a subfolder inside the global config', async (sub) => {
      const { home, cwd, globalDir } = machine()
      const inside = path.join(globalDir, sub, 'nested')
      fs.mkdirSync(inside, { recursive: true })
      fs.mkdirSync(path.join(cwd, '.claude'))
      fs.symlinkSync(inside, path.join(cwd, '.claude', sub))
      await expect(createShipTemplate('P', routerFor(home, cwd))).resolves.toEqual({ ok: false, reason: 'unsupported', message: SHIP_SHARED_CONFIG_MESSAGE })
      expect(fs.readdirSync(inside)).toEqual([])
    })

    it.each(['agents', 'commands'])('refuses a %s link to a subfolder of the global config that does not exist yet', async (sub) => {
      const { home, cwd, globalDir } = machine()
      fs.mkdirSync(globalDir)
      fs.mkdirSync(path.join(cwd, '.claude'))
      fs.symlinkSync(path.join(globalDir, sub, 'not', 'yet'), path.join(cwd, '.claude', sub))
      await expect(createShipTemplate('P', routerFor(home, cwd))).resolves.toEqual({ ok: false, reason: 'unsupported', message: SHIP_SHARED_CONFIG_MESSAGE })
      expect(fs.readdirSync(globalDir)).toEqual([])
      expect(fs.readdirSync(path.join(cwd, '.claude'))).toEqual([sub])
    })

    it('refuses a relative link into the global config, and a .claude linked inside it', async () => {
      const { home, cwd, globalDir } = machine()
      fs.mkdirSync(path.join(globalDir, 'x'), { recursive: true })
      fs.mkdirSync(path.join(cwd, '.claude'))
      fs.symlinkSync(path.join('..', '..', '.claude', 'agents', 'later'), path.join(cwd, '.claude', 'agents'))
      await expect(createShipTemplate('P', routerFor(home, cwd))).resolves.toMatchObject({ reason: 'unsupported' })
      fs.rmSync(path.join(cwd, '.claude'), { recursive: true })
      fs.symlinkSync(path.join(globalDir, 'x'), path.join(cwd, '.claude'))
      await expect(createShipTemplate('P', routerFor(home, cwd))).resolves.toMatchObject({ reason: 'unsupported' })
      expect(fs.readdirSync(path.join(globalDir, 'x'))).toEqual([])
    })

    it('refuses a project opened on the global config itself, or inside it: its .claude is inside', async () => {
      const { home, globalDir } = machine()
      const below = path.join(globalDir, 'projects', 'x')
      fs.mkdirSync(below, { recursive: true })
      for (const cwd of [globalDir, below]) {
        await expect(createShipTemplate('P', routerFor(home, cwd))).resolves.toMatchObject({ reason: 'unsupported', message: SHIP_SHARED_CONFIG_MESSAGE })
        await expect(createShipGraph('P', 'project', routerFor(home, cwd))).resolves.toMatchObject({ reason: 'unsupported', message: SHIP_SHARED_CONFIG_MESSAGE })
        expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false)
      }
    })

    it('does not refuse a sibling whose name merely starts the same', async () => {
      const { home, cwd } = machine()
      const sibling = path.join(home, '.claude-2')
      fs.mkdirSync(path.join(sibling, 'agents'), { recursive: true })
      fs.mkdirSync(path.join(cwd, '.claude'))
      fs.symlinkSync(path.join(sibling, 'agents'), path.join(cwd, '.claude', 'agents'))
      await expect(createShipTemplate('P', routerFor(home, cwd))).resolves.toMatchObject({ ok: true, created: ALL })
      expect(fs.readdirSync(path.join(sibling, 'agents')).sort()).toEqual(['change-reviewer.md', 'doc-writer.md', 'implementer.md'])

      const projectThere = path.join(home, '.claude-2', 'proj')
      fs.mkdirSync(projectThere)
      await expect(createShipGraph('P', 'project', routerFor(home, projectThere))).resolves.toMatchObject({ ok: true })
    })

    it('treats a config path as text, not a pattern', async () => {
      const { home } = machine()
      const globalDir = path.join(home, 'conf*')
      vi.stubEnv('CLAUDE_CONFIG_DIR', globalDir)
      const cwd = path.join(home, 'confX', 'proj')
      fs.mkdirSync(cwd, { recursive: true })
      const router = where === 'local' ? local(path.join(home, 'confX')) : { route: () => ({ kind: 'remote' as const, remoteCwd: path.join(home, 'confX'), host: 'box', runScript: hostRunner(home, { CLAUDE_CONFIG_DIR: globalDir }) }) }
      await expect(createShipGraph('P', 'project', router)).resolves.toMatchObject({ ok: true })
    })

    describe('Create example', () => {
      it('refuses a project on the home folder, whose file would be the global routing file', async () => {
        const { home, globalDir } = machine()
        await expect(createShipGraph('P', 'project', routerFor(home, home))).resolves.toEqual({ ok: false, reason: 'unsupported', message: SHIP_SHARED_CONFIG_MESSAGE })
        expect(fs.existsSync(globalDir)).toBe(false)
      })

      it('sees through a .claude linked into the global config, there or not yet', async () => {
        const { home, cwd, globalDir } = machine()
        fs.mkdirSync(globalDir)
        fs.symlinkSync(path.join(globalDir, 'not-yet'), path.join(cwd, '.claude'))
        await expect(createShipGraph('P', 'project', routerFor(home, cwd))).resolves.toMatchObject({ reason: 'unsupported' })
        fs.unlinkSync(path.join(cwd, '.claude'))
        fs.symlinkSync(globalDir, path.join(cwd, '.claude'))
        await expect(createShipGraph('P', 'project', routerFor(home, cwd))).resolves.toMatchObject({ reason: 'unsupported' })
        expect(fs.readdirSync(globalDir)).toEqual([])
      })

      it('scope global is the person asking for it, and still writes there', async () => {
        const { home, cwd, globalDir } = machine()
        await expect(createShipGraph('P', 'global', routerFor(home, cwd))).resolves.toEqual({ ok: true, path: path.join(globalDir, 'ship-graph.json') })
      })

      it('a project elsewhere is unaffected', async () => {
        const { home, cwd } = machine()
        await expect(createShipGraph('P', 'project', routerFor(home, cwd))).resolves.toEqual({ ok: true, path: path.join(cwd, '.claude', 'ship-graph.json') })
      })

      // Remote only: a local realpath needs just the parent, so that leg has nothing it cannot read.
      it.skipIf(cannotDenyAccess || where === 'local')('a global config that cannot be read is a failure, and nothing is written', async () => {
        const { home, cwd, globalDir } = machine()
        fs.mkdirSync(globalDir)
        fs.chmodSync(globalDir, 0o000)
        try {
          const r = await createShipGraph('P', 'project', routerFor(home, cwd))
          expect(r).toMatchObject({ ok: false, reason: 'failed' })
          expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false)
        } finally {
          fs.chmodSync(globalDir, 0o700)
        }
      })
    })

    it('a home folder is fine when the global config lives elsewhere', async () => {
      const { home } = machine()
      const other = path.join(home, 'elsewhere')
      vi.stubEnv('CLAUDE_CONFIG_DIR', other)
      const router = where === 'local' ? local(home) : { route: () => ({ kind: 'remote' as const, remoteCwd: home, host: 'box', runScript: hostRunner(home, { CLAUDE_CONFIG_DIR: other }) }) }
      await expect(createShipTemplate('P', router)).resolves.toMatchObject({ ok: true, created: ALL })
      expect(fs.existsSync(other)).toBe(false)
    })

    it('a dead link at a path is something there, and is kept', async () => {
      const { home, cwd } = machine()
      fs.mkdirSync(path.join(cwd, '.claude', 'commands'), { recursive: true })
      fs.symlinkSync(path.join(cwd, 'nowhere'), path.join(cwd, '.claude', 'commands', 'other.md'))
      fs.mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true })
      fs.symlinkSync(path.join(cwd, 'nowhere'), path.join(cwd, '.claude', 'agents', 'implementer.md'))
      const r = await createShipTemplate('P', routerFor(home, cwd))
      expect(r.ok && r.kept).toEqual(['agents/implementer.md'])
      expect(fs.existsSync(path.join(cwd, 'nowhere'))).toBe(false)
    })

    it('never brings a removed project folder back', async () => {
      const { home, cwd } = machine()
      fs.rmdirSync(cwd)
      const r = await createShipTemplate('P', routerFor(home, cwd))
      expect(r.ok).toBe(false)
      expect(fs.existsSync(cwd)).toBe(false)
    })

    it.skipIf(cannotDenyAccess)('stops at a failed write and leaves no routing naming agents that are not there', async () => {
      const { home, cwd } = machine()
      fs.mkdirSync(path.join(cwd, '.claude', 'commands'), { recursive: true })
      fs.chmodSync(path.join(cwd, '.claude', 'commands'), 0o500)
      const r = await createShipTemplate('P', routerFor(home, cwd))
      fs.chmodSync(path.join(cwd, '.claude', 'commands'), 0o700)
      expect(r).toMatchObject({ ok: false, reason: 'failed' })
      expect(!r.ok && r.message).toContain('commands/ship-change.md')
      expect(!r.ok && r.message).toContain('agents/implementer.md') // what it did get done
      expect(fs.existsSync(path.join(cwd, '.claude', 'ship-graph.json'))).toBe(false)
    })
  })

  describe('a new SSH project, whose folder is ~', () => {
    /** No CLAUDE_CONFIG_DIR, so the host's shell resolves both `~` and `$HOME/.claude` for itself. */
    const tilde = (home: string): ShipConfigRouter => ({ route: () => ({ kind: 'remote', remoteCwd: '~', host: 'box', runScript: hostRunner(home) }) })

    it('is refused under real sh, and nothing appears in the global config', async () => {
      const home = testTmpDir('ship-template-tilde-')
      await expect(createShipTemplate('P', tilde(home))).resolves.toEqual({ ok: false, reason: 'unsupported', message: SHIP_SHARED_CONFIG_MESSAGE })
      expect(fs.existsSync(path.join(home, '.claude'))).toBe(false)

      put(path.join(home, '.claude', 'agents', 'implementer.md'), '---\nname: implementer\n---\n')
      await expect(createShipTemplate('P', tilde(home))).resolves.toMatchObject({ reason: 'unsupported' })
      expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(['agents'])
      expect(fs.readdirSync(path.join(home, '.claude', 'agents'))).toEqual(['implementer.md'])
    })

    it('Create example is refused under real sh too, and writes nothing', async () => {
      const home = testTmpDir('ship-template-tilde-')
      await expect(createShipGraph('P', 'project', tilde(home))).resolves.toEqual({ ok: false, reason: 'unsupported', message: SHIP_SHARED_CONFIG_MESSAGE })
      expect(fs.existsSync(path.join(home, '.claude'))).toBe(false)
      fs.mkdirSync(path.join(home, '.claude'))
      await expect(createShipGraph('P', 'project', tilde(home))).resolves.toMatchObject({ reason: 'unsupported' })
      expect(fs.readdirSync(path.join(home, '.claude'))).toEqual([])
      await expect(createShipGraph('P', 'global', tilde(home))).resolves.toMatchObject({ ok: true })
    })

    it('a folder under ~ is not the home folder', async () => {
      const home = testTmpDir('ship-template-tilde-')
      fs.mkdirSync(path.join(home, 'work'))
      const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: '~/work', host: 'box', runScript: hostRunner(home) }) }
      await expect(createShipTemplate('P', router)).resolves.toMatchObject({ ok: true, created: ALL })
      expect(fs.existsSync(path.join(home, 'work', '.claude', 'ship-graph.json'))).toBe(true)
      expect(fs.existsSync(path.join(home, '.claude'))).toBe(false)
    })

    it.skipIf(cannotDenyAccess)('a host that cannot resolve the paths is refused, not written to', async () => {
      const home = testTmpDir('ship-template-tilde-')
      const cwd = path.join(home, 'proj')
      fs.mkdirSync(path.join(cwd, 'locked'), { recursive: true })
      const locked = path.join(cwd, 'locked')
      fs.chmodSync(locked, 0o000)
      const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: locked, host: 'box', runScript: hostRunner(home) }) }
      const r = await createShipTemplate('P', router)
      fs.chmodSync(locked, 0o700)
      expect(r).toMatchObject({ ok: false, reason: 'failed' })
      expect(fs.readdirSync(locked)).toEqual([])
    })
  })

  it('refuses a canvas with no folder, with the message the offer shows', async () => {
    machine()
    await expect(createShipTemplate('P', local(null))).resolves.toEqual({ ok: false, reason: 'unsupported', message: 'This canvas has no project folder.' })
  })

  it('refuses a bad id and an unsupported route', async () => {
    await expect(createShipTemplate(7, local('/tmp'))).resolves.toMatchObject({ ok: false, reason: 'unsupported' })
    await expect(createShipTemplate('P', { route: () => ({ kind: 'unsupported', reason: 'Not connected.' }) })).resolves.toEqual({ ok: false, reason: 'unsupported', message: 'Not connected.' })
  })

  it('a failed read decides nothing: no write is attempted', async () => {
    const calls: string[] = []
    const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: '/p', host: 'box', runScript: async (s) => {
      calls.push(s)
      return { code: 255, stdout: '' }
    } }) }
    await expect(createShipTemplate('P', router)).resolves.toMatchObject({ ok: false, reason: 'failed' })
    expect(calls.length).toBe(1)
  })

  it('exit 0 with no done marker is not a success', async () => {
    const { home, cwd } = machine()
    const real = hostRunner(home)
    const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: cwd, host: 'box', runScript: async (s) =>
      (s.startsWith('nt_create_ship_template') ? { code: 0, stdout: '' } : real(s)) }) }
    await expect(createShipTemplate('P', router)).resolves.toMatchObject({ ok: false, reason: 'failed' })
  })

  it('a project path with spaces and quotes is one path, on the host and in the report', async () => {
    const { home } = machine()
    const cwd = path.join(home, "it's a $HOME `x`")
    fs.mkdirSync(cwd)
    const r = await createShipTemplate('P', remote(home, cwd))
    expect(r).toMatchObject({ ok: true, root: path.join(cwd, '.claude') })
    expect(fs.existsSync(path.join(cwd, '.claude', 'ship-graph.json'))).toBe(true)
  })

  it('leaves no temp behind on the host', async () => {
    const { home, cwd } = machine()
    await createShipTemplate('P', remote(home, cwd))
    expect(fs.readdirSync(path.join(cwd, '.claude', 'agents')).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(fs.readdirSync(path.join(cwd, '.claude')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('a script cut off by a dropped channel runs nothing, at any length', async () => {
    const { home, cwd } = machine()
    const elsewhere = path.join(home, 'where-the-shell-runs')
    fs.mkdirSync(elsewhere)
    const real = hostRunner(home)
    const dir = path.join(cwd, '.claude')
    const run = (at: (whole: string) => number) =>
      createShipTemplate('P', { route: () => ({ kind: 'remote', remoteCwd: cwd, host: 'box', runScript: async (script) => {
        if (!script.startsWith('nt_create_ship_template')) return real(script)
        const out = spawnSync('sh', ['-s'], { input: script.slice(0, at(script)), cwd: elsewhere, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home } })
        return { code: out.status ?? 1, stdout: out.stdout ?? '' }
      } }) })
    let whole = ''
    await run((s) => {
      whole = s
      return 0
    })
    const last = whole.length - 'nt_create_ship_template\n'.length
    // A sample through the bodies, and every byte of the end, where the last line is what makes it run.
    const points: number[] = []
    for (let at = 1; at < last; at += 41) points.push(at)
    for (let at = last - 30; at < last + 'nt_create_ship_template'.length - 1; at++) points.push(at)
    for (const at of points) {
      const r = await run(() => at)
      const label = JSON.stringify(whole.slice(Math.max(0, at - 24), at))
      expect(r.ok, `reported success from ${label}`).toBe(false)
      expect(fs.existsSync(dir), `ran part of the script from ${label}`).toBe(false)
      expect(fs.readdirSync(elsewhere), `stray from ${label}`).toEqual([])
    }
    await expect(run((s) => s.length)).resolves.toMatchObject({ ok: true, created: ALL })
  }, 60_000)

  it('the content names nothing personal and needs nothing else installed', () => {
    for (const file of SHIP_TEMPLATE_FILES) {
      expect(file.text).not.toMatch(/mrch1ck3n|claude-graph-kit|\/home\/|~\/\.claude/)
      if (file.dir === 'agents') expect(file.text).toMatch(/\nname: /)
    }
    const stages = JSON.parse(SHIP_TEMPLATE_FILES.find((f) => !f.dir)!.text).pipelines[0].stages.map((s: { agent: string }) => s.agent)
    expect(SHIP_TEMPLATE_FILES.filter((f) => f.dir === 'agents').map((f) => (f as { name: string }).name)).toEqual(stages)
  })

  it('writes routing last, so a failure partway leaves no pipeline to draw', () => {
    expect(ALL[ALL.length - 1]).toBe('ship-graph.json')
  })

  it('a skill answers to the same /name, so it keeps the command', () => {
    const config = { agents: [], commands: [], skills: ['ship-change'], graphSource: null, projectGraphExists: false, globalGraphExists: false } as never
    expect(planShipTemplate(config).kept).toEqual(['commands/ship-change.md'])
  })
})

describe('registerShipConfigHandlers', () => {
  function platform() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const casts = new Map<string, (...a: unknown[]) => void>()
    const broadcast = vi.fn()
    return {
      handlers,
      casts,
      broadcast,
      core: {
        handle: (c: string, f: (...a: unknown[]) => unknown) => handlers.set(c, f),
        on: (c: string, f: (...a: unknown[]) => void) => casts.set(c, f),
        broadcast
      } as unknown as CorePlatform
    }
  }

  /** A host whose reads answer whatever `output` says, counting them. */
  function remoteRouter(host: { script: string; reads: number }): ShipConfigRouter {
    return {
      route: () => ({
        kind: 'remote',
        remoteCwd: '/p',
        host: 'box',
        runScript: async (script) => {
          host.reads++
          const nonce = /printf '\\n(NTSC[0-9a-f]+) home/.exec(script)![1]
          return { code: 0, stdout: `\n${nonce} home /h\n${host.script ? `\n${nonce} agent global ${host.script}.md\n---\nname: ${host.script}\n---\n` : ''}\n${nonce} end\n` }
        }
      })
    }
  }

  it('pushes only on a real change, and polls until the last lease is released', async () => {
    vi.useFakeTimers()
    const p = platform()
    const host = { script: 'first', reads: 0 }
    registerShipConfigHandlers(p.core, remoteRouter(host))
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'view-1')
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'view-2') // a second viewer shares the one poll
    await vi.advanceTimersByTimeAsync(0)
    expect(host.reads).toBe(1)

    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS)
    expect(host.reads).toBe(2)
    expect(p.broadcast).not.toHaveBeenCalled() // nothing changed

    host.script = 'second'
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS)
    expect(p.broadcast).toHaveBeenCalledTimes(1)
    expect(p.broadcast).toHaveBeenCalledWith(IPC.shipConfigChanged('P'), 'P')

    p.casts.get(IPC.shipConfigUnsubscribe)!('P', 'view-1')
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS)
    expect(host.reads).toBe(4) // one viewer left
    p.casts.get(IPC.shipConfigUnsubscribe)!('P', 'view-2')
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS * 3)
    expect(host.reads).toBe(4) // none left: silence
  })

  it('a viewer that dies without a goodbye stops the poll when its lease runs out', async () => {
    vi.useFakeTimers()
    const p = platform()
    const host = { script: 'x', reads: 0 }
    registerShipConfigHandlers(p.core, remoteRouter(host))
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'crashed') // and never another word
    await vi.advanceTimersByTimeAsync(SHIP_LEASE_MS + SHIP_POLL_REMOTE_MS)
    const atExpiry = host.reads
    expect(atExpiry).toBeGreaterThan(1)
    await vi.advanceTimersByTimeAsync(SHIP_LEASE_MS * 5)
    expect(host.reads).toBe(atExpiry)
  })

  it('a renewed lease keeps polling, through the helper both transports use', async () => {
    vi.useFakeTimers()
    const p = platform()
    const host = { script: 'x', reads: 0 }
    registerShipConfigHandlers(p.core, remoteRouter(host))
    const stop = holdShipConfigLease({
      subscribe: (id) => p.casts.get(IPC.shipConfigSubscribe)!('P', id),
      unsubscribe: (id) => p.casts.get(IPC.shipConfigUnsubscribe)!('P', id)
    })
    await vi.advanceTimersByTimeAsync(SHIP_LEASE_MS * 3)
    const before = host.reads
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS * 2)
    expect(host.reads).toBe(before + 2)
    stop()
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS * 3)
    expect(host.reads).toBe(before + 2)
  })

  it('a lapsed view that renews still hears what changed while it was gone', async () => {
    vi.useFakeTimers()
    const p = platform()
    const host = { script: 'before', reads: 0 }
    registerShipConfigHandlers(p.core, remoteRouter(host))
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'hidden')
    await vi.advanceTimersByTimeAsync(SHIP_LEASE_MS * 2)
    host.script = 'after'
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'hidden')
    await vi.advanceTimersByTimeAsync(0)
    expect(p.broadcast).toHaveBeenCalledTimes(1)
    p.casts.get(IPC.shipConfigUnsubscribe)!('P', 'hidden')
  })

  it('takes up the remote pace once an SSH master connects, instead of keeping the one it started with', async () => {
    vi.useFakeTimers()
    const p = platform()
    const host = { script: 'x', reads: 0 }
    const remote = remoteRouter(host)
    let connected = false
    registerShipConfigHandlers(p.core, {
      route: (id) => (connected ? remote.route(id) : { kind: 'unsupported', reason: 'This SSH project is not connected.' })
    })
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'view')
    await vi.advanceTimersByTimeAsync(SHIP_POLL_LOCAL_MS)
    expect(host.reads).toBe(0)

    connected = true
    await vi.advanceTimersByTimeAsync(SHIP_POLL_LOCAL_MS) // the tick already scheduled at the old pace
    expect(host.reads).toBe(1)
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS - 1)
    expect(host.reads).toBe(1) // not every 5 s
    await vi.advanceTimersByTimeAsync(1)
    expect(host.reads).toBe(2)
    p.casts.get(IPC.shipConfigUnsubscribe)!('P', 'view')
  })

  it('never reads a slow host twice at once', async () => {
    vi.useFakeTimers()
    const p = platform()
    let inFlight = 0
    let most = 0
    registerShipConfigHandlers(p.core, {
      route: () => ({
        kind: 'remote',
        remoteCwd: '/p',
        host: 'box',
        runScript: async () => {
          most = Math.max(most, ++inFlight)
          await new Promise((r) => setTimeout(r, SHIP_POLL_REMOTE_MS * 3))
          inFlight--
          return { code: 0, stdout: '' }
        }
      })
    })
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'view')
    await vi.advanceTimersByTimeAsync(SHIP_POLL_REMOTE_MS * 10)
    expect(most).toBe(1)
    p.casts.get(IPC.shipConfigUnsubscribe)!('P', 'view')
  })

  it('closing and reopening on a slow host never reads twice at once, and a stopped read changes nothing', async () => {
    vi.useFakeTimers()
    const p = platform()
    let inFlight = 0
    let most = 0
    let answer = 'first'
    const nonceOf = (s: string): string => /printf '\\n(NTSC[0-9a-f]+) home/.exec(s)![1]
    registerShipConfigHandlers(p.core, {
      route: () => ({
        kind: 'remote',
        remoteCwd: '/p',
        host: 'box',
        runScript: async (script) => {
          most = Math.max(most, ++inFlight)
          const said = answer
          await new Promise((r) => setTimeout(r, 1000))
          inFlight--
          const n = nonceOf(script)
          return { code: 0, stdout: `\n${n} home /h\n\n${n} agent global ${said}.md\n---\nname: ${said}\n---\n\n${n} end\n` }
        }
      })
    })
    const sub = p.casts.get(IPC.shipConfigSubscribe)!
    const unsub = p.casts.get(IPC.shipConfigUnsubscribe)!
    sub('P', 'a')
    unsub('P', 'a')
    sub('P', 'b')
    unsub('P', 'b')
    answer = 'second'
    sub('P', 'c')
    await vi.advanceTimersByTimeAsync(5000)
    expect(most).toBe(1)
    // The stopped reads said `first`. Had one set the signature, the live read's `second` would push.
    expect(p.broadcast).not.toHaveBeenCalled()
    unsub('P', 'c')
  })

  it('a local project polls on the shorter interval', async () => {
    vi.useFakeTimers()
    const p = platform()
    const route = vi.fn(() => ({ kind: 'unsupported' as const, reason: 'x' }))
    registerShipConfigHandlers(p.core, { route })
    p.casts.get(IPC.shipConfigSubscribe)!('P', 'view')
    await vi.advanceTimersByTimeAsync(0)
    const before = route.mock.calls.length
    await vi.advanceTimersByTimeAsync(SHIP_POLL_LOCAL_MS)
    expect(route.mock.calls.length).toBeGreaterThan(before)
    p.casts.get(IPC.shipConfigUnsubscribe)!('P', 'view')
  })

  it('ignores a subscribe with no project id', () => {
    const p = platform()
    registerShipConfigHandlers(p.core, local(null))
    expect(() => p.casts.get(IPC.shipConfigSubscribe)!(undefined, 'x')).not.toThrow()
    expect(() => p.casts.get(IPC.shipConfigSubscribe)!('P', undefined)).not.toThrow()
  })
})
