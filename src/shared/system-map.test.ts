import { describe, expect, it } from 'vitest'
import {
  SYSTEM_MAP_FILE,
  SYSTEM_MAP_FORMAT_LINES,
  SYSTEM_MAP_MAX_BYTES,
  SYSTEM_MAP_PROMPT,
  compileSystemMap,
  compileSystemMapGlob,
  matchGlobName,
  forEachSystemMapCandidate,
  matchPreparedGlob,
  matchSystemMapGlob,
  prepareSystemMapPath,
  type PreparedSystemMapPath,
  SystemMapBudgetError,
  SYSTEM_MAP_CHECK_BUDGET,
  SYSTEM_MAP_MATCH_PATH_MAX,
  parseSystemMap,
  relativeInsideRoot,
  systemMapArgsRefusal,
  systemMapEmptyParts,
  systemMapGlobProblem,
  systemMapOwner,
  type SystemMap
} from './system-map'

const part = (id: string, over: Record<string, unknown> = {}) => ({ id, label: id.toUpperCase(), kind: 'service', files: [], ...over })
const doc = (over: Record<string, unknown> = {}) => ({ version: 1, title: 'Repo', parts: [part('web', { kind: 'caller' }), part('api'), part('db', { kind: 'store' })], ...over })
const problemsOf = (value: unknown): string[] => {
  const r = parseSystemMap(typeof value === 'string' ? value : JSON.stringify(value))
  if (r.ok) throw new Error('expected problems, got a valid map')
  return r.problems
}
const mapOf = (value: unknown): SystemMap => {
  const r = parseSystemMap(JSON.stringify(value))
  if (!r.ok) throw new Error(`expected a valid map: ${r.problems.join(' | ')}`)
  return r.map
}

describe('parseSystemMap: a valid file', () => {
  it('parses to the same values, every string one-lined and trimmed', () => {
    const map = mapOf({
      version: 1,
      title: '  My\nrepo  ',
      parts: [
        { id: 'web', label: 'Web\tapp', subtitle: 'React\r\nSPA', kind: 'caller', files: ['web/**'] },
        { id: 'api', label: 'API', kind: 'service', files: ['cmd/api/', 'internal/api/**'] },
        { id: 'stripe', label: 'Stripe', kind: 'external', files: [] }
      ],
      links: [{ from: 'web', to: 'api', label: 'REST' }, { from: 'api', to: 'stripe' }],
      flows: [{ id: 'pay', name: 'Pay', group: 'Billing', steps: [{ from: 'web', to: 'api', label: 'POST /pay' }, { from: 'api', to: 'stripe', label: 'charge', mark: 'guard' }] }]
    })
    expect(map).toEqual({
      version: 1,
      title: 'My repo',
      parts: [
        { id: 'web', label: 'Web app', subtitle: 'React SPA', kind: 'caller', files: ['web/**'] },
        { id: 'api', label: 'API', kind: 'service', files: ['cmd/api/', 'internal/api/**'] },
        { id: 'stripe', label: 'Stripe', kind: 'external', files: [] }
      ],
      links: [{ from: 'web', to: 'api', label: 'REST' }, { from: 'api', to: 'stripe' }],
      flows: [{ id: 'pay', name: 'Pay', group: 'Billing', steps: [{ from: 'web', to: 'api', label: 'POST /pay' }, { from: 'api', to: 'stripe', label: 'charge', mark: 'guard' }] }]
    })
  })

  it('links and flows are optional', () => {
    const map = mapOf(doc())
    expect(map.links).toEqual([])
    expect(map.flows).toEqual([])
  })

  it('ignores unknown keys and never reads __proto__', () => {
    const text = '{"version":1,"title":"T","extra":{"a":1},"__proto__":{"parts":[{"id":"evil","label":"E","kind":"service","files":[]}]},' +
      '"parts":[{"id":"a","label":"A","kind":"service","files":[],"color":"red","__proto__":{"subtitle":"injected"}}]}'
    const r = parseSystemMap(text)
    expect(r).toEqual({ ok: true, map: { version: 1, title: 'T', parts: [{ id: 'a', label: 'A', kind: 'service', files: [] }], links: [], flows: [] } })
    expect(({} as Record<string, unknown>).parts).toBeUndefined()
  })

  it('an inherited name (toString, constructor) reads as absent, not as a value', () => {
    expect(problemsOf({ version: 1, parts: [part('a')] })).toEqual(['title: is missing.'])
    const r = parseSystemMap('{"version":1,"title":"T","parts":[{"id":"a","label":"A","kind":"constructor","files":[]}]}')
    expect(r).toEqual({ ok: false, problems: ['parts[0].kind: "constructor" is not one of caller, service, store, worker, external.'] })
  })
})

