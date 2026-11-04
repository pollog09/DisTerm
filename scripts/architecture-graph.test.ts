import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { testTmpDir } from '../src/core/test-tmp'
import {
  buildGraph,
  capDiagram,
  generate,
  groupOf,
  isExcluded,
  parseJsonc,
  readAliases,
  resolveSpecifier,
  sanitizeId,
  scanImports
  // @ts-expect-error — plain .mjs repo tooling, deliberately outside the typechecked projects.
} from './architecture-graph.mjs'

const SCRIPT = path.join(__dirname, 'architecture-graph.mjs')
const REPO = path.join(__dirname, '..')

const TSCONFIG = `{
  // A comment, and a path holding the comment opener: "@shared/*" must survive the strip.
  "compilerOptions": {
    /* block */
    "paths": { "@shared/*": ["./src/shared/*"], "@renderer/*": ["./src/renderer/*"], },
  }
}
`

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
}

const FIXTURE: Record<string, string> = {
  'tsconfig.web.json': TSCONFIG,
  'src/shared/types.ts': 'export type A = 1\n\nexport const B = 2\n',
  'src/shared/agents/config.ts': "import type { A } from '../types'\nexport const c: A = 1\n",
  'src/core/pty.ts': [
    "import { B } from '@shared/types'",
    "import type { A } from '@shared/types'",
    "import { c } from '../shared/agents/config'",
    "import { x } from '../main/index'",
    "import type { BrowserWindow } from 'electron'",
    "import { app } from 'electron/main'",
    "import fs from 'fs'",
    "import './style.css'",
    "import { gone } from './missing'",
    "import { fixture } from './__fixtures__/thing'",
    'export { B, c, x, fs, app, gone, fixture }',
    'export type { A, BrowserWindow }',
    ''
  ].join('\n'),
  'src/core/style.css': 'a {}\n',
  'src/core/pty.test.ts': "import { app } from 'electron'\n",
  'src/core/relay/host.test-support.ts': "import { app } from 'electron'\n",
  'src/core/__fixtures__/thing.ts': "import { app } from 'electron'\n",
  'src/core/relay/host.ts': "import { B } from '../../shared/types'\nimport('../pty').then(() => B)\n",
  'src/main/index.ts': "import { app } from 'electron'\nimport { B } from '@shared/types'\nexport const x = [app, B]\n",
  'src/renderer/App.tsx': [
    "import type { x } from '../main/index'",
    "import { B } from '@shared/types'",
    'export const App = () => <p>don&apos;t import me from "here", or don\'t</p>',
    ''
  ].join('\n'),
  'src/renderer/canvas/Canvas.tsx': "import { App } from '@renderer/App'\nexport const C = App\n"
}

const kinds = (src: string) =>
  scanImports(src).imports.map((i: { specifier: string; typeOnly: boolean; kind: string }) => [
    i.specifier,
    i.typeOnly ? 'type' : 'value',
    i.kind
  ])

