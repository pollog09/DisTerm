import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import type { CorePlatform } from '../platform'
import { testTmpDir } from '../test-tmp'
import { setFrontmatterModel } from './agent-model'
import { parseAgentFile } from './discover'
import { registerShipConfigHandlers, setShipAgentModel, viaPosixSh, type ShipConfigRouter } from './handlers'

afterEach(() => vi.unstubAllEnvs())

describe('setFrontmatterModel', () => {
  const agent = '---\nname: coder\ndescription: builds it\nmodel: sonnet\ncolor: blue\n---\n\nBody text.\n'

  it('replaces the model line and keeps every other byte', () => {
    expect(setFrontmatterModel(agent, 'opus')).toBe(agent.replace('model: sonnet', 'model: opus'))
  })

  it('what it writes is what discovery reads back', () => {
    const next = setFrontmatterModel(agent, 'haiku')!
    expect(parseAgentFile('coder.md', next, 'global')).toMatchObject({ name: 'coder', model: 'haiku', color: 'blue' })
  })

  it('adds a model line before the closing marker when there is none', () => {
    const text = '---\nname: a\ndescription: >\n  folded\n  text\n---\nbody\n'
    expect(setFrontmatterModel(text, 'inherit')).toBe('---\nname: a\ndescription: >\n  folded\n  text\nmodel: inherit\n---\nbody\n')
  })

  it('keeps CRLF line endings and a BOM', () => {
    const text = '﻿---\r\nname: a\r\nmodel: "opus"\r\n---\r\nbody\r\n'
    expect(setFrontmatterModel(text, 'sonnet')).toBe('﻿---\r\nname: a\r\nmodel: sonnet\r\n---\r\nbody\r\n')
    expect(setFrontmatterModel('---\r\nname: a\r\n---\r\n', 'opus')).toBe('---\r\nname: a\r\nmodel: opus\r\n---\r\n')
  })

  it('keeps the key as written, and replaces every model key the parser would read', () => {
    expect(setFrontmatterModel('---\nModel:opus\nmodel:   haiku\n---\n', 'sonnet')).toBe('---\nModel:sonnet\nmodel:   sonnet\n---\n')
  })

  it('leaves a model line in the body alone', () => {
    const text = '---\nname: a\n---\nmodel: this is prose\n'
    expect(setFrontmatterModel(text, 'opus')).toBe('---\nname: a\nmodel: opus\n---\nmodel: this is prose\n')
  })

  it('invents nothing around a file with no frontmatter, or one never closed', () => {
    expect(setFrontmatterModel('# just markdown\nmodel: x\n', 'opus')).toBeNull()
    expect(setFrontmatterModel('---\nname: a\nmodel: x\n', 'opus')).toBeNull()
    expect(setFrontmatterModel('', 'opus')).toBeNull()
  })
})

const local = (cwd: string | null): ShipConfigRouter => ({ route: () => ({ kind: 'local', cwd }) })

function machine(): { global: string; project: string } {
  const global = testTmpDir('ship-model-g-')
  const project = testTmpDir('ship-model-p-')
  vi.stubEnv('CLAUDE_CONFIG_DIR', global)
  fs.mkdirSync(path.join(global, 'agents'))
  fs.mkdirSync(path.join(project, '.claude', 'agents'), { recursive: true })
  return { global, project }
}