describe('parseSystemMap: each problem template', () => {
  it('bad JSON', () => {
    const p = problemsOf('{"version": 1,')
    expect(p).toHaveLength(1)
    expect(p[0]).toMatch(/^Not valid JSON: /)
    expect(p[0].length).toBeLessThanOrEqual('Not valid JSON: '.length + 200)
    expect(p[0]).not.toMatch(/\n/)
  })

  it('version', () => {
    expect(problemsOf(doc({ version: 2 }))).toEqual(['version: must be 1.'])
    expect(problemsOf(doc({ version: '1' }))).toEqual(['version: must be 1.'])
  })

  it('unknown kind', () => {
    expect(problemsOf(doc({ parts: [part('a'), part('b'), part('c', { kind: 'db' })] }))).toEqual([
      'parts[2].kind: "db" is not one of caller, service, store, worker, external.'
    ])
  })

  it('duplicate part id', () => {
    expect(problemsOf(doc({ parts: [part('api'), part('b'), part('c'), part('api')] }))).toEqual(['parts[3].id: "api" is already used by parts[0].'])
  })

  it('duplicate flow id', () => {
    const step = { from: 'web', to: 'api', label: 's' }
    expect(problemsOf(doc({ flows: [{ id: 'f', name: 'F', group: 'G', steps: [step] }, { id: 'f', name: 'F2', group: 'G', steps: [step] }] }))).toEqual([
      'flows[1].id: "f" is already used by flows[0].'
    ])
  })

  it('link to an unknown part', () => {
    const links = [{ from: 'web', to: 'api' }, { from: 'api', to: 'db' }, { from: 'web', to: 'db' }, { from: 'db', to: 'web' }, { from: 'api', to: 'cache' }]
    expect(problemsOf(doc({ links }))).toEqual(['links[4].to: "cache" is not a part.'])
  })

  it('step to an unknown part', () => {
    expect(problemsOf(doc({ flows: [{ id: 'f', name: 'F', group: 'G', steps: [{ from: 'x', to: 'api', label: 's' }] }] }))).toEqual([
      'flows[0].steps[0].from: "x" is not a part.'
    ])
  })

  it('self link and self step', () => {
    expect(problemsOf(doc({ links: [{ from: 'api', to: 'api' }] }))).toEqual(['links[0]: goes from api to itself.'])
    expect(problemsOf(doc({ flows: [{ id: 'f', name: 'F', group: 'G', steps: [{ from: 'db', to: 'db', label: 's' }] }] }))).toEqual([
      'flows[0].steps[0]: goes from db to itself.'
    ])
  })

  it('repeated link (the reverse direction is not a repeat)', () => {
    const links = [{ from: 'web', to: 'api' }, { from: 'api', to: 'web' }, { from: 'web', to: 'api', label: 'again' }]
    expect(problemsOf(doc({ links }))).toEqual(['links[2]: repeats web -> api.'])
  })

  it('missing files', () => {
    expect(problemsOf(doc({ parts: [{ id: 'a', label: 'A', kind: 'service' }] }))).toEqual(['parts[0].files: is missing.'])
  })

  it('over-long label (and the other length limits)', () => {
    expect(problemsOf(doc({ parts: [part('a', { label: 'x'.repeat(81) })] }))).toEqual(['parts[0].label: is 81 characters; the limit is 80.'])
    expect(mapOf(doc({ parts: [part('a', { label: 'x'.repeat(80) })] })).parts[0].label).toHaveLength(80)
    expect(problemsOf(doc({ title: 't'.repeat(121) }))).toEqual(['title: is 121 characters; the limit is 120.'])
    expect(problemsOf(doc({ parts: [part('a', { subtitle: 's'.repeat(81) })] }))).toEqual(['parts[0].subtitle: is 81 characters; the limit is 80.'])
    expect(problemsOf(doc({ links: [{ from: 'web', to: 'api', label: 'l'.repeat(81) }] }))).toEqual(['links[0].label: is 81 characters; the limit is 80.'])
    const flow = (over: Record<string, unknown>, step: Record<string, unknown> = {}) => ({ id: 'f', name: 'F', group: 'G', steps: [{ from: 'web', to: 'api', label: 's', ...step }], ...over })
    expect(problemsOf(doc({ flows: [flow({ name: 'n'.repeat(81) })] }))).toEqual(['flows[0].name: is 81 characters; the limit is 80.'])
    expect(problemsOf(doc({ flows: [flow({ group: 'g'.repeat(61) })] }))).toEqual(['flows[0].group: is 61 characters; the limit is 60.'])
    expect(problemsOf(doc({ flows: [flow({}, { label: 'l'.repeat(161) })] }))).toEqual(['flows[0].steps[0].label: is 161 characters; the limit is 160.'])
  })

  it('too many parts', () => {
    const parts = Array.from({ length: 230 }, (_, i) => part(`p${i}`))
    expect(problemsOf(doc({ parts }))).toEqual(['parts: 230 parts; the limit is 200.'])
    expect(mapOf(doc({ parts: parts.slice(0, 200) })).parts).toHaveLength(200)
  })

  it('total steps over 2000', () => {
    const steps = Array.from({ length: 100 }, () => ({ from: 'web', to: 'api', label: 's' }))
    const flows = Array.from({ length: 21 }, (_, i) => ({ id: `f${i}`, name: 'F', group: 'G', steps }))
    expect(problemsOf(doc({ flows }))).toEqual(['flows: 2100 steps in all; the limit is 2000.'])
    expect(mapOf(doc({ flows: flows.slice(0, 20) })).flows).toHaveLength(20)
  })

  it('more than 50 problems lists 50 and ends with …and n more problems.', () => {
    const parts = Array.from({ length: 60 }, (_, i) => part(`p${i}`, { kind: 'nope' }))
    const p = problemsOf(doc({ parts }))
    expect(p).toHaveLength(51)
    expect(p[0]).toBe('parts[0].kind: "nope" is not one of caller, service, store, worker, external.')
    expect(p[49]).toBe('parts[49].kind: "nope" is not one of caller, service, store, worker, external.')
    expect(p[50]).toBe('…and 10 more problems.')
  })

  it('exactly 50 problems are all listed, with no trailer', () => {
    const parts = Array.from({ length: 50 }, (_, i) => part(`p${i}`, { kind: 'nope' }))
    const p = problemsOf(doc({ parts }))
    expect(p).toHaveLength(50)
    expect(p.at(-1)).not.toMatch(/more problems/)
  })

  it('a file over the size limit is one problem, and is not parsed', () => {
    const text = `{"version":1,"title":"${'é'.repeat(SYSTEM_MAP_MAX_BYTES / 2)}"}`
    const bytes = new TextEncoder().encode(text).length
    expect(problemsOf(text)).toEqual([`The file is ${bytes} bytes; the limit is 1048576.`])
  })

  it('collects all problems, not just the first', () => {
    const p = problemsOf({ version: 3, parts: [part('a', { kind: 'x', files: ['/abs'] })], links: [{ from: 'a', to: 'zz' }] })
    expect(p).toEqual([
      'version: must be 1.',
      'title: is missing.',
      'parts[0].kind: "x" is not one of caller, service, store, worker, external.',
      expect.stringMatching(/^parts\[0\]\.files\[0\]: .*starts with \//),
      'links[0].to: "zz" is not a part.'
    ])
  })

  it('a bad id, a bad mark and an unsupported glob are problems at their path', () => {
    expect(problemsOf(doc({ parts: [part('-bad')] }))[0]).toMatch(/^parts\[0\]\.id: "-bad" is not a valid id/)
    expect(problemsOf(doc({ parts: [part('a'.repeat(65))] }))[0]).toMatch(/^parts\[0\]\.id: .* is not a valid id/)
    expect(mapOf(doc({ parts: [part('a'.repeat(64))] })).parts[0].id).toHaveLength(64)
    expect(problemsOf(doc({ flows: [{ id: 'f', name: 'F', group: 'G', steps: [{ from: 'web', to: 'api', label: 's', mark: 'warn' }] }] }))).toEqual([
      'flows[0].steps[0].mark: "warn" is not one of guard, refusal.'
    ])
    expect(problemsOf(doc({ parts: [part('a', { files: ['ok/**', 'src/{a,b}'] })] }))).toEqual([
      'parts[0].files[1]: "src/{a,b}": { is not supported.'
    ])
  })
})

describe('globs', () => {
  const m = (glob: string, p: string): boolean => matchSystemMapGlob(compileSystemMapGlob(glob), p, { left: 1_000_000 })

  it('src/** matches src/a and src/a/b, not src', () => {
    expect(m('src/**', 'src/a')).toBe(true)
    expect(m('src/**', 'src/a/b')).toBe(true)
    expect(m('src/**', 'src')).toBe(false)
    expect(m('src/**', 'srcx/a')).toBe(false)
  })

  it('**/x.ts matches at any depth, including the root', () => {
    expect(m('**/x.ts', 'x.ts')).toBe(true)
    expect(m('**/x.ts', 'a/x.ts')).toBe(true)
    expect(m('**/x.ts', 'a/b/x.ts')).toBe(true)
    expect(m('**/x.ts', 'a/yx.ts')).toBe(false)
  })

  it('a ** in the middle is zero or more segments', () => {
    expect(m('src/**/x.ts', 'src/x.ts')).toBe(true)
    expect(m('src/**/x.ts', 'src/a/b/x.ts')).toBe(true)
    expect(m('src/**/x.ts', 'lib/x.ts')).toBe(false)
  })

  it('two ** segments in a row are still zero or more segments (spec: every whole ** segment)', () => {
    expect.soft(m('**/**/x.ts', 'x.ts')).toBe(true)
    expect.soft(m('**/**/x.ts', 'a/x.ts')).toBe(true)
    expect.soft(m('**/**/x.ts', 'a/b/x.ts')).toBe(true)
    expect.soft(m('a/**/**/b', 'a/b')).toBe(true)
    expect.soft(m('a/**/**/b', 'a/c/b')).toBe(true)
  })

  it('src/*.ts does not cross /', () => {
    expect(m('src/*.ts', 'src/a.ts')).toBe(true)
    expect(m('src/*.ts', 'src/a/b.ts')).toBe(false)
  })

  it('? is one character, never /', () => {
    expect(m('src/?.ts', 'src/a.ts')).toBe(true)
    expect(m('src/?.ts', 'src/ab.ts')).toBe(false)
    expect(m('a?b', 'a/b')).toBe(false)
  })

  it('a literal path matches itself and what is under it, not a longer name', () => {
    expect(m('src/api', 'src/api')).toBe(true)
    expect(m('src/api', 'src/api/x')).toBe(true)
    expect(m('src/api', 'src/apix')).toBe(false)
    expect(m('src/api/', 'src/api/x')).toBe(true)
  })

  it('escapes regex characters and is case-sensitive', () => {
    expect(m('a.b+c', 'a.b+c')).toBe(true)
    expect(m('a.b+c', 'aXbbc')).toBe(false)
    expect(m('src/Api', 'src/api')).toBe(false)
    expect(m('(x)|y', '(x)|y/z')).toBe(true)
  })

  it('refuses each unsupported form', () => {
    expect(systemMapGlobProblem('')).not.toBeNull()
    expect(systemMapGlobProblem('x'.repeat(201))).toMatch(/201 characters; the limit is 200/)
    expect(systemMapGlobProblem('x'.repeat(200))).toBeNull()
    expect(systemMapGlobProblem('/src')).toMatch(/starts with \//)
    expect(systemMapGlobProblem('src\\a')).toMatch(/\\/)
    expect(systemMapGlobProblem('a//b')).toMatch(/empty segment/)
    expect(systemMapGlobProblem('./a')).toMatch(/\. or \.\. segment/)
    expect(systemMapGlobProblem('a/../b')).toMatch(/\. or \.\. segment/)
    expect(systemMapGlobProblem('a/.')).toMatch(/\. or \.\. segment/)
    for (const ch of ['{', '}', '[', ']', '!']) expect(systemMapGlobProblem(`a${ch}b`)).toMatch(/is not supported/)
    expect(systemMapGlobProblem('src/')).toBeNull()
    expect(systemMapGlobProblem('.github/**')).toBeNull()
  })
})

describe('owner and empty parts', () => {
  const compiled = compileSystemMap(
    mapOf({
      version: 1,
      title: 'T',
      parts: [
        part('auth', { files: ['src/api/auth/**'] }),
        part('api', { files: ['src/api/**'] }),
        part('db', { kind: 'store', files: ['db/**', 'schema.sql'] }),
        part('ghost', { kind: 'worker', files: ['jobs/**'] }),
        part('stripe', { kind: 'external', files: [] })
      ]
    })
  )

  it('the first matching part in file order owns a path, with the glob that matched', () => {
    expect(systemMapOwner(compiled, 'src/api/auth/login.go')).toEqual({ partId: 'auth', glob: 'src/api/auth/**' })
    expect(systemMapOwner(compiled, 'src/api/server.go')).toEqual({ partId: 'api', glob: 'src/api/**' })
    expect(systemMapOwner(compiled, 'schema.sql')).toEqual({ partId: 'db', glob: 'schema.sql' })
    expect(systemMapOwner(compiled, 'README.md')).toBeNull()
  })

  it('empty parts: globs that match no listed file, in file order; files: [] is never empty', () => {
    expect(systemMapEmptyParts(compiled, ['src/api/x.go', 'db/a.sql'])).toEqual({ emptyParts: ['auth', 'ghost'] })
    expect(systemMapEmptyParts(compiled, [])).toEqual({ emptyParts: ['auth', 'api', 'db', 'ghost'] })
    expect(systemMapEmptyParts(compiled, ['src/api/auth/a', 'schema.sql', 'jobs/x'])).toEqual({ emptyParts: [] })
  })
})

describe('relativeInsideRoot', () => {
  it('POSIX', () => {
    expect(relativeInsideRoot('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(relativeInsideRoot('/repo', '/repo//src/./a.ts')).toBe('src/a.ts')
    expect(relativeInsideRoot('/repo', '/repo/src/../lib/a.ts')).toBe('lib/a.ts')
  })

  it('a trailing slash on the root', () => {
    expect(relativeInsideRoot('/repo/', '/repo/a')).toBe('a')
  })

  it('a .. escape is not inside', () => {
    expect(relativeInsideRoot('/repo', '/repo/../etc/passwd')).toBeNull()
    expect(relativeInsideRoot('/repo', '/../../repo/a')).toBeNull()
  })

  it('not inside, a sibling with the same prefix, and the root itself', () => {
    expect(relativeInsideRoot('/repo', '/other/a')).toBeNull()
    expect(relativeInsideRoot('/repo', '/repo2/a')).toBeNull()
    expect(relativeInsideRoot('/repo', '/repo')).toBeNull()
    expect(relativeInsideRoot('/repo', '/repo/')).toBeNull()
  })

  it('POSIX compares case-sensitively', () => {
    expect(relativeInsideRoot('/Repo', '/repo/a')).toBeNull()
  })

  it('Windows: backslashes normalised, prefix compared without case, remainder keeps its case', () => {
    expect(relativeInsideRoot('C:\\Users\\me\\Repo', 'c:\\users\\ME\\repo\\Src\\A.ts')).toBe('Src/A.ts')
    expect(relativeInsideRoot('C:/Users/me/Repo', 'C:\\Users\\me\\Repo\\a')).toBe('a')
    expect(relativeInsideRoot('C:\\Repo\\', 'C:\\Repo\\a')).toBe('a')
    expect(relativeInsideRoot('C:\\Repo', 'D:\\Repo\\a')).toBeNull()
    expect(relativeInsideRoot('\\\\server\\share\\repo', '\\\\SERVER\\share\\repo\\x')).toBe('x')
  })
})

describe('systemMapArgsRefusal', () => {
  it('only --path, only with a value', () => {
    expect(systemMapArgsRefusal({})).toBeNull()
    expect(systemMapArgsRefusal({ path: 'src/a' })).toBeNull()
    expect(systemMapArgsRefusal({ x: '1' })).toBe('map: unknown flag --x')
    expect(systemMapArgsRefusal({ path: 'a', project: 'P' })).toBe('map: unknown flag --project')
    expect(systemMapArgsRefusal({ path: '' })).toBe('map: --path needs a value')
  })
})

describe('the prompt and the format', () => {
  // The launch-budget check lives in src/renderer/lib/systemMapPrompt.test.ts: promptSpill.ts is a
  // renderer module, and tsconfig.node.json (which holds src/shared) cannot import it.
  it('SYSTEM_MAP_PROMPT names the file and is one line', () => {
    expect(SYSTEM_MAP_PROMPT).toContain(SYSTEM_MAP_FILE)
    expect(SYSTEM_MAP_PROMPT).toContain('docs/system-map.json')
    expect(SYSTEM_MAP_PROMPT).not.toMatch(/\n/)
  })

  it('the format lines are two-space indented, and the example in them is a valid map once its parts exist', () => {
    for (const line of SYSTEM_MAP_FORMAT_LINES) expect(line.startsWith('  ')).toBe(true)
    const json = SYSTEM_MAP_FORMAT_LINES.slice(0, 4).join('\n').replace('"<repo name>"', '"x"')
    const parsed = JSON.parse(json) as { parts: unknown[] }
    parsed.parts.push(part('web', { kind: 'caller' }), part('db', { kind: 'store' }))
    expect(parseSystemMap(JSON.stringify(parsed)).ok).toBe(true)
  })

  it('docs/system-map.md quotes the format lines verbatim', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const text = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'system-map.md'), 'utf8')
    for (const line of SYSTEM_MAP_FORMAT_LINES) expect(text).toContain(line)
  })
})

// ---------------------------------------------------------------------------------------------------
// Revision 1: globs are matched without regexes, under a budget (review round 1, the ReDoS finding).

const big = (): { left: number } => ({ left: 1_000_000_000 })
const matches = (glob: string, p: string): boolean => matchSystemMapGlob(compileSystemMapGlob(glob), p, big())

const PARITY: Array<[string, string, boolean]> = [
  ['src/**', 'src/a', true],
  ['src/**', 'src/a/b', true],
  ['src/**', 'src', false],
  ['src/**', 'srcx/a', false],
  ['**/x.ts', 'x.ts', true],
  ['**/x.ts', 'a/b/x.ts', true],
  ['**/x.ts', 'a/yx.ts', false],
  ['src/**/x.ts', 'src/x.ts', true],
  ['src/**/x.ts', 'src/a/b/x.ts', true],
  ['src/*.ts', 'src/a.ts', true],
  ['src/*.ts', 'src/a/b.ts', false],
  ['src/?.ts', 'src/a.ts', true],
  ['src/?.ts', 'src/ab.ts', false],
  ['a?b', 'a/b', false],
  ['src/api', 'src/api', true],
  ['src/api', 'src/api/x', true],
  ['src/api', 'src/apix', false],
  ['src/api/', 'src/api/x', true],
  ['src/Api', 'src/api', false],
  ['a.b+c', 'aXbbc', false],
  ['a*b*c', 'aXbYc', true],
  ['a*b*c', 'aXbY', false],
  ['*.ts', '.ts', true],
  ['*.ts', 'a.tsx', false],
  ['**/a/**/b', 'a/b', true],
  ['**/a/**/b', 'x/a/y/b', true],
  ['**/a/**/b', 'a/c', false],
  ['a/**', 'a', false],
  ['a/**', 'a/b', true],
  ['?', '', false],
  ['a**b', 'aXYb', true],
  ['a**b', 'a/b', false],
  ['**/**/x.ts', 'x.ts', true],
  ['**/**/x.ts', 'a/b/x.ts', true],
  ['a/**/**/b', 'a/b', true],
  ['**', 'a', true],
  ['**', 'a/b/c', true],
  ['*', 'a', true],
  ['*', 'a/b', false],
  ['a*', 'a', true],
  ['*a*', 'bab', true],
  ['*a', 'ab', false]
]

describe('Revision 1: matcher parity with the glob rules', () => {
  const table = PARITY
  it.each(table)('%s against %s is %s', (glob, p, expected) => {
    expect(matches(glob, p)).toBe(expected)
  })

  it('a path that is empty, has an empty segment, or is longer than 4096 characters matches nothing', () => {
    expect(matches('**', '')).toBe(false)
    expect(matches('**', 'a//b')).toBe(false)
    expect(matches('a', 'a/')).toBe(false)
    const long = `a/${'b'.repeat(SYSTEM_MAP_MATCH_PATH_MAX)}`
    expect(matches('a', long)).toBe(false)
    expect(matches('a/**', `a/${'b'.repeat(SYSTEM_MAP_MATCH_PATH_MAX - 2)}`)).toBe(true)
  })
})

describe('Revision 1: compiling', () => {
  it('consecutive ** become one globstar; a run of * in a name becomes one *', () => {
    expect(compileSystemMapGlob('**/**/**/x.ts').tokens).toEqual([{ kind: 'globstar' }, { kind: 'name', text: 'x.ts', wild: false }])
    expect(compileSystemMapGlob('a***b').tokens).toEqual([{ kind: 'name', text: 'a*b', wild: true }])
    expect(compileSystemMapGlob('a/**/b/**').tokens.map((t) => t.kind)).toEqual(['name', 'globstar', 'name', 'globstar'])
  })

  it('literal only when there is no wildcard; the glob is kept as written; one trailing / stripped', () => {
    expect(compileSystemMapGlob('src/api/')).toEqual({ glob: 'src/api/', literal: true, tokens: [{ kind: 'name', text: 'src', wild: false }, { kind: 'name', text: 'api', wild: false }], prefix: ['src', 'api'], prefixKey: 'src/api', head: 'src' })
    expect(compileSystemMapGlob('src/*.ts').literal).toBe(false)
    expect(compileSystemMapGlob('src/?').literal).toBe(false)
    expect(compileSystemMapGlob('src/**').literal).toBe(false)
  })

  it('the glob code builds no RegExp', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(path.join(__dirname, 'system-map.ts'), 'utf8')
    const from = src.indexOf('export function compileSystemMapGlob')
    const to = src.indexOf('export function systemMapOwner')
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    expect(src.slice(from, to)).not.toMatch(/RegExp\(/)
    expect(src).not.toMatch(/new RegExp\(/)
    expect(compileSystemMapGlob('src/**')).not.toHaveProperty('re')
  })
})

describe('Revision 1: caps', () => {
  it('at most 3 * in one name, counted after runs collapse', () => {
    expect(systemMapGlobProblem('a*b*c*d')).toBeNull()
    expect(systemMapGlobProblem('*a*b*c*')).toBe('"*a*b*c*": a name may hold at most 3 *.')
    expect(systemMapGlobProblem('a***b**c*d')).toBeNull() // collapses to a*b*c*d
    expect(systemMapGlobProblem('*a*/*b*/*c*')).toBeNull() // 2 per name
    expect(systemMapGlobProblem('*a*a*a*a*a*b')).not.toBeNull()
  })

  it('at most 4 ** segments, counted after consecutive ones collapse', () => {
    expect(systemMapGlobProblem('**/a/**/b/**/c/**')).toBeNull()
    expect(systemMapGlobProblem('**/a/**/b/**/c/**/d/**')).toBe('"**/a/**/b/**/c/**/d/**" has more than 4 ** segments.')
    expect(systemMapGlobProblem(`${'**/'.repeat(10)}z`)).toBeNull()
  })

  it('more than 2000 globs in the map is one problem', () => {
    const parts = Array.from({ length: 41 }, (_, i) => part(`p${i}`, { files: Array.from({ length: 49 }, (_, k) => `d${k}/**`) }))
    // 41 × 49 = 2009
    expect(problemsOf(doc({ parts }))).toEqual(['parts: 2009 file globs in all; the limit is 2000.'])
    const ok = Array.from({ length: 40 }, (_, i) => part(`p${i}`, { files: Array.from({ length: 50 }, (_, k) => `d${k}/**`) }))
    expect(mapOf(doc({ parts: ok })).parts).toHaveLength(40)
  })

  it('51 globs in one part is a problem', () => {
    expect(problemsOf(doc({ parts: [part('a', { files: Array.from({ length: 51 }, (_, k) => `d${k}`) })] }))).toEqual(['parts[0].files: 51 globs; the limit is 50.'])
  })
})

/** 2000 legal globs whose one wild name costs ~150 × 100 steps against a 250-character name. */
const costlyParts = () =>
  Array.from({ length: 40 }, (_, i) => part(`p${i}`, { files: Array.from({ length: 50 }, (_, k) => `**/*${'?'.repeat(150)}z${k}`) }))
const LONG_NAMES_PATH = Array(16).fill('a'.repeat(250)).join('/')

describe('Revision 1: budgets', () => {
  it('matchGlobName charges every step and throws when the budget is spent', () => {
    const b = { left: 1_000 }
    expect(matchGlobName('a*b', 'aXXb', b)).toBe(true)
    expect(b.left).toBeLessThan(1_000)
    expect(() => matchGlobName('*a*a*b', 'a'.repeat(200), { left: 50 })).toThrow(SystemMapBudgetError)
    expect(() => matchGlobName('abc', 'abc', { left: 1 })).toThrow(SystemMapBudgetError)
  })

  it('matchSystemMapGlob throws through when the budget runs out', () => {
    expect(() => matchSystemMapGlob(compileSystemMapGlob('**/z'), Array(50).fill('a').join('/'), { left: 10 })).toThrow(SystemMapBudgetError)
  })

  it('systemMapOwner answers over-budget when its fixed budget runs out', () => {
    // 2000 legal globs: a ** then one name of * and 150 ?, failing on its last character, over 16 long names.
    const compiled = compileSystemMap(mapOf(doc({ parts: costlyParts() })))
    const t = performance.now()
    expect(systemMapOwner(compiled, LONG_NAMES_PATH)).toBe('over-budget')
    expect(performance.now() - t).toBeLessThan(2000)
    // A cheap map answers normally on the same path.
    expect(systemMapOwner(compileSystemMap(mapOf(doc({ parts: [part('a', { files: ['**/a*'] })] }))), LONG_NAMES_PATH)).toEqual({ partId: 'a', glob: '**/a*' })
  })

  it('systemMapEmptyParts stops testing a part at its first match and stops when none is pending', () => {
    const compiled = compileSystemMap(mapOf(doc({ parts: [part('a', { files: ['a/**'] }), part('b', { files: ['b/**'] })] })))
    // Every later file would be costly; with both parts resolved by the first two files the rest is never read.
    const files = ['a/1', 'b/1', ...Array<string>(1_000_000).fill(Array(1000).fill('x').join('/'))]
    const t = performance.now()
    expect(systemMapEmptyParts(compiled, files)).toEqual({ emptyParts: [] })
    expect(performance.now() - t).toBeLessThan(100)
  })

  it('systemMapEmptyParts over budget reports it, with no partial list', () => {
    const compiled = compileSystemMap(mapOf(doc({ parts: costlyParts() })))
    const files = Array(5_000).fill(LONG_NAMES_PATH)
    const t = performance.now()
    expect(systemMapEmptyParts(compiled, files)).toEqual({ overBudget: true })
    expect(performance.now() - t).toBeLessThan(5000)
    expect(SYSTEM_MAP_CHECK_BUDGET).toBe(60_000_000) // Revision 2 (was 20 000 000)
  })
})

describe('worst-case globs finish quickly', () => {
  const ms = (f: () => unknown): number => {
    const t = performance.now()
    f()
    return performance.now() - t
  }

  it('*a*a*a*a*a*b against 200 a, bypassing the cap', () => {
    let r: boolean | undefined
    expect(ms(() => (r = matchGlobName('*a*a*a*a*a*b', 'a'.repeat(200), { left: Infinity })))).toBeLessThan(50)
    expect(r).toBe(false)
  })

  it('ten ** then z against a 21-segment path', () => {
    let r: boolean | undefined
    expect(ms(() => (r = matchSystemMapGlob(compileSystemMapGlob(`${'**/'.repeat(10)}z`), Array(21).fill('a').join('/'), { left: Infinity })))).toBeLessThan(50)
    expect(r).toBe(false)
  })

  it('a validator-legal worst glob against a 4096-character path of one-character segments', () => {
    const glob = '**/*a?*b*/**/?*c*?/**/*?*?*/**/*x*y*z'
    expect(systemMapGlobProblem(glob)).toBeNull()
    const p = Array(2048).fill('a').join('/').slice(0, 4095)
    expect(ms(() => matchSystemMapGlob(compileSystemMapGlob(glob), p, { left: Infinity }))).toBeLessThan(100)
  })

  it('a 200-character name of ? against a long name', () => {
    expect(ms(() => matchGlobName('?'.repeat(200), 'a'.repeat(4000), { left: Infinity }))).toBeLessThan(50)
  })

  const worstParts = () => {
    const glob = (k: number) => `**/*a*b*c/**/?${k}*?*/**/*q*r*s?/**/*${'?'.repeat(150)}`
    return Array.from({ length: 200 }, (_, i) => part(`p${i}`, { files: Array.from({ length: 10 }, (_, k) => glob(k)) }))
  }

  it('the empty-parts check with 2000 worst-case legal globs and 50 000 names of 40 characters', () => {
    const compiled = compileSystemMap(mapOf(doc({ parts: worstParts() })))
    const files = Array.from({ length: 50_000 }, (_, i) => `src/dir${i % 97}/${String(i).padStart(30, 'f')}.ts`.slice(0, 40))
    expect(ms(() => systemMapEmptyParts(compiled, files))).toBeLessThan(3000)
  })

  it('an honest map (200 parts, src/<part>/**) over 50 000 files is checked in full, quickly', () => {
    const parts = Array.from({ length: 200 }, (_, i) => part(`p${i}`, { files: [`src/p${i}/**`] }))
    const compiled = compileSystemMap(mapOf(doc({ parts })))
    const files = Array.from({ length: 50_000 }, (_, i) => `src/p${i % 199}/file${i}.ts`)
    let r: unknown
    expect(ms(() => (r = systemMapEmptyParts(compiled, files)))).toBeLessThan(1000)
    expect(r).toEqual({ emptyParts: ['p199'] })
  })

  it('an owner lookup with the same 2000 globs against a 4096-character path', () => {
    const compiled = compileSystemMap(mapOf(doc({ parts: worstParts() })))
    const p = Array(2048).fill('a').join('/').slice(0, 4095)
    expect(ms(() => systemMapOwner(compiled, p))).toBeLessThan(500)
  })

  // Found while testing, beyond the spec's list: work the matcher does NOT charge. A name token is
  // tried at every path position (an array of P + 1 is built and walked) even when no position is
  // reachable any more, and only the positions it actually matches are charged. A glob of many plain
  // names that fails on its first name therefore costs ~tokens × segments per path while charging 1.
  const uncharged = () => {
    // 200 chars, legal: one wild first name, then 99 plain names.
    const glob = (k: number) => `${k}?/${Array(99).fill('a').join('/')}`
    return compileSystemMap(mapOf(doc({ parts: Array.from({ length: 200 }, (_, i) => part(`p${i}`, { files: Array.from({ length: 10 }, (_, k) => glob(k)) })) })))
  }

  it('an owner lookup that fails on the first name of 2000 long legal globs, against a 4095-character path', () => {
    const p = Array(2048).fill('x').join('/').slice(0, 4095)
    expect(ms(() => systemMapOwner(uncharged(), p))).toBeLessThan(500)
  })

  it('the empty-parts check over 20 files of 500 characters with those globs (budget-bounded or quick)', () => {
    const compiled = uncharged()
    const files = Array(20).fill(Array(250).fill('x').join('/'))
    expect(ms(() => systemMapEmptyParts(compiled, files))).toBeLessThan(1000)
  })

  // Round 4, more adversarial shapes against the budget (each runs until a result or the budget trips).
  const fortyBy50 = (glob: (i: number, k: number) => string) =>
    compileSystemMap(mapOf(doc({ parts: Array.from({ length: 40 }, (_, i) => part(`p${i}`, { files: Array.from({ length: 50 }, (_, k) => glob(i, k)) })) })))

  // Round 4 shape A. Revision 2's head buckets make it cheap: no literal head equals the file's one segment,
  // so each file costs its split and one bucket lookup, and the check runs in full (every part empty).
  it('2000 short literal globs against 4000 one-segment names of 4096 characters (head buckets: checked in full)', () => {
    const compiled = fortyBy50((i, k) => `z${i}x${k}`)
    let r: unknown
    expect(ms(() => (r = systemMapEmptyParts(compiled, Array(4000).fill('a'.repeat(4096)))))).toBeLessThan(3000)
    expect(r).toEqual({ emptyParts: Array.from({ length: 40 }, (_, i) => `p${i}`) })
    expect(ms(() => systemMapOwner(compiled, 'a'.repeat(4096)))).toBeLessThan(500)
  })

  // Shape A again, with grouping defeated: every glob is head-less (wildcard-led), so all 2000 are tried
  // on every file, each against a 4096-character name.
  it('2000 wildcard-led globs against 4000 one-segment names of 4096 characters: bounded, over budget', () => {
    const compiled = fortyBy50((i, k) => `*z${i}x${k}`)
    let r: unknown
    expect(ms(() => (r = systemMapEmptyParts(compiled, Array(4000).fill('a'.repeat(4096)))))).toBeLessThan(3000)
    expect(r).toEqual({ overBudget: true })
    let o: unknown
    expect(ms(() => (o = systemMapOwner(compiled, 'a'.repeat(4096))))).toBeLessThan(500)
    expect(o).toBe('over-budget')
  })

  // And with every glob in the same head bucket as every file: grouping selects all 2000.
  it('2000 globs sharing the files\' head folder, against 4000 names of 4000 characters under it: bounded, over budget', () => {
    const compiled = fortyBy50((i, k) => `a/*z${i}x${k}`)
    const file = `a/${'b'.repeat(4000)}`
    let r: unknown
    expect(ms(() => (r = systemMapEmptyParts(compiled, Array(4000).fill(file))))).toBeLessThan(3000)
    expect(r).toEqual({ overBudget: true })
    expect(ms(() => systemMapOwner(compiled, file))).toBeLessThan(500)
  })

  it('2000 globs of non-last ** with plain names against 2048-segment paths', () => {
    const compiled = fortyBy50((_i, k) => `**/a/**/a/**/a/**/b${k}`)
    const p = Array(2048).fill('a').join('/').slice(0, 4095)
    expect(ms(() => systemMapOwner(compiled, p))).toBeLessThan(500)
    expect(ms(() => systemMapEmptyParts(compiled, Array(5000).fill(p)))).toBeLessThan(3000)
  })

  it('2000 globs with a long nearly-literal wild name against long names', () => {
    const compiled = fortyBy50((_i, k) => `**/${'a'.repeat(190)}?${k}`)
    const p = Array(16).fill('a'.repeat(250)).join('/')
    expect(ms(() => systemMapOwner(compiled, p))).toBeLessThan(500)
    expect(ms(() => systemMapEmptyParts(compiled, Array(5000).fill(p)))).toBeLessThan(3000)
  })

  it('2000 literal globs against 2048-segment paths', () => {
    const compiled = fortyBy50((i, k) => `a/a/a/z${i}x${k}`)
    const p = Array(2048).fill('a').join('/').slice(0, 4095)
    expect(ms(() => systemMapOwner(compiled, p))).toBeLessThan(500)
    expect(ms(() => systemMapEmptyParts(compiled, Array(5000).fill(p)))).toBeLessThan(3000)
  })
})

// ---------------------------------------------------------------------------------------------------
// Revision 2: a stale honest map is checked in full (review round 2).

describe('a stale honest map is checked in full', () => {
  const ms = (f: () => unknown): number => {
    const t = performance.now()
    f()
    return performance.now() - t
  }
  /** 50 000 files of 5 segments spread over the live part ids. */
  const filesOver = (live: string[]): string[] => Array.from({ length: 50_000 }, (_, i) => `src/${live[i % live.length]}/d${i % 7}/e/f${i}.ts`)
  const check = (parts: ReturnType<typeof part>[], live: string[]) => {
    const compiled = compileSystemMap(mapOf(doc({ parts })))
    const files = filesOver(live)
    let r: unknown
    const took = ms(() => (r = systemMapEmptyParts(compiled, files)))
    return { r, took }
  }

  it('150 live parts and 50 stale x<i>/** parts, interleaved: exactly the stale ids, in file order', () => {
    const parts = Array.from({ length: 200 }, (_, i) => (i % 4 === 3 ? part(`s${i}`, { files: [`x${i}/**`] }) : part(`p${i}`, { files: [`src/p${i}/**`] })))
    const live = parts.filter((p) => p.id.startsWith('p')).map((p) => p.id)
    const { r, took } = check(parts, live)
    expect(r).toEqual({ emptyParts: parts.filter((p) => p.id.startsWith('s')).map((p) => p.id) })
    expect(took).toBeLessThan(1000)
  })

  it("the reviewer's repro: 20 stale parts with one gone<i>/** each", () => {
    const parts = [...Array.from({ length: 180 }, (_, i) => part(`p${i}`, { files: [`src/p${i}/**`] })), ...Array.from({ length: 20 }, (_, i) => part(`g${i}`, { files: [`gone${i}/**`] }))]
    const { r, took } = check(parts, parts.slice(0, 180).map((p) => p.id))
    expect(r).toEqual({ emptyParts: Array.from({ length: 20 }, (_, i) => `g${i}`) })
    expect(took).toBeLessThan(1000)
  })

  it("the reviewer's repro: 5 stale parts with 5 gone<i>-<k>/** globs each", () => {
    const parts = [...Array.from({ length: 195 }, (_, i) => part(`p${i}`, { files: [`src/p${i}/**`] })), ...Array.from({ length: 5 }, (_, i) => part(`g${i}`, { files: Array.from({ length: 5 }, (_, k) => `gone${i}-${k}/**`) }))]
    const { r, took } = check(parts, parts.slice(0, 195).map((p) => p.id))
    expect(r).toEqual({ emptyParts: Array.from({ length: 5 }, (_, i) => `g${i}`) })
    expect(took).toBeLessThan(1000)
  })

  it('180 live parts and 20 stale parts whose globs start with a wildcard (**/*.gone<i>)', () => {
    const parts = [...Array.from({ length: 180 }, (_, i) => part(`p${i}`, { files: [`src/p${i}/**`] })), ...Array.from({ length: 20 }, (_, i) => part(`w${i}`, { files: [`**/*.gone${i}`] }))]
    const { r, took } = check(parts, parts.slice(0, 180).map((p) => p.id))
    expect(r).toEqual({ emptyParts: Array.from({ length: 20 }, (_, i) => `w${i}`) })
    expect(took).toBeLessThan(1000)
  })

  it('the stated guarantee at its edge: 130 live, 50 stale literal-head parts with up to 50 globs, and 20 stale wildcard-led ones', () => {
    const parts = [
      ...Array.from({ length: 130 }, (_, i) => part(`p${i}`, { files: [`src/p${i}/**`] })),
      ...Array.from({ length: 50 }, (_, i) => part(`g${i}`, { files: Array.from({ length: i < 30 ? 30 : 1 }, (_, k) => `gone${i}-${k}/**`) })),
      ...Array.from({ length: 20 }, (_, i) => part(`w${i}`, { files: [`**/*.gone${i}`] }))
    ]
    const { r, took } = check(parts, parts.slice(0, 130).map((p) => p.id))
    expect(r).toEqual({ emptyParts: [...Array.from({ length: 50 }, (_, i) => `g${i}`), ...Array.from({ length: 20 }, (_, i) => `w${i}`)] })
    expect(took).toBeLessThan(1000)
  })

  it('paths of 8 segments are inside the guarantee too', () => {
    const parts = [...Array.from({ length: 180 }, (_, i) => part(`p${i}`, { files: [`src/p${i}/**`] })), ...Array.from({ length: 20 }, (_, i) => part(`w${i}`, { files: [`**/*.gone${i}`] }))]
    const compiled = compileSystemMap(mapOf(doc({ parts })))
    const files = Array.from({ length: 50_000 }, (_, i) => `src/p${i % 180}/a/b/c/d/e/f${i}.ts`)
    let r: unknown
    expect(ms(() => (r = systemMapEmptyParts(compiled, files)))).toBeLessThan(1000)
    expect(r).toEqual({ emptyParts: Array.from({ length: 20 }, (_, i) => `w${i}`) })
  })
})

describe('Revision 2: prepared paths, budget accounting and the zero invariant', () => {
  const zero = (p: PreparedSystemMapPath): boolean => p.reach.every((v) => v === 0) && p.next.every((v) => v === 0)

  it('100 x<i>/** globs against one prepared 5-segment path cost at most 100 * 2 + 3 * 6 steps, preparation included', () => {
    const budget = { left: 1_000_000 }
    const before = budget.left
    const p = prepareSystemMapPath('src/a/b/c/d.ts', budget)!
    for (let i = 0; i < 100; i++) expect(matchPreparedGlob(compileSystemMapGlob(`x${i}/**`), p, budget)).toBe(false)
    expect(before - budget.left).toBeLessThanOrEqual(100 * 2 + 3 * 6)
    expect(zero(p)).toBe(true)
  })

  it('preparing with a long enough scratch charges only P + 1 and reuses its arrays; a short one allocates', () => {
    const scratch = prepareSystemMapPath('a/b/c/d/e/f/g/h', { left: 1000 })!
    const budget = { left: 1000 }
    const p = prepareSystemMapPath('x/y/z', budget, scratch)!
    expect(1000 - budget.left).toBe(4)
    expect(p.reach).toBe(scratch.reach)
    expect(p.next).toBe(scratch.next)
    expect(p.segments).toEqual(['x', 'y', 'z'])
    const b2 = { left: 1000 }
    const small = prepareSystemMapPath('x', { left: 1000 })!
    const big = prepareSystemMapPath('a/b/c/d', b2, small)!
    expect(big.reach).not.toBe(small.reach)
    expect(1000 - b2.left).toBe(5 + 2 * 5)
    expect(big.reach.length).toBeGreaterThanOrEqual(5)
  })

  it('null for an empty, over-long or empty-segment path', () => {
    expect(prepareSystemMapPath('', { left: 100 })).toBeNull()
    expect(prepareSystemMapPath('a//b', { left: 100 })).toBeNull()
    expect(prepareSystemMapPath('x'.repeat(SYSTEM_MAP_MATCH_PATH_MAX + 1), { left: 100 })).toBeNull()
  })

  it('both arrays are all zero after true and after each early false (head reject, no name match, trailing **)', () => {
    const scratch = prepareSystemMapPath(Array(40).fill('a').join('/'), { left: 1000 })!
    const run = (glob: string, path: string, left = 1_000_000) => matchPreparedGlob(compileSystemMapGlob(glob), prepareSystemMapPath(path, { left: 1000 }, scratch)!, { left })
    expect(run('src/**', 'src/a/b')).toBe(true)
    expect(zero(scratch)).toBe(true)
    expect(run('lib/**', 'src/a')).toBe(false) // head reject
    expect(zero(scratch)).toBe(true)
    expect(run('**/q/x', 'a/b/c')).toBe(false) // a name with no match
    expect(zero(scratch)).toBe(true)
    expect(run('src/a/**', 'src/a')).toBe(false) // trailing ** needs one more segment
    expect(zero(scratch)).toBe(true)
  })

  it('a budget error mid-match leaves the arrays zero, and the scratch then answers the whole parity table', () => {
    const scratch = prepareSystemMapPath(Array(40).fill('a').join('/'), { left: 1000 })!
    const p = prepareSystemMapPath('abababab/ababab/abab/ab/q/r/s', { left: 1000 }, scratch)!
    expect(() => matchPreparedGlob(compileSystemMapGlob('**/*a*b*/**/*z'), p, { left: 12 })).toThrow(SystemMapBudgetError)
    expect(zero(scratch)).toBe(true)
    for (const [glob, path, expected] of PARITY) {
      const prepared = prepareSystemMapPath(path, { left: 100_000 }, scratch)
      const got = prepared ? matchPreparedGlob(compileSystemMapGlob(glob), prepared, { left: 100_000 }) : false
      expect(got, `${glob} against ${path}`).toBe(expected)
      expect(zero(scratch), `${glob} against ${path}`).toBe(true)
    }
  })

  it('parity: matchSystemMapGlob and one shared prepared path per path string agree on every row', () => {
    const byPath = new Map<string, PreparedSystemMapPath | null>()
    for (const [glob, path, expected] of PARITY) {
      if (!byPath.has(path)) byPath.set(path, prepareSystemMapPath(path, { left: 100_000 }))
      const prepared = byPath.get(path)!
      const viaPrepared = prepared ? matchPreparedGlob(compileSystemMapGlob(glob), prepared, { left: 100_000 }) : false
      const viaWrapper = matchSystemMapGlob(compileSystemMapGlob(glob), path, { left: 100_000 })
      expect([viaPrepared, viaWrapper], `${glob} against ${path}`).toEqual([expected, expected])
    }
  })

  it('head: a literal first name, else null', () => {
    expect(compileSystemMapGlob('src/**').head).toBe('src')
    expect(compileSystemMapGlob('src').head).toBe('src')
    expect(compileSystemMapGlob('**/x').head).toBeNull()
    expect(compileSystemMapGlob('s*c/x').head).toBeNull()
    expect(compileSystemMapGlob('?/x').head).toBeNull()
  })

  it('systemMapOwner keeps the file order when an earlier head-less glob and a later headed glob both match', () => {
    const compiled = compileSystemMap(mapOf(doc({ parts: [part('any', { files: ['**/*.go'] }), part('api', { files: ['src/api/**'] })] })))
    expect(systemMapOwner(compiled, 'src/api/x.go')).toEqual({ partId: 'any', glob: '**/*.go' })
    const flipped = compileSystemMap(mapOf(doc({ parts: [part('api', { files: ['src/api/**'] }), part('any', { files: ['**/*.go'] })] })))
    expect(systemMapOwner(flipped, 'src/api/x.go')).toEqual({ partId: 'api', glob: 'src/api/**' })
  })

  it('the empty-parts check mixes buckets and head-less globs correctly', () => {
    const compiled = compileSystemMap(
      mapOf(doc({ parts: [part('a', { files: ['src/a/**'] }), part('b', { files: ['**/*.b'] }), part('c', { files: ['lib/**', '**/*.c'] }), part('d', { files: ['docs'] })] }))
    )
    expect(systemMapEmptyParts(compiled, ['src/a/1', 'x/y.c', 'docs/z'])).toEqual({ emptyParts: ['b'] })
    expect(systemMapEmptyParts(compiled, ['docs', 'q/r.b'])).toEqual({ emptyParts: ['a', 'c'] })
    expect(systemMapEmptyParts(compiled, ['', 'a//b'])).toEqual({ emptyParts: ['a', 'b', 'c', 'd'] })
  })
})

// ---------------------------------------------------------------------------------------------------
// Revision 3: shared first folders, files in git ls-files order (review round 3). Every case here keeps
// all globs under one shared first folder (`src/`) and sorts the files the way `git ls-files` prints them,
// so a part stays pending until its own folder comes up: the case the round-robin tests above missed.

describe('shared first folders, files in git ls-files order', () => {
  const ms = (f: () => unknown): number => {
    const t = performance.now()
    f()
    return performance.now() - t
  }
  /** 50 000 five-segment paths src/<folder>/d<k>/e<k>/f<i>.ts over the folders, in git (byte) order. */
  const sortedFiles = (folders: readonly string[]): string[] =>
    Array.from({ length: 50_000 }, (_, i) => {
      const k = i % 5
      return `src/${folders[i % folders.length]}/d${k}/e${k}/f${i}.ts`
    }).sort()
  const run = (parts: ReturnType<typeof part>[], folders: readonly string[]) => {
    const compiled = compileSystemMap(mapOf(doc({ parts })))
    const files = sortedFiles(folders)
    let r: unknown
    const took = ms(() => (r = systemMapEmptyParts(compiled, files)))
    return { r, took }
  }
  const pad = (n: number) => String(n).padStart(3, '0')
  const SUFFIX = ['a', 'b', 'c', 'd', 'e', 'f']
  /** A live part with `n` globs src/p<NNN><k>/**; all its folders get files. */
  const livePart = (i: number, n: number) => part(`p${pad(i)}`, { files: SUFFIX.slice(0, n).map((k) => `src/p${pad(i)}${k}/**`) })
  const liveFolders = (count: number, n: number) => Array.from({ length: count }, (_, i) => SUFFIX.slice(0, n).map((k) => `p${pad(i)}${k}`)).flat()

  it('the files really are in git order, and every glob is under the same first folder', () => {
    const files = sortedFiles(liveFolders(3, 2))
    expect(files[0] < files[1]).toBe(true)
    expect(files.every((f) => f.startsWith('src/'))).toBe(true)
    expect(files[0].split('/')[1]).toBe('p000a')
    expect(files.at(-1)!.split('/')[1]).toBe('p002b')
  })

  it('150 live parts × 3 globs + 50 stale src/gone<N>/** parts, interleaved: exactly the 50 stale ids, in file order', () => {
    const parts = Array.from({ length: 200 }, (_, i) => (i % 4 === 1 ? part(`gone${pad(i)}`, { files: [`src/gone${pad(i)}/**`] }) : livePart(i, 3)))
    const live = parts.filter((p) => p.id.startsWith('p')).map((p) => Number(p.id.slice(1)))
    const folders = live.flatMap((i) => SUFFIX.slice(0, 3).map((k) => `p${pad(i)}${k}`))
    const { r, took } = run(parts, folders)
    expect(r).toEqual({ emptyParts: parts.filter((p) => p.id.startsWith('gone')).map((p) => p.id) })
    expect(took).toBeLessThan(1000)
  })

  it.each([
    [150, 3],
    [200, 2],
    [100, 6]
  ])("the reviewer's all-live repro: %i parts × %i src/…/** globs over sorted files is checked in full", (count, n) => {
    const parts = Array.from({ length: count }, (_, i) => livePart(i, n))
    const { r, took } = run(parts, liveFolders(count, n))
    expect(r).toEqual({ emptyParts: [] })
    expect(took).toBeLessThan(1000)
  })

  it('200 parts × 6 globs, all under src/, the maximum honest map, is checked in full', () => {
    const parts = Array.from({ length: 200 }, (_, i) => livePart(i, 6))
    const { r, took } = run(parts, liveFolders(200, 6))
    expect(r).toEqual({ emptyParts: [] })
    expect(took).toBeLessThan(1000)
  })

  it('150 live parts + 50 stale parts × 4 src/gone<N>-<k>/** globs: lists the 50', () => {
    const parts = [...Array.from({ length: 150 }, (_, i) => livePart(i, 3)), ...Array.from({ length: 50 }, (_, i) => part(`gone${pad(i)}`, { files: [0, 1, 2, 3].map((k) => `src/gone${pad(i)}-${k}/**`) }))]
    const { r, took } = run(parts, liveFolders(150, 3))
    expect(r).toEqual({ emptyParts: Array.from({ length: 50 }, (_, i) => `gone${pad(i)}`) })
    expect(took).toBeLessThan(1000)
  })

  it.each([['src/**/*.gone'], ['**/*.gone']])('180 live parts + 20 stale parts with %s<N>: lists exactly the 20', (lead) => {
    const parts = [...Array.from({ length: 180 }, (_, i) => livePart(i, 1)), ...Array.from({ length: 20 }, (_, i) => part(`w${pad(i)}`, { files: [`${lead}${i}`] }))]
    const { r, took } = run(parts, liveFolders(180, 1))
    expect(r).toEqual({ emptyParts: Array.from({ length: 20 }, (_, i) => `w${pad(i)}`) })
    expect(took).toBeLessThan(1000)
  })

  it('literal folder globs: 100 live src/l<N> + 20 stale src/none<N>: lists the 20', () => {
    const parts = [...Array.from({ length: 100 }, (_, i) => part(`l${pad(i)}`, { files: [`src/l${pad(i)}`] })), ...Array.from({ length: 20 }, (_, i) => part(`none${pad(i)}`, { files: [`src/none${pad(i)}`] }))]
    const { r, took } = run(parts, Array.from({ length: 100 }, (_, i) => `l${pad(i)}`))
    expect(r).toEqual({ emptyParts: Array.from({ length: 20 }, (_, i) => `none${pad(i)}`) })
    expect(took).toBeLessThan(1000)
  })

  // The coder's table said "180 parts + 20 stale wildcard-led -> 50 flagged". That only adds up when 30 of
  // the 180 are stale too: 150 live + 30 stale literal-prefix + 20 stale wildcard-led = 50 stale. Pinned
  // with the exact ids, in file order, both wildcard forms mixed.
  it('150 live + 30 stale literal-prefix parts + 20 stale wildcard-led parts: exactly those 50 ids, in file order', () => {
    const live = Array.from({ length: 150 }, (_, i) => livePart(i, 3))
    const staleLiteral = Array.from({ length: 30 }, (_, i) => part(`old${pad(i)}`, { files: [`src/old${pad(i)}/**`, `src/old${pad(i)}x`] }))
    const staleWild = Array.from({ length: 20 }, (_, i) => part(`w${pad(i)}`, { files: [i % 2 ? `**/*.gone${i}` : `src/**/*.gone${i}`] }))
    const parts = [...live.slice(0, 75), ...staleLiteral, ...live.slice(75), ...staleWild]
    const { r, took } = run(parts, liveFolders(150, 3))
    expect(r).toEqual({ emptyParts: [...staleLiteral.map((p) => p.id), ...staleWild.map((p) => p.id)] })
    expect((r as { emptyParts: string[] }).emptyParts).toHaveLength(50)
    expect(took).toBeLessThan(1000)
  })
})

describe('Revision 3: the literal-prefix index', () => {
  it('prefix and prefixKey', () => {
    expect(compileSystemMapGlob('src/api/**').prefix).toEqual(['src', 'api'])
    expect(compileSystemMapGlob('src/api/**').prefixKey).toBe('src/api')
    expect(compileSystemMapGlob('src/*.ts').prefix).toEqual(['src'])
    expect(compileSystemMapGlob('**/x').prefix).toEqual([])
    expect(compileSystemMapGlob('**/x').prefixKey).toBe('')
    expect(compileSystemMapGlob('README.md').prefix).toEqual(['README.md'])
    expect(compileSystemMapGlob('src/a/b/').prefix).toEqual(['src', 'a', 'b'])
    expect(compileSystemMapGlob('src/a/**/b').prefix).toEqual(['src', 'a'])
    expect(compileSystemMapGlob('src/a?/b').prefix).toEqual(['src'])
    expect(compileSystemMapGlob('src/a?/b').head).toBe('src')
  })

  const INDEX_MAP = () =>
    compileSystemMap(
      mapOf(
        doc({
          parts: [
            part('all', { files: ['src/**', 'lib/**'] }),
            part('api', { files: ['src/api/**', 'src/api/x.ts'] }),
            part('apix', { files: ['src/apix/**', 'src/a*/**'] }),
            part('ts', { files: ['**/*.ts'] }),
            part('doc', { files: ['README.md', 'src/api/x.ts/deeper'] })
          ]
        })
      )
    )

  it('compileSystemMap buckets each glob by its prefix, in ascending order, with wildLed and maxPrefix', () => {
    const c = INDEX_MAP()
    const view = Object.fromEntries([...c.byPrefix].map(([k, list]) => [k, list.map((g) => [g.order, g.partId, g.glob.glob])]))
    expect(view).toEqual({
      src: [[0, 'all', 'src/**'], [5, 'apix', 'src/a*/**']],
      lib: [[1, 'all', 'lib/**']],
      'src/api': [[2, 'api', 'src/api/**']],
      'src/api/x.ts': [[3, 'api', 'src/api/x.ts']],
      'src/apix': [[4, 'apix', 'src/apix/**']],
      'README.md': [[7, 'doc', 'README.md']],
      'src/api/x.ts/deeper': [[8, 'doc', 'src/api/x.ts/deeper']]
    })
    expect(c.wildLed.map((g) => [g.order, g.glob.glob])).toEqual([[6, '**/*.ts']])
    expect(c.maxPrefix).toBe(4)
  })

  it('forEachSystemMapCandidate on src/api/x.ts visits the src, src/api and src/api/x.ts buckets, then wildLed, nothing else', () => {
    const c = INDEX_MAP()
    const seen: Array<[string, boolean]> = []
    forEachSystemMapCandidate(c.byPrefix, c.wildLed, c.maxPrefix, prepareSystemMapPath('src/api/x.ts', { left: 1000 })!, { left: 1000 }, (g, at) => seen.push([g.glob.glob, at]))
    expect(seen).toEqual([
      ['src/**', true],
      ['src/a*/**', true],
      ['src/api/**', true],
      ['src/api/x.ts', true],
      ['**/*.ts', false]
    ])
  })

  it('a file outside every prefix sees only wildLed', () => {
    const c = INDEX_MAP()
    const seen: string[] = []
    forEachSystemMapCandidate(c.byPrefix, c.wildLed, c.maxPrefix, prepareSystemMapPath('tools/x.ts', { left: 1000 })!, { left: 1000 }, (g) => seen.push(g.glob.glob))
    expect(seen).toEqual(['**/*.ts'])
  })

  it('a literal glob longer than the file is not a candidate match; one equal to it is', () => {
    const c = INDEX_MAP()
    expect(systemMapOwner(c, 'src/api/x.ts')).toEqual({ partId: 'all', glob: 'src/**' })
    expect(systemMapOwner(c, 'README.md')).toEqual({ partId: 'doc', glob: 'README.md' })
    expect(systemMapOwner(c, 'README.md/sub')).toEqual({ partId: 'doc', glob: 'README.md' })
    expect(systemMapOwner(c, 'READMEmd')).toBeNull()
    // src/a*/** (apix) matches both files; doc's longer literal only the second.
    expect(systemMapEmptyParts(c, ['src/api/x.ts'])).toEqual({ emptyParts: ['doc'] })
    expect(systemMapEmptyParts(c, ['src/api/x.ts/deeper/z'])).toEqual({ emptyParts: ['ts'] })
    expect(systemMapEmptyParts(c, ['src/apz'])).toEqual({ emptyParts: ['api', 'apix', 'ts', 'doc'] })
  })

  it('owner parity: 2000 seeded (path, map) pairs agree with a plain file-order scan of every glob', () => {
    let seed = 0x5eed
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const globs = [...new Set(PARITY.map(([g]) => g))].filter((g) => systemMapGlobProblem(g) === null)
    globs.push('src/api', 'src/api/x.ts', 'src/a*/**', 'lib/**', '**/*.go', 'src/**/*.ts', 'x/y/**')
    const SEGS = ['src', 'a', 'b', 'api', 'x.ts', 'x', 'lib', 'q.go', 'y', 'ab', '.ts']
    const paths = [...new Set(PARITY.map(([, p]) => p))]
    let mismatches = 0
    for (let n = 0; n < 2000; n++) {
      const count = 1 + rand(8)
      const parts = Array.from({ length: count }, (_, i) => part(`p${i}`, { files: Array.from({ length: 1 + rand(3) }, () => globs[rand(globs.length)]) }))
      const compiled = compileSystemMap(mapOf(doc({ parts })))
      const path = rand(3) === 0 ? paths[rand(paths.length)] : Array.from({ length: 1 + rand(5) }, () => SEGS[rand(SEGS.length)]).join('/')
      let reference: { partId: string; glob: string } | null = null
      for (const g of compiled.globs) {
        if (matchSystemMapGlob(g.glob, path, { left: 1_000_000 })) {
          reference = { partId: g.partId, glob: g.glob.glob }
          break
        }
      }
      const got = systemMapOwner(compiled, path)
      if (JSON.stringify(got) !== JSON.stringify(reference)) mismatches++
      expect(got, `${path} against ${parts.map((p) => p.files.join(',')).join(' | ')}`).toEqual(reference)
    }
    expect(mismatches).toBe(0)
  })

  it('empty-parts parity on the same seeded maps: the indexed check agrees with a plain scan', () => {
    let seed = 0xbeef
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const globs = [...new Set(PARITY.map(([g]) => g))].filter((g) => systemMapGlobProblem(g) === null)
    globs.push('src/api', 'src/a*/**', 'lib/**', '**/*.go', 'src/**/*.ts')
    const SEGS = ['src', 'a', 'b', 'api', 'x.ts', 'x', 'lib', 'q.go', 'ab']
    for (let n = 0; n < 300; n++) {
      const parts = Array.from({ length: 1 + rand(8) }, (_, i) => part(`p${i}`, { files: Array.from({ length: rand(3) }, () => globs[rand(globs.length)]) }))
      const compiled = compileSystemMap(mapOf(doc({ parts })))
      const files = Array.from({ length: rand(20) }, () => Array.from({ length: 1 + rand(4) }, () => SEGS[rand(SEGS.length)]).join('/')).sort()
      const reference = parts
        .filter((p) => p.files.length > 0)
        .filter((p) => !files.some((f) => compiled.globs.some((g) => g.partId === p.id && matchSystemMapGlob(g.glob, f, { left: 1_000_000 }))))
        .map((p) => p.id)
      expect(systemMapEmptyParts(compiled, files), JSON.stringify({ parts: parts.map((p) => p.files), files })).toEqual({ emptyParts: reference })
    }
  })

  it('prefix reject: x/y/** against x/z/a charges at most 2 comparisons; against x, 1', () => {
    const g = compileSystemMapGlob('x/y/**')
    const p1 = prepareSystemMapPath('x/z/a', { left: 1000 })!
    const b1 = { left: 1000 }
    expect(matchPreparedGlob(g, p1, b1)).toBe(false)
    expect(1000 - b1.left).toBeLessThanOrEqual(2)
    const p2 = prepareSystemMapPath('x', { left: 1000 })!
    const b2 = { left: 1000 }
    expect(matchPreparedGlob(g, p2, b2)).toBe(false)
    expect(1000 - b2.left).toBeLessThanOrEqual(1)
  })
})