describe('scanImports', () => {
  it('classifies static imports by what the statement says', () => {
    expect(kinds("import a from 'p1'")).toEqual([['p1', 'value', 'static']])
    expect(kinds("import 'p2'")).toEqual([['p2', 'value', 'static']])
    expect(kinds("import * as a from 'p3'")).toEqual([['p3', 'value', 'static']])
    expect(kinds("import type a from 'p4'")).toEqual([['p4', 'type', 'static']])
    expect(kinds("import type { a } from 'p5'")).toEqual([['p5', 'type', 'static']])
    expect(kinds("import type * as a from 'p6'")).toEqual([['p6', 'type', 'static']])
    expect(kinds("import { type a, type b as c } from 'p7'")).toEqual([['p7', 'type', 'static']])
    expect(kinds("import { type a, b } from 'p8'")).toEqual([['p8', 'value', 'static']])
    expect(kinds("import d, { type a } from 'p9'")).toEqual([['p9', 'value', 'static']])
    expect(kinds("import {} from 'p10'")).toEqual([['p10', 'value', 'static']])
  })

  it('does not read a binding called type as the modifier', () => {
    expect(kinds("import { type } from 'p1'")).toEqual([['p1', 'value', 'static']])
    expect(kinds("import { type as t } from 'p2'")).toEqual([['p2', 'value', 'static']])
    expect(kinds("import type from 'p3'")).toEqual([['p3', 'value', 'static']])
    expect(kinds("import type, { a } from 'p4'")).toEqual([['p4', 'value', 'static']])
  })

  it('reads re-exports and ignores exports with no source', () => {
    expect(kinds("export * from 'p1'")).toEqual([['p1', 'value', 'reexport']])
    expect(kinds("export * as n from 'p2'")).toEqual([['p2', 'value', 'reexport']])
    expect(kinds("export type * from 'p3'")).toEqual([['p3', 'type', 'reexport']])
    expect(kinds("export type { a } from 'p4'")).toEqual([['p4', 'type', 'reexport']])
    expect(kinds("export { type a } from 'p5'")).toEqual([['p5', 'type', 'reexport']])
    expect(kinds("export { a, type b } from 'p6'")).toEqual([['p6', 'value', 'reexport']])
    expect(kinds('const a = 1\nexport { a }\nexport type B = 1\nexport const c = 2')).toEqual([])
  })

  it('tells a dynamic load from a type position', () => {
    expect(kinds("const a = await import('p1')")).toEqual([['p1', 'value', 'dynamic']])
    expect(kinds("void import('p2').then((m) => m)")).toEqual([['p2', 'value', 'dynamic']])
    expect(kinds("const f = () => import('p3')")).toEqual([['p3', 'value', 'dynamic']])
    expect(kinds("const g = x ? import('a') : import('b')").map((r) => r[1])).toEqual(['value', 'value'])
    expect(kinds("type T = typeof import('p4')")).toEqual([['p4', 'type', 'import-type']])
    expect(kinds("let t: import('p5').Foo")).toEqual([['p5', 'type', 'import-type']])
    expect(kinds("const r = require('p6')")).toEqual([['p6', 'value', 'require']])
    expect(kinds("import a = require('p7')")).toEqual([['p7', 'value', 'require']])
    expect(scanImports('await import(name)').nonLiteralDynamic).toBe(1)
    expect(kinds('import.meta.url')).toEqual([])
    expect(kinds("x.require('no'); y.import('no')")).toEqual([])
  })

  it('finds nothing inside comments, strings, templates or regexes', () => {
    const src = [
      "// import a from 'c1'",
      "/* import b from 'c2' */",
      `const s = "import c from 'c3'"`,
      "const t = `import d from 'c4'\nimport('c5')`",
      "const r = /import e from 'c6'/.test(s)",
      "const q = /['\"`]/g",
      "const a = 4 / 2 / 1",
      "import real from 'kept'"
    ].join('\n')
    expect(kinds(src)).toEqual([['kept', 'value', 'static']])
  })

  it('sees code inside a template substitution, nested templates included', () => {
    const src = "const t = `a${`b${await import('inner')}c`}d`\nimport after from 'kept'"
    expect(kinds(src).map((r) => r[0])).toEqual(['inner', 'kept'])
  })

  it('survives JSX text and ignores a static-looking line inside a block', () => {
    const src = [
      "import a from 'first'",
      "export const X = () => { return <p>don't import b from 'no'</p> }",
      "function f() { import c from 'no2' }",
      "void import('last')"
    ].join('\n')
    expect(kinds(src).map((r) => r[0])).toEqual(['first', 'last'])
  })

  it('reads JSX text as text, so nothing in it hides what follows', () => {
    const clean = (src: string) => {
      const r = scanImports(src)
      expect(r.problems).toEqual([])
      return r.imports.map((i: { specifier: string }) => i.specifier)
    }
    expect(clean("export const A=()=><p>path/*.ts</p>\nexport { b } from 'kept'")).toEqual(['kept'])
    expect(clean("const A=<p>a ` b</p>\nconst L=()=>import('kept')")).toEqual(['kept'])
    expect(clean("const A=<p>http://x.dev don't</p>\nexport * from 'kept'")).toEqual(['kept'])
    expect(clean("const A=<p>import x from 'no' ` import('no2')</p>\nvoid import('kept')")).toEqual(['kept'])
    expect(clean(`const A=<a b="\`" c={import('p1')} {...d} e=<i/>>{f}<b.c-d/>/*<></></a>\nexport * from 'kept'`)).toEqual(['p1', 'kept'])
    expect(clean("const A=<Foo<Bar> x='\`'/>\nexport * from 'kept'")).toEqual(['kept'])
  })

  it('does not take a generic in a .tsx file for JSX', () => {
    const src = "const f = <T,>(a: T) => a\ntype G = <T>(a: T) => T\nconst h = <T extends U>(a: T) => import('p1')\nexport * from 'kept'"
    const r = scanImports(src)
    expect(r.problems).toEqual([])
    expect(r.imports.map((i: { specifier: string }) => i.specifier)).toEqual(['p1', 'kept'])
  })

  it('reads a cast as a cast outside JSX files', () => {
    const r = scanImports("const a = <T>b\nconst q = '<p>'\nexport * from 'kept'", { jsx: false })
    expect(r.problems).toEqual([])
    expect(r.imports.map((i: { specifier: string }) => i.specifier)).toEqual(['kept'])
  })

  it('takes a regex after a control statement or a block, and a division after other parens', () => {
    // No problems either: reading these as divisions would recover the import but flag the backtick.
    const clean = (src: string) => {
      const r = scanImports(src, { jsx: false })
      expect(r.problems, src).toEqual([])
      return r.imports.map((i: { specifier: string }) => i.specifier)
    }
    expect(clean("if (x) /`/.test(y)\nimport a from 'kept'")).toEqual(['kept'])
    expect(clean("while (x) /'/.test(y)\nimport a from 'kept'")).toEqual(['kept'])
    expect(clean("function f() {}\n/`/.test(y)\nimport a from 'kept'")).toEqual(['kept'])
    expect(clean("const a = (b) / 2 + `/${await import('p1')}`")).toEqual(['p1'])
    expect(clean("x.if(a) / 2; const b = `/${await import('p1')}`")).toEqual(['p1'])
  })

  it('flags what it cannot lex, and recovers the code behind an unterminated opener', () => {
    const kindsOf = (src: string) => scanImports(src, { jsx: false }).problems.map((p: { kind: string }) => p.kind)
    const after = (src: string) => scanImports(src, { jsx: false }).imports.map((i: { specifier: string }) => i.specifier)
    expect(kindsOf("const a = `oops\nimport b from 'kept'")).toEqual(['unterminated-template'])
    expect(after("const a = `oops\nimport b from 'kept'")).toEqual(['kept'])
    expect(kindsOf("/* oops\nimport b from 'kept'")).toEqual(['unterminated-comment'])
    expect(after("/* oops\nimport b from 'kept'")).toEqual(['kept'])
    expect(kindsOf('function f() {\n')).toEqual(['unclosed-brace'])
    expect(kindsOf('const a = 1 }')).toEqual(['stray-brace'])
    expect(kindsOf("const a = 'oops\n")).toEqual(['unterminated-string'])
    expect(kindsOf('const a = `${b`')).toEqual(['unterminated-template', 'unterminated-template', 'unclosed-brace'])
    expect(kindsOf("const a = `x${b}`\nfunction f() {}\nimport c from 'kept'")).toEqual([])
  })

  it('reports the line of each import and each problem', () => {
    expect(scanImports('\n\nfunction f() {\n').problems).toEqual([{ kind: 'unclosed-brace', line: 3 }])

    const lines = scanImports("\n/* x\ny */\nimport a from 'p'\n").imports.map((i: { line: number }) => i.line)
    expect(lines).toEqual([4])
  })
})