describe('setShipAgentModel, on this machine', () => {
  it('rewrites the global agent file the discovery read', async () => {
    const { global, project } = machine()
    const file = path.join(global, 'agents', 'coder-file.md')
    fs.writeFileSync(file, '---\nname: coder\nmodel: sonnet\n---\nBody\n', { mode: 0o644 })
    await expect(setShipAgentModel('P', 'global', 'coder', 'opus', local(project))).resolves.toEqual({ ok: true, model: 'opus' })
    expect(fs.readFileSync(file, 'utf8')).toBe('---\nname: coder\nmodel: opus\n---\nBody\n')
    expect(fs.statSync(file).mode & 0o777).toBe(0o644)
    expect(fs.readdirSync(path.join(global, 'agents'))).toEqual(['coder-file.md'])
  })

  it('writes THROUGH a link into a shared kit, and the link stays a link', async () => {
    const { global, project } = machine()
    const kit = testTmpDir('ship-model-kit-')
    const target = path.join(kit, 'planner.md')
    fs.writeFileSync(target, '---\nname: planner\nmodel: opus\n---\n')
    const link = path.join(global, 'agents', 'planner.md')
    fs.symlinkSync(target, link)
    await expect(setShipAgentModel('P', 'global', 'planner', 'sonnet', local(project))).resolves.toMatchObject({ ok: true })
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toBe('---\nname: planner\nmodel: sonnet\n---\n')
    expect(fs.readdirSync(kit)).toEqual(['planner.md'])
  })

  it('edits the project agent, not the global one it overrides', async () => {
    const { global, project } = machine()
    fs.writeFileSync(path.join(global, 'agents', 'coder.md'), '---\nname: coder\nmodel: sonnet\n---\n')
    fs.writeFileSync(path.join(project, '.claude', 'agents', 'coder.md'), '---\nname: coder\nmodel: sonnet\n---\n')
    await expect(setShipAgentModel('P', 'project', 'coder', 'haiku', local(project))).resolves.toMatchObject({ ok: true })
    expect(fs.readFileSync(path.join(project, '.claude', 'agents', 'coder.md'), 'utf8')).toContain('model: haiku')
    expect(fs.readFileSync(path.join(global, 'agents', 'coder.md'), 'utf8')).toContain('model: sonnet')
    // The global one is hidden by the override, so the view never offers it, and the core agrees.
    await expect(setShipAgentModel('P', 'global', 'coder', 'opus', local(project))).resolves.toMatchObject({ ok: false, reason: 'missing' })
  })

  it('the same model is no write at all', async () => {
    const { global, project } = machine()
    const file = path.join(global, 'agents', 'a.md')
    fs.writeFileSync(file, '---\nname: a\nmodel: opus\n---\n')
    const before = fs.statSync(file).mtimeMs
    await expect(setShipAgentModel('P', 'global', 'a', 'opus', local(project))).resolves.toEqual({ ok: true, model: 'opus', unchanged: true })
    expect(fs.statSync(file).mtimeMs).toBe(before)
  })

  it('takes names only: an unknown model, scope, agent or a path is refused and nothing changes', async () => {
    const { global, project } = machine()
    const file = path.join(global, 'agents', 'a.md')
    fs.writeFileSync(file, '---\nname: a\nmodel: opus\n---\n')
    await expect(setShipAgentModel('P', 'global', 'a', 'gpt-5', local(project))).resolves.toMatchObject({ ok: false, reason: 'unsupported' })
    await expect(setShipAgentModel('P', 'both', 'a', 'opus', local(project))).resolves.toMatchObject({ ok: false, reason: 'unsupported' })
    await expect(setShipAgentModel('P', 'global', 'nobody', 'sonnet', local(project))).resolves.toMatchObject({ ok: false, reason: 'missing' })
    await expect(setShipAgentModel('P', 'global', '../../etc/passwd', 'sonnet', local(project))).resolves.toMatchObject({ ok: false, reason: 'missing' })
    await expect(setShipAgentModel(7, 'global', 'a', 'sonnet', local(project))).resolves.toMatchObject({ ok: false })
    await expect(setShipAgentModel('P', 'global', 'a', 'sonnet', { route: () => ({ kind: 'unsupported', reason: 'Nope.' }) })).resolves.toEqual({ ok: false, reason: 'unsupported', message: 'Nope.' })
    expect(fs.readFileSync(file, 'utf8')).toBe('---\nname: a\nmodel: opus\n---\n')
  })

  it('a file with no frontmatter is left as it is', async () => {
    const { global, project } = machine()
    const file = path.join(global, 'agents', 'plain.md')
    fs.writeFileSync(file, 'You are plain.\n')
    await expect(setShipAgentModel('P', 'global', 'plain', 'opus', local(project))).resolves.toMatchObject({ ok: false, reason: 'failed' })
    expect(fs.readFileSync(file, 'utf8')).toBe('You are plain.\n')
  })

  it('pushes a change to every view of the project once it wrote, and not when it did not', async () => {
    const { global, project } = machine()
    fs.writeFileSync(path.join(global, 'agents', 'a.md'), '---\nname: a\nmodel: opus\n---\n')
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const broadcast = vi.fn()
    const platform = { handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn), on: () => {}, broadcast } as unknown as CorePlatform
    registerShipConfigHandlers(platform, local(project))
    const call = handlers.get(IPC.shipAgentSetModel)!
    await expect(call('P', 'global', 'a', 'opus')).resolves.toMatchObject({ ok: true, unchanged: true })
    expect(broadcast).not.toHaveBeenCalled()
    await expect(call('P', 'global', 'a', 'sonnet')).resolves.toEqual({ ok: true, model: 'sonnet' })
    expect(broadcast).toHaveBeenCalledWith(IPC.shipConfigChanged('P'), 'P')
  })
})

