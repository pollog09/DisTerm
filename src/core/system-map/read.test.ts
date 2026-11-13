import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SYSTEM_MAP_NO_FOLDER_MESSAGE, type SystemMapResult } from '../../shared/system-map'
import { testTmpDir } from '../test-tmp'
import { parseCommitLine, parseSystemMapScriptOutput, readSystemMap, readSystemMapFull, systemMapScript, type SystemMapRouter } from './read'

const local = (cwd: string | null): SystemMapRouter => ({ route: () => ({ kind: 'local', cwd }) })

const MAP = {
  version: 1,
  title: 'Demo',
  parts: [
    { id: 'api', label: 'API', kind: 'service', files: ['src/api/**'] },
    { id: 'jobs', label: 'Jobs', kind: 'worker', files: ['jobs/**'] },
    { id: 'stripe', label: 'Stripe', kind: 'external', files: [] }
  ]
}
const MAP_TEXT = JSON.stringify(MAP, null, 2)

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-03-04T05:06:07Z', GIT_COMMITTER_DATE: '2026-03-04T05:06:07Z' }
  })
}

function repo(): string {
  const dir = testTmpDir('system-map-read-')
  git(dir, 'init', '-q')
  return dir
}

function writeMap(dir: string, text = MAP_TEXT): void {
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'system-map.json'), text)
}

function addSource(dir: string, rel: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), 'x')
}

/** Whether a folder in the test sandbox sits inside some outer git work tree (then it cannot be "not git"). */
function insideOuterRepo(dir: string): boolean {
  return spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8' }).stdout.trim() === 'true'
}

describe('readSystemMapFull, local', () => {
  it('missing', async () => {
    const dir = repo()
    await expect(readSystemMap('P', local(dir))).resolves.toEqual({ ok: true, read: { kind: 'missing' } })
  })

  it('valid with a commit: sha, ts and subject; the part with no matching file is flagged', async () => {
    const dir = repo()
    writeMap(dir)
    addSource(dir, 'src/api/server.go')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'Add the\tsystem map')
    const sha = git(dir, 'rev-parse', 'HEAD').trim()
    const out = await readSystemMapFull('P', local(dir))
    expect(out.result).toEqual({
      ok: true,
      read: {
        kind: 'valid',
        map: { ...MAP, links: [], flows: [] },
        emptyParts: ['jobs'],
        fileCheck: 'checked',
        lastCommit: { sha, ts: Date.parse('2026-03-04T05:06:07Z'), subject: 'Add the system map' }
      }
    })
    expect(out.compiled?.globs.map((g) => g.partId)).toEqual(['api', 'jobs'])
  })

  it('an untracked (not ignored) file counts for the check; an ignored one does not', async () => {
    const dir = repo()
    writeMap(dir)
    fs.writeFileSync(path.join(dir, '.gitignore'), 'jobs/\n')
    addSource(dir, 'src/api/new.go')
    addSource(dir, 'jobs/ignored.go')
    const r = await readSystemMap('P', local(dir))
    expect(r.ok && r.read.kind === 'valid' && r.read.emptyParts).toEqual(['jobs'])
  })

  it('a file that was never committed has no last commit', async () => {
    const dir = repo()
    writeMap(dir)
    addSource(dir, 'src/api/a.go')
    addSource(dir, 'jobs/a.go')
    const r = await readSystemMap('P', local(dir))
    expect(r).toMatchObject({ ok: true, read: { kind: 'valid', lastCommit: null, fileCheck: 'checked', emptyParts: [] } })
  })

  it('not a git repo: drawn, no flags, not-git', async (ctx) => {
    const dir = testTmpDir('system-map-nogit-')
    if (insideOuterRepo(dir)) ctx.skip()
    writeMap(dir)
    const r = await readSystemMap('P', local(dir))
    expect(r).toEqual({ ok: true, read: { kind: 'valid', map: { ...MAP, links: [], flows: [] }, emptyParts: [], fileCheck: 'not-git', lastCommit: null } })
  })

  it('a directory at the path is not a regular file', async () => {
    const dir = repo()
    fs.mkdirSync(path.join(dir, 'docs', 'system-map.json'), { recursive: true })
    await expect(readSystemMap('P', local(dir))).resolves.toEqual({
      ok: true,
      read: { kind: 'invalid', problems: ['docs/system-map.json is not a regular file.'], lastCommit: null }
    })
  })

  it('a FIFO at the path is refused without being opened', async (ctx) => {
    if (process.platform === 'win32') ctx.skip()
    const dir = repo()
    fs.mkdirSync(path.join(dir, 'docs'))
    const fifo = path.join(dir, 'docs', 'system-map.json')
    if (spawnSync('mkfifo', [fifo]).status !== 0) ctx.skip()
    const r = await Promise.race([readSystemMap('P', local(dir)), new Promise<string>((res) => setTimeout(() => res('hung'), 5000))])
    expect(r).toEqual({ ok: true, read: { kind: 'invalid', problems: ['docs/system-map.json is not a regular file.'], lastCommit: null } })
  })

  it('a symlink to a regular file is read', async (ctx) => {
    if (process.platform === 'win32') ctx.skip()
    const dir = repo()
    fs.writeFileSync(path.join(dir, 'real.json'), MAP_TEXT)
    fs.mkdirSync(path.join(dir, 'docs'))
    fs.symlinkSync(path.join(dir, 'real.json'), path.join(dir, 'docs', 'system-map.json'))
    const r = await readSystemMap('P', local(dir))
    expect(r.ok && r.read.kind).toBe('valid')
  })

  it('over the size limit: one problem, not parsed', async () => {
    const dir = repo()
    writeMap(dir, ' '.repeat(1_048_577))
    await expect(readSystemMap('P', local(dir))).resolves.toEqual({
      ok: true,
      read: { kind: 'invalid', problems: ['The file is 1048577 bytes; the limit is 1048576.'], lastCommit: null }
    })
  })

  it('invalid: its problems, and its last commit', async () => {
    const dir = repo()
    writeMap(dir, JSON.stringify({ ...MAP, version: 2, links: [{ from: 'api', to: 'nope' }] }))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'broken')
    const out = await readSystemMapFull('P', local(dir))
    expect(out.compiled).toBeNull()
    expect(out.result).toMatchObject({ ok: true, read: { kind: 'invalid', problems: ['version: must be 1.', 'links[0].to: "nope" is not a part.'], lastCommit: { subject: 'broken' } } })
  })

  it('the roots include the realpath when the folder is reached through a link', async (ctx) => {
    if (process.platform === 'win32') ctx.skip()
    const dir = repo()
    writeMap(dir)
    const link = path.join(testTmpDir('system-map-link-'), 'via')
    fs.symlinkSync(dir, link)
    const out = await readSystemMapFull('P', local(link))
    expect(out.roots).toEqual([link, fs.realpathSync(dir)])
    const direct = await readSystemMapFull('P', local(fs.realpathSync(dir)))
    expect(direct.roots).toEqual([fs.realpathSync(dir)])
  })

  it('no folder, no project, an unsupported route and a throwing router', async () => {
    await expect(readSystemMap('P', local(null))).resolves.toEqual({ ok: false, reason: SYSTEM_MAP_NO_FOLDER_MESSAGE })
    await expect(readSystemMap('', local('/x'))).resolves.toEqual({ ok: false, reason: 'No project.' })
    await expect(readSystemMap(7, local('/x'))).resolves.toEqual({ ok: false, reason: 'No project.' })
    await expect(readSystemMap('P', { route: () => ({ kind: 'unsupported', reason: 'This SSH project is not connected.' }) })).resolves.toEqual({
      ok: false,
      reason: 'This SSH project is not connected.'
    })
    await expect(readSystemMap('P', { route: () => { throw new Error('no such project') } })).resolves.toEqual({ ok: false, reason: expect.stringContaining('no such project') })
  })
})