describe('grouping and exclusion', () => {
  it('groups by context and first directory, with a (root) for loose files', () => {
    expect(groupOf('src/core/agents/hooks/a.ts')).toEqual({ context: 'core', subsystem: 'core/agents' })
    expect(groupOf('src/core/a.ts')).toEqual({ context: 'core', subsystem: 'core/(root)' })
    expect(groupOf('src/session-host/host.ts')).toEqual({ context: 'session-host', subsystem: 'session-host/(root)' })
  })

  it('leaves out tests and fixtures, and nothing else', () => {
    for (const f of ['src/a.test.ts', 'src/a.test.tsx', 'src/a.realtmux.test.ts', 'src/a.test-support.ts', 'src/x/__fixtures__/a.ts']) {
      expect(isExcluded(f), f).toBe(true)
    }
    for (const f of ['src/latest.ts', 'src/test-tmp.ts', 'src/contest.tsx', 'src/a.d.ts']) expect(isExcluded(f), f).toBe(false)
  })
})

describe('resolveSpecifier', () => {
  const files = new Set([
    'src/core/a.ts',
    'src/core/b.tsx',
    'src/core/dir/index.ts',
    'src/core/decl.d.ts',
    'src/core/s.css',
    'src/shared/ipc.ts',
    'package.json'
  ])
  const aliases = { '@shared/': 'src/shared/' }
  const resolve = (spec: string, from = 'src/core/a.ts') => resolveSpecifier(spec, from, aliases, files)

  it('resolves extensions, index files, parents and aliases', () => {
    expect(resolve('./b').path).toBe('src/core/b.tsx')
    expect(resolve('./dir').path).toBe('src/core/dir/index.ts')
    expect(resolve('./decl').path).toBe('src/core/decl.d.ts')
    expect(resolve('../shared/ipc').path).toBe('src/shared/ipc.ts')
    expect(resolve('@shared/ipc').path).toBe('src/shared/ipc.ts')
    expect(resolve('./s.css').path).toBe('src/core/s.css')
    expect(resolve('../../package.json').path).toBe('package.json')
  })

  it('maps an ESM .js name to its source and drops a bundler query', () => {
    expect(resolve('./b.js').path).toBe('src/core/b.tsx')
    expect(resolve('./a?worker').path).toBe('src/core/a.ts')
  })

  it('separates a package from a path that names nothing', () => {
    expect(resolve('react').type).toBe('external')
    expect(resolve('@sharedish/x').type).toBe('external')
    expect(resolve('./nope').type).toBe('unresolved')
    expect(resolve('@shared/nope').type).toBe('unresolved')
  })

  it('reads aliases from a tsconfig whose paths contain a comment opener', () => {
    const root = testTmpDir('arch-aliases-')
    writeTree(root, { 'tsconfig.web.json': TSCONFIG })
    expect(readAliases(root)).toEqual({ '@shared/': 'src/shared/', '@renderer/': 'src/renderer/' })
    expect(parseJsonc('{"a": "b//c", "d": "/* e */"} // f')).toEqual({ a: 'b//c', d: '/* e */' })
  })

  it('matches the repo tsconfigs', () => {
    expect(readAliases(REPO)).toEqual({ '@shared/': 'src/shared/', '@renderer/': 'src/renderer/' })
  })
})