/** A real POSIX sh standing in for the host. sshd runs a command as `<login shell> -c <command>`, so the
 *  edit's command goes through `sh -c` here exactly as production sends it. */
function host(home: string) {
  const env = { PATH: process.env.PATH ?? '', HOME: home }
  const run = (args: string[], input: string) => {
    try {
      return { code: 0, stdout: execFileSync('sh', args, { input, cwd: home, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], env }) }
    } catch (err) {
      const e = err as { status?: number; stdout?: string }
      return { code: e.status ?? 1, stdout: e.stdout ?? '' }
    }
  }
  return {
    runScript: async (script: string) => run(['-s'], script),
    runCommand: async (command: string, stdin?: string) => run(['-c', command], stdin ?? '')
  }
}

describe('viaPosixSh', () => {
  it('is one single-quoted word holding no quote and no doubled backslash, so fish and tcsh pass it as is', () => {
    const cmd = viaPosixSh(`printf '%s\\n' "$HOME" 'it''s' \\ é`)
    expect(cmd).toMatch(/^sh -c 'eval "\$\(printf %b "(\\0[0-7]{3})+"\)"'$/)
  })

  it('runs the script byte for byte under sh, with stdin left for the script', () => {
    const script = `nt_f() { cat; printf ' %s\\n' "\${1:-none}"; }\ncase x in x) nt_f 'a b é' ;; esac\n`
    const out = execFileSync('sh', ['-c', viaPosixSh(script)], { input: 'from stdin', encoding: 'utf8' })
    expect(out).toBe('from stdin a b é\n')
  })
})

describe('setShipAgentModel, on an SSH host', () => {
  it('edits the host\'s file, through its link, under real sh', async () => {
    const home = testTmpDir('ship-model-host-')
    const kit = path.join(home, 'kit')
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true })
    fs.mkdirSync(kit)
    fs.writeFileSync(path.join(kit, 'coder.md'), '---\nname: coder\nmodel: sonnet\n---\nBody\n')
    fs.symlinkSync(path.join(kit, 'coder.md'), path.join(home, '.claude', 'agents', 'coder.md'))
    const cwd = path.join(home, 'work')
    fs.mkdirSync(cwd)
    const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: cwd, host: 'box', ...host(home) }) }
    await expect(setShipAgentModel('P', 'global', 'coder', 'opus', router)).resolves.toEqual({ ok: true, model: 'opus' })
    expect(fs.readFileSync(path.join(kit, 'coder.md'), 'utf8')).toBe('---\nname: coder\nmodel: opus\n---\nBody\n')
    expect(fs.lstatSync(path.join(home, '.claude', 'agents', 'coder.md')).isSymbolicLink()).toBe(true)
  })

  it('edits a project agent on the host, in a folder with spaces', async () => {
    const home = testTmpDir('ship-model-host-')
    const cwd = path.join(home, "my 'proj'")
    fs.mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.claude', 'agents', 'tester.md'), '---\nname: tester\n---\n')
    const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: cwd, host: 'box', ...host(home) }) }
    await expect(setShipAgentModel('P', 'project', 'tester', 'haiku', router)).resolves.toEqual({ ok: true, model: 'haiku' })
    expect(fs.readFileSync(path.join(cwd, '.claude', 'agents', 'tester.md'), 'utf8')).toBe('---\nname: tester\nmodel: haiku\n---\n')
  })

  it('a route that cannot run commands says so instead of trying', async () => {
    const home = testTmpDir('ship-model-host-')
    const { runScript } = host(home)
    const router: ShipConfigRouter = { route: () => ({ kind: 'remote', remoteCwd: home, host: 'box', runScript }) }
    await expect(setShipAgentModel('P', 'global', 'a', 'opus', router)).resolves.toMatchObject({ ok: false, reason: 'unsupported' })
  })
})