/** A real POSIX sh standing in for the host at the far end of ssh (as the ship tests do). */
function hostRunner(home: string) {
  return async (script: string): Promise<{ code: number; stdout: string }> => {
    try {
      const stdout = execFileSync('sh', ['-s'], { input: script, cwd: home, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '', HOME: home } })
      return { code: 0, stdout }
    } catch (err) {
      const e = err as { status?: number; stdout?: string }
      return { code: e.status ?? 1, stdout: e.stdout ?? '' }
    }
  }
}

const remote = (remoteCwd: string, runScript: (s: string) => Promise<{ code: number; stdout: string }>): SystemMapRouter => ({
  route: () => ({ kind: 'remote', remoteCwd, host: 'box', runScript })
})

/** A fake host that answers with crafted markers under the script's own nonce. */
const crafted = (body: (n: string) => string) => async (script: string) => {
  const n = /printf '\\n(NTSC[0-9a-f]+) /.exec(script)![1]
  return { code: 0, stdout: body(n) }
}

describe('readSystemMapFull, remote through a real /bin/sh', () => {
  it('a valid map, with its commit and the file check', async () => {
    const dir = repo()
    writeMap(dir)
    addSource(dir, 'src/api/a.go')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'map')
    const out = await readSystemMapFull('P', remote(dir, hostRunner(dir)))
    expect(out.roots).toEqual([dir])
    expect(out.result).toMatchObject({ ok: true, read: { kind: 'valid', emptyParts: ['jobs'], fileCheck: 'checked', lastCommit: { subject: 'map' } } })
    expect(out.compiled).not.toBeNull()
  })

  it('a folder that is not there', async () => {
    const home = testTmpDir('system-map-host-')
    const gone = path.join(home, "no 'such' dir")
    await expect(readSystemMap('P', remote(gone, hostRunner(home)))).resolves.toEqual({ ok: false, reason: `The project folder ${gone} is not on the host.` })
  })

  it('no file', async () => {
    const dir = repo()
    await expect(readSystemMap('P', remote(dir, hostRunner(dir)))).resolves.toEqual({ ok: true, read: { kind: 'missing' } })
  })

  it('a directory at the path', async () => {
    const dir = repo()
    fs.mkdirSync(path.join(dir, 'docs', 'system-map.json'), { recursive: true })
    await expect(readSystemMap('P', remote(dir, hostRunner(dir)))).resolves.toMatchObject({ ok: true, read: { kind: 'invalid', problems: ['docs/system-map.json is not a regular file.'] } })
  })

  it('too large', async () => {
    const dir = repo()
    writeMap(dir, 'x'.repeat(1_048_577))
    await expect(readSystemMap('P', remote(dir, hostRunner(dir)))).resolves.toMatchObject({ ok: true, read: { kind: 'invalid', problems: ['The file is 1048577 bytes; the limit is 1048576.'] } })
  })

  it('not a git repo', async (ctx) => {
    const dir = testTmpDir('system-map-host-nogit-')
    if (insideOuterRepo(dir)) ctx.skip()
    writeMap(dir)
    await expect(readSystemMap('P', remote(dir, hostRunner(dir)))).resolves.toMatchObject({ ok: true, read: { kind: 'valid', fileCheck: 'not-git', emptyParts: [], lastCommit: null } })
  })

  it('the file text arrives exactly, with and without a trailing newline, and empty', async () => {
    let captured = ''
    const runner = (home: string) => async (script: string) => {
      const out = await hostRunner(home)(script)
      captured = out.stdout
      return out
    }
    for (const text of [MAP_TEXT, `${MAP_TEXT}\n`, `${MAP_TEXT}\n\n`, '']) {
      const dir = repo()
      writeMap(dir, text)
      await readSystemMapFull('P', remote(dir, runner(dir)))
      const nonce = /\n(NTSC[0-9a-f]+) done\n/.exec(captured)![1]
      const parsed = parseSystemMapScriptOutput(nonce, captured)
      expect(parsed).toMatchObject({ complete: true, folder: true, file: { text } })
    }
  })

  it('the script is one function called on its last line, and writes nothing', async () => {
    const script = systemMapScript('NTSCabc', "/p/it's here")
    expect(script.startsWith('nt_system_map() {\n')).toBe(true)
    expect(script.endsWith('}\nnt_system_map\n')).toBe(true)
    expect(script).not.toMatch(/>\s*"?\$f|\brm\b|\bmv\b|\btee\b|\bmkdir\b/)
  })
})