describe('buildGraph', () => {
  const graphOf = () => {
    const root = testTmpDir('arch-graph-')
    writeTree(root, FIXTURE)
    return buildGraph(root)
  }

  it('counts subsystems and leaves test code out', () => {
    const g = graphOf()
    expect(g.nodes.map((n: { id: string }) => n.id)).toEqual([
      'core/(root)',
      'core/relay',
      'main/(root)',
      'renderer/(root)',
      'renderer/canvas',
      'shared/(root)',
      'shared/agents'
    ])
    const shared = g.nodes.find((n: { id: string }) => n.id === 'shared/(root)')
    expect(shared).toMatchObject({ context: 'shared', files: 1, loc: 2 })
    expect(g.stats.excludedTestFiles).toBe(3)
    expect(g.stats.files).toBe(7)
  })

  it('splits type-only from value on an edge, and kinds it', () => {
    const g = graphOf()
    const edge = (from: string, to: string) => g.edges.find((e: { from: string; to: string }) => e.from === from && e.to === to)
    expect(edge('core/(root)', 'shared/(root)')).toMatchObject({ imports: 2, value: 1, typeOnly: 1, kind: 'mixed' })
    expect(edge('core/(root)', 'shared/agents')).toMatchObject({ imports: 1, value: 1, typeOnly: 0, kind: 'value' })
    expect(edge('shared/agents', 'shared/(root)')).toMatchObject({ imports: 1, value: 0, typeOnly: 1, kind: 'type-only' })
    expect(edge('core/relay', 'core/(root)')).toMatchObject({ imports: 1, value: 1, dynamic: 1 })
    expect(edge('renderer/canvas', 'renderer/(root)')).toMatchObject({ imports: 1, value: 1 })
  })

  it('reports forbidden crossings with their kind, and not the allowed electron import', () => {
    const g = graphOf()
    const seen = g.crossings.map((c: { rule: string; file: string; kind: string }) => [c.rule, c.file, c.kind])
    expect(seen).toEqual([
      ['core->electron', 'src/core/pty.ts', 'type-only'],
      ['core->electron', 'src/core/pty.ts', 'value'],
      ['core->main', 'src/core/pty.ts', 'value'],
      ['renderer->main', 'src/renderer/App.tsx', 'type-only']
    ])
  })

  it('accounts for every import it does not map', () => {
    const g = graphOf()
    expect(g.stats.assetImports).toBe(1)
    expect(g.stats.importsOfTestFiles).toBe(1)
    expect(g.unresolved).toEqual([{ file: 'src/core/pty.ts', line: 9, specifier: './missing' }])
    const { imports, internalImports, externalImports, assetImports, importsOfTestFiles, importsOutsideSrc, unresolvedImports } = g.stats
    expect(internalImports + externalImports + assetImports + importsOfTestFiles + importsOutsideSrc + unresolvedImports).toBe(imports)
  })

  it('counts an import that leaves src/ as that, by what is really on disk', () => {
    const root = testTmpDir('arch-outside-')
    writeTree(root, {
      'package.json': '{}\n',
      'scripts/tool.mjs': 'export const t = 1\n',
      'src/core/a.ts': [
        "import pkg from '../../package.json'",
        "import { t } from '../../scripts/tool.mjs'",
        "import { n } from '../../scripts/nope'",
        'export { pkg, t, n }',
        ''
      ].join('\n')
    })
    const g = buildGraph(root)
    expect(g.stats.importsOutsideSrc).toBe(2)
    expect(g.stats.unresolvedImports).toBe(1)
    expect(g.unresolved.map((u: { specifier: string }) => u.specifier)).toEqual(['../../scripts/nope'])
    expect(g.stats.files).toBe(1)
    expect(g.edges).toEqual([])
  })

  it('counts a file it could not lex, in the stats and in the document', () => {
    const root = testTmpDir('arch-trouble-')
    writeTree(root, {
      'src/core/ok.ts': "export const a = 1\n",
      'src/core/bad.ts': "const a = `oops\nimport { b } from './ok'\nexport { a, b }\n"
    })
    const { graph, outputs } = generate(root)
    expect(graph.stats.filesWithLexProblems).toBe(1)
    expect(graph.lexProblems).toEqual([{ file: 'src/core/bad.ts', line: 1, kind: 'unterminated-template' }])
    const md = outputs['docs/architecture/GRAPH.md']
    expect(md).toContain('**Scan trouble:** files not lexed cleanly: 1')
    expect(md).toContain('`src/core/bad.ts:1` | unterminated-template')
    const cli = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
    expect(cli.stdout).toContain('scan trouble in 1 file(s)')
  })

  it('uses JSX parsing for .tsx but not .ts', () => {
    const root = testTmpDir('arch-jsx-')
    writeTree(root, {
      'src/core/a.ts': "export const a = <T>b\nexport * from './b'\n",
      'src/core/b.ts': 'export const c = 1\n',
      'src/renderer/App.tsx': "export const A = <p>path/*.ts ` don't</p>\nexport * from './x'\n",
      'src/renderer/x.ts': 'export const c = 1\n'
    })
    const g = buildGraph(root)
    expect(g.stats.filesWithLexProblems).toBe(0)
    expect(g.stats.internalImports).toBe(2)
  })

  it('ranks fan-in by distinct importing files', () => {
    const g = graphOf()
    expect(g.fanIn[0]).toMatchObject({ file: 'src/shared/types.ts', importers: 5, value: 4, typeOnly: 2 })
  })
})
describe('determinism', () => {
  it('generates the same bytes twice, whatever the creation order or line endings', () => {
    const a = testTmpDir('arch-det-a-')
    const b = testTmpDir('arch-det-b-')
    writeTree(a, FIXTURE)
    const reversed = Object.entries(FIXTURE).reverse()
    writeTree(b, Object.fromEntries(reversed.map(([k, v]) => [k, v.replace(/\n/g, '\r\n')])))
    const first = generate(a).outputs
    expect(generate(a).outputs).toEqual(first)
    expect(generate(b).outputs).toEqual(first)
    for (const text of Object.values(first) as string[]) {
      expect(text).not.toContain('\r')
      expect(text).not.toContain(a)
      expect(text.endsWith('\n')).toBe(true)
    }
  })

  it('sorts nodes and edges by code unit', () => {
    const root = testTmpDir('arch-det-')
    writeTree(root, FIXTURE)
    const { graph } = generate(root)
    const ids = graph.nodes.map((n: { id: string }) => n.id)
    expect(ids).toEqual([...ids].sort())
    const keys = graph.edges.map((e: { from: string; to: string }) => `${e.from}\0${e.to}`)
    expect(keys).toEqual([...keys].sort())
  })
})

describe('diagram limits', () => {
  const node = (i: number) => ({ id: `core/n${i}`, loc: 100 - i })
  const edge = (a: number, b: number, imports: number) => ({ from: `core/n${a}`, to: `core/n${b}`, imports, value: imports, typeOnly: 0 })

  it('states what a cap dropped', () => {
    const capped = capDiagram([node(0), node(1), node(2)], [edge(0, 1, 9), edge(1, 0, 5), edge(0, 2, 1)], 2, 1)
    expect(capped.nodes.map((n: { id: string }) => n.id)).toEqual(['core/n0', 'core/n1'])
    expect(capped.edges).toHaveLength(1)
    expect(capped.edges[0].imports).toBe(9)
    expect(capped.notes.join(' ')).toContain('1 of 3 subsystems dropped')
    expect(capped.notes.join(' ')).toContain('`core/n2`')
    expect(capped.notes.join(' ')).toContain('2 of 3 edges dropped')
  })

  it('says nothing when nothing fell off', () => {
    expect(capDiagram([node(0)], []).notes).toEqual([])
  })

  it('states a cap in the document itself', () => {
    const root = testTmpDir('arch-cap-')
    const files: Record<string, string> = {}
    for (let i = 0; i < 30; i++) files[`src/core/d${i}/a.ts`] = 'export const a = 1\n'
    writeTree(root, files)
    const md = generate(root).outputs['docs/architecture/GRAPH.md']
    expect(md).toContain('6 of 30 subsystems dropped')
  })

  it('makes ids Mermaid can parse', () => {
    expect(sanitizeId('core/(root)')).toMatch(/^[A-Za-z0-9_]+$/)
    expect(sanitizeId('end')).not.toBe('end')
  })

  it('keeps two ids apart when sanitizing would merge them', () => {
    const root = testTmpDir('arch-ids-')
    writeTree(root, { 'src/core/a-b/x.ts': 'export {}\n', 'src/core/a_b/x.ts': 'export {}\n' })
    const md = generate(root).outputs['docs/architecture/GRAPH.md']
    expect(md).toContain('n_core_a_b[')
    expect(md).toContain('n_core_a_b_2[')
  })
})