describe('readSystemMapFull, remote with crafted output', () => {
  const head = (n: string) => `\n${n} file\n${MAP_TEXT}\n${n} endfile\n\n${n} commit\n`

  it('nofolder, nofile, toolarge, notgit', async () => {
    await expect(readSystemMap('P', remote('/p', crafted((n) => `\n${n} nofolder\n\n${n} done\n`)))).resolves.toEqual({ ok: false, reason: 'The project folder /p is not on the host.' })
    await expect(readSystemMap('P', remote('/p', crafted((n) => `\n${n} nofile\n\n${n} commit\n\n${n} files\n\n${n} notgit\n\n${n} done\n`)))).resolves.toEqual({ ok: true, read: { kind: 'missing' } })
    await expect(readSystemMap('P', remote('/p', crafted((n) => `\n${n} toolarge 2000000\n\n${n} commit\n\n${n} files\n\n${n} notgit\n\n${n} done\n`)))).resolves.toEqual({
      ok: true,
      read: { kind: 'invalid', problems: ['The file is 2000000 bytes; the limit is 1048576.'], lastCommit: null }
    })
    await expect(readSystemMap('P', remote('/p', crafted((n) => `${head(n)}\n${n} files\n\n${n} notgit\n\n${n} done\n`)))).resolves.toMatchObject({ ok: true, read: { kind: 'valid', fileCheck: 'not-git' } })
  })

  it('the commit line and the file list', async () => {
    const r = await readSystemMap('P', remote('/p', crafted((n) => `${head(n)}${'a'.repeat(40)}\t1700000000\tAdd it\n\n${n} files\nsrc/api/a.go\n"quoted\\tname"\n\n${n} endfiles\n\n${n} done\n`)))
    expect(r).toMatchObject({ ok: true, read: { kind: 'valid', fileCheck: 'checked', emptyParts: ['jobs'], lastCommit: { sha: 'a'.repeat(40), ts: 1_700_000_000_000, subject: 'Add it' } } })
  })

  it('50 001 files listed is too many, with no flags', async () => {
    const files = Array.from({ length: 50_001 }, (_, i) => `f${i}`).join('\n')
    const r = await readSystemMap('P', remote('/p', crafted((n) => `${head(n)}\n${n} files\n${files}\n${n} endfiles\n\n${n} done\n`)))
    expect(r).toMatchObject({ ok: true, read: { kind: 'valid', fileCheck: 'too-many-files', emptyParts: [] } })
  })

  it('no done marker is a failure naming the exit code; a thrown runScript names its error', async () => {
    await expect(readSystemMap('P', remote('/p', async () => ({ code: 255, stdout: '' })))).resolves.toEqual({ ok: false, reason: "Could not read the host's system map (ssh exited 255)." })
    await expect(readSystemMap('P', remote('/p', crafted((n) => head(n))))).resolves.toEqual({ ok: false, reason: "Could not read the host's system map (ssh exited 0)." })
    await expect(readSystemMap('P', remote('/p', async () => { throw new Error('channel closed') }))).resolves.toEqual({ ok: false, reason: expect.stringMatching(/^Could not read the host's system map: .*channel closed/) })
  })

  it('markers under another nonce are not believed', async () => {
    const r: SystemMapResult = await readSystemMap('P', remote('/p', async () => ({ code: 0, stdout: '\nNTSC00 nofolder\n\nNTSC00 done\n' })))
    expect(r).toEqual({ ok: false, reason: "Could not read the host's system map (ssh exited 0)." })
  })
})

describe('parseSystemMapScriptOutput', () => {
  const n = 'NTSCtest'
  it('incomplete without done', () => {
    expect(parseSystemMapScriptOutput(n, `\n${n} nofile\n`)).toEqual({ complete: false })
  })
  it('caps the list at 50 000 and says so', () => {
    const files = Array.from({ length: 50_001 }, (_, i) => `f${i}`).join('\n')
    const r = parseSystemMapScriptOutput(n, `\n${n} nofile\n\n${n} commit\n\n${n} files\n${files}\n${n} endfiles\n\n${n} done\n`)
    expect(r).toMatchObject({ complete: true, folder: true, file: 'missing', listedOver: true })
    expect(r.complete && r.folder && r.files?.length).toBe(50_000)
  })
})

describe('parseCommitLine', () => {
  it('reads sha, seconds and subject', () => {
    expect(parseCommitLine(`${'b'.repeat(40)}\t1700000000\tFix: the\tthing`)).toEqual({ sha: 'b'.repeat(40), ts: 1_700_000_000_000, subject: 'Fix: the thing' })
    expect(parseCommitLine(`\n${'c'.repeat(40)}\t1\tx\n`)).toEqual({ sha: 'c'.repeat(40), ts: 1000, subject: 'x' })
  })
  it('cuts the subject to 120 characters', () => {
    expect(parseCommitLine(`${'d'.repeat(40)}\t1\t${'s'.repeat(300)}`)!.subject).toHaveLength(120)
  })
  it('null for empty or malformed lines', () => {
    expect(parseCommitLine('')).toBeNull()
    expect(parseCommitLine('\n\n')).toBeNull()
    expect(parseCommitLine('notasha\t1\tx')).toBeNull()
    expect(parseCommitLine(`${'e'.repeat(40)}\tsoon\tx`)).toBeNull()
    expect(parseCommitLine(`${'e'.repeat(40)} 1 x`)).toBeNull()
  })
})

describe('readSystemMapFull: an empty-parts check over budget (Revision 1)', () => {
  const COSTLY = JSON.stringify({
    version: 1,
    title: 'Costly',
    parts: Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, label: 'P', kind: 'service', files: Array.from({ length: 50 }, (_, k) => `**/*${'?'.repeat(150)}z${k}`) }))
  })

  it('local: fileCheck over-budget with no flags, and the map still drawn', async () => {
    const dir = repo()
    writeMap(dir, COSTLY)
    addSource(dir, `${'a'.repeat(250)}/${'a'.repeat(250)}/${'a'.repeat(250)}`)
    const out = await readSystemMapFull('P', local(dir))
    expect(out.result).toMatchObject({ ok: true, read: { kind: 'valid', fileCheck: 'over-budget', emptyParts: [] } })
    expect(out.compiled).not.toBeNull()
  })

  it('remote: the same for the host\'s file list', async () => {
    const files = [Array(16).fill('a'.repeat(250)).join('/')].join('\n')
    const r = await readSystemMap('P', remote('/p', crafted((n) => `\n${n} file\n${COSTLY}\n${n} endfile\n\n${n} commit\n\n${n} files\n${files}\n${n} endfiles\n\n${n} done\n`)))
    expect(r).toMatchObject({ ok: true, read: { kind: 'valid', fileCheck: 'over-budget', emptyParts: [] } })
  })
})