describe('CLI', () => {
  const run = (root: string, ...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
  const outputs = (root: string) =>
    ['graph.json', 'GRAPH.md'].map((f) => fs.readFileSync(path.join(root, 'docs/architecture', f), 'utf8'))

  it('writes, is a no-op the second time, and --check passes', () => {
    const root = testTmpDir('arch-cli-')
    writeTree(root, FIXTURE)
    expect(run(root).status).toBe(0)
    const first = outputs(root)
    expect(run(root).status).toBe(0)
    expect(outputs(root)).toEqual(first)
    const check = run(root, '--check')
    expect(check.status).toBe(0)
    expect(check.stdout).toContain('current')
  })

  it('--check fails on a changed source and writes nothing', () => {
    const root = testTmpDir('arch-cli-')
    writeTree(root, FIXTURE)
    run(root)
    const before = outputs(root)
    fs.appendFileSync(path.join(root, 'src/core/pty.ts'), "import { App } from '../renderer/App'\nexport { App }\n")
    const check = run(root, '--check')
    expect(check.status).toBe(1)
    expect(check.stderr).toContain('graph.json')
    expect(check.stderr).toContain('GRAPH.md')
    expect(outputs(root)).toEqual(before)
  })

  it('--check fails on missing or hand-edited output', () => {
    const root = testTmpDir('arch-cli-')
    writeTree(root, FIXTURE)
    expect(run(root, '--check').status).toBe(1)
    run(root)
    fs.appendFileSync(path.join(root, 'docs/architecture/GRAPH.md'), 'edited\n')
    const check = run(root, '--check')
    expect(check.status).toBe(1)
    expect(check.stderr).toContain('GRAPH.md')
    expect(check.stderr).not.toContain('graph.json')
  })

  it('--check does not fail on a crossing the map already records', () => {
    const root = testTmpDir('arch-cli-')
    writeTree(root, FIXTURE)
    run(root)
    const check = run(root, '--check')
    expect(check.status).toBe(0)
    expect(check.stdout).toContain('4 forbidden crossings')
  })

  it('leaves the hand-written README alone', () => {
    const root = testTmpDir('arch-cli-')
    writeTree(root, { ...FIXTURE, 'docs/architecture/README.md': 'mine\n' })
    run(root)
    expect(fs.readFileSync(path.join(root, 'docs/architecture/README.md'), 'utf8')).toBe('mine\n')
  })

  it('refuses an unknown flag', () => {
    const root = testTmpDir('arch-cli-')
    writeTree(root, FIXTURE)
    expect(run(root, '--chekc').status).toBe(2)
  })
})

describe('the documents', () => {
  const README = path.join(REPO, 'docs/architecture/README.md')
  const blocks = (text: string) => [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1])

  // mermaid is only here through @excalidraw (pinned in package.json `overrides`), so its loss must
  // skip this and not fail the suite. It needs a DOM at import time.
  const require = createRequire(path.join(REPO, 'package.json'))
  const mermaidPath = path.join(REPO, 'node_modules/mermaid/dist/mermaid.core.mjs')

  afterEach(() => vi.unstubAllGlobals())

  it.skipIf(!fs.existsSync(mermaidPath))(
    'every diagram parses, in the README and in generated output with awkward names',
    async () => {
      const { JSDOM } = require('jsdom')
      const dom = new JSDOM('<!doctype html><body></body>')
      vi.stubGlobal('window', dom.window)
      vi.stubGlobal('document', dom.window.document)
      const mermaid = (await import(mermaidPath)).default
      mermaid.initialize({ startOnLoad: false })

      const root = testTmpDir('arch-mermaid-')
      writeTree(root, {
        ...FIXTURE,
        'src/core/end/a.ts': "import '../graph/a'\n",
        'src/core/graph/a.ts': "import type {} from '../end/a'\nexport {}\n",
        'src/core/a-b.c/a.ts': 'export {}\n'
      })
      const generated = blocks(generate(root).outputs['docs/architecture/GRAPH.md'])
      const readme = blocks(fs.readFileSync(README, 'utf8'))
      expect(generated.length).toBeGreaterThan(3)
      expect(readme.length).toBeGreaterThanOrEqual(2)
      for (const text of [...generated, ...readme]) await mermaid.parse(text)
      await expect(mermaid.parse('flowchart LR\n  a/b(c) --> ')).rejects.toBeTruthy()
    },
    60_000
  )

  it('every relative link in the README names a file that exists', () => {
    const text = fs.readFileSync(README, 'utf8')
    const links = [...text.matchAll(/\]\((?!https?:)([^)#]+)\)/g)].map((m) => m[1])
    expect(links.length).toBeGreaterThan(10)
    for (const link of links) {
      expect(fs.existsSync(path.join(path.dirname(README), link)), link).toBe(true)
    }
  })

  it('every src path the README names exists', () => {
    const text = fs.readFileSync(README, 'utf8')
    const paths = [...text.matchAll(/`(src\/[\w./-]+)`/g)].map((m) => m[1])
    expect(paths.length).toBeGreaterThan(5)
    for (const p of paths) expect(fs.existsSync(path.join(REPO, p)), p).toBe(true)
  })
})
