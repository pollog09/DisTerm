// docs/architecture/CODEMAP.md is hand-written, so nothing regenerates it when a file moves or a
// heading is renamed. This fails instead of letting it point at things that are gone. It also keeps
// the split docs honest: CLAUDE.md stays small, docs/reference/ is indexed, .claude/rules/ resolves.
//
// Markup (also stated at the top of the map):
//   `src/x.ts`        a backticked token starting with a REPO_PREFIXES entry, or naming a ROOT_FILES
//                     entry, is a path; it must exist.
//   [[Heading]]       a ## or ### heading of CLAUDE.md or docs/reference/, verbatim.
//   [[grep: text]]    a literal string that must occur in those files.
// References are removed before the paths are read, because a heading can hold a backticked
// `terminal/terminal-config.ts` that is CLAUDE.md's shorthand, not a repo path.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = path.join(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n')

const REPO_PREFIXES = ['src/', 'test/', 'docs/', 'scripts/', 'build/', '.github/']
const ROOT_FILES = ['CLAUDE.md', 'LICENSE', 'package.json']
const REFERENCE = /\[\[(.+?)\]\]/g
const GREP = 'grep: '
const REFERENCE_DIR = 'docs/reference'
const RULES_DIR = '.claude/rules'
const CLAUDE_MD_MAX_LINES = 200

function referenceFiles(): string[] {
  return fs.readdirSync(path.join(REPO, REFERENCE_DIR)).filter((f) => f.endsWith('.md'))
}

/** Tracked and not-yet-added files, so a fresh rule is judged before its first commit. */
function gitFiles(): string[] {
  return spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' }).stdout.split('\n')
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('**')
    .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*')
  return new RegExp(`^${body}$`)
}

function claudeHeadings(claude: string): string[] {
  return [...claude.matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1])
}

function citedPaths(map: string): string[] {
  const text = map.replace(REFERENCE, '')
  return [...text.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).filter((t) => ROOT_FILES.includes(t) || REPO_PREFIXES.some((p) => t.startsWith(p)))
}

function citedReferences(map: string): { headings: string[]; greps: string[] } {
  const all = [...map.matchAll(REFERENCE)].map((m) => m[1])
  return {
    headings: all.filter((r) => !r.startsWith(GREP)),
    greps: all.filter((r) => r.startsWith(GREP)).map((r) => r.slice(GREP.length))
  }
}

/** Every reason the map is wrong. Pure, so its failures can be proved without touching the repo. */
function problems(map: string, claude: string, exists: (rel: string) => boolean): string[] {
  const headings = new Set(claudeHeadings(claude))
  const { headings: cited, greps } = citedReferences(map)
  return [
    ...citedPaths(map)
      .filter((p) => !exists(p))
      .map((p) => `no such path: ${p}`),
    ...cited.filter((h) => !headings.has(h)).map((h) => `no such heading: ${h}`),
    ...greps.filter((g) => !claude.includes(g)).map((g) => `not in the reference: ${g}`),
    ...[...headings].filter((h) => !cited.includes(h)).map((h) => `heading not in the map's index: ${h}`)
  ]
}

describe('checking the map', () => {
  const claude = '# Title\n\n## Real heading\n\ntext with **a bullet**\n\n### Sub `x/y.ts` heading\n'
  const good = '`src/real.ts` [[Real heading]] [[Sub `x/y.ts` heading]] [[grep: **a bullet**]]'
  const exists = (rel: string) => rel === 'src/real.ts'

  it('passes a map whose references all resolve', () => {
    expect(problems(good, claude, exists)).toEqual([])
  })

  it('names a bad path, heading and grep', () => {
    expect(problems(`${good} \`src/gone.ts\``, claude, exists)).toEqual(['no such path: src/gone.ts'])
    expect(problems(`${good} [[Gone heading]]`, claude, exists)).toEqual(['no such heading: Gone heading'])
    expect(problems(`${good} [[grep: **gone**]]`, claude, exists)).toEqual(['not in the reference: **gone**'])
  })

  it('names a heading the index lost', () => {
    expect(problems('`src/real.ts` [[Real heading]]', claude, exists)).toEqual([
      'heading not in the map\'s index: Sub `x/y.ts` heading'
    ])
  })

  it('reads a line-number citation as a bad path', () => {
    expect(problems(`${good} \`src/real.ts:12\``, claude, exists)).toEqual(['no such path: src/real.ts:12'])
  })

  it('does not read commands, symbols or a heading\'s own backticks as paths', () => {
    expect(citedPaths('`npm run x` `renameAtomic` `LICENSE` [[Sub `src/gone.ts` heading]] `docs/a.md`')).toEqual(['LICENSE', 'docs/a.md'])
  })

  it('does not take the top-level title for a heading', () => {
    expect(claudeHeadings(claude)).toEqual(['Real heading', 'Sub `x/y.ts` heading'])
  })
})

describe('docs/architecture/CODEMAP.md', () => {
  const map = read('docs/architecture/CODEMAP.md')
  const reference = [read('CLAUDE.md'), ...referenceFiles().map((f) => read(`${REFERENCE_DIR}/${f}`))].join('\n')

  it('every path and heading reference resolves, and the index is complete', () => {
    expect(problems(map, reference, (rel) => fs.existsSync(path.join(REPO, rel)))).toEqual([])
  })

  it('still reads as markup: a broken parser must not pass by finding nothing', () => {
    const { headings, greps } = citedReferences(map)
    expect(citedPaths(map).length).toBeGreaterThan(100)
    expect(headings.length).toBeGreaterThan(40)
    expect(greps.length).toBeGreaterThan(20)
  })

  it('CLAUDE.md points readers at the map', () => {
    expect(read('CLAUDE.md')).toContain('docs/architecture/CODEMAP.md')
  })
})

// CLAUDE.md is loaded whole into every session, so it is a budget, not a place for detail.
describe('the split docs', () => {
  const claude = read('CLAUDE.md')

  it('CLAUDE.md stays under its line budget', () => {
    expect(claude.trimEnd().split('\n').length).toBeLessThanOrEqual(CLAUDE_MD_MAX_LINES)
  })

  it('CLAUDE.md lists every reference file, and lists none that is gone', () => {
    const table = claude.slice(claude.indexOf('## Reference (`docs/reference/`)'), claude.indexOf('## Conventions'))
    const listed = [...table.matchAll(/^\| [^|]+ \| (.+) \|$/gm)].flatMap((m) => [...m[1].matchAll(/`([a-z-]+)`/g)].map((n) => n[1]))
    expect(listed.length).toBeGreaterThan(20)
    expect(new Set(listed)).toEqual(new Set(referenceFiles().map((f) => f.replace(/\.md$/, ''))))
  })

  it('every rule pointer names a real reference file, and every glob matches something', () => {
    const tracked = gitFiles()
    expect(tracked.length).toBeGreaterThan(1000)
    const rules = fs.readdirSync(path.join(REPO, RULES_DIR)).filter((f) => f.startsWith('reference-'))
    expect(rules.length).toBeGreaterThan(10)
    const stale = rules.flatMap((rule) => {
      const text = read(`${RULES_DIR}/${rule}`)
      const globs = [...text.matchAll(/^ {2}- "(.+)"$/gm)].map((m) => m[1])
      const docs = [...text.matchAll(/`(docs\/reference\/[^`]+)`/g)].map((m) => m[1])
      return [
        ...(globs.length && docs.length ? [] : [`${rule}: no paths or no reference`]),
        ...docs.filter((d) => !fs.existsSync(path.join(REPO, d))).map((d) => `${rule}: no such file ${d}`),
        ...globs.filter((g) => !tracked.some((t) => globToRegExp(g).test(t))).map((g) => `${rule}: nothing matches ${g}`)
      ]
    })
    expect(stale).toEqual([])
  })

  it('.claude/rules/ is shared while the rest of .claude/ stays local', () => {
    const ignored = (rel: string) => spawnSync('git', ['check-ignore', '-q', rel], { cwd: REPO }).status === 0
    expect(ignored(`${RULES_DIR}/reference-canvas.md`)).toBe(false)
    expect(ignored('.claude/ship-graph.json')).toBe(true)
    expect(ignored('.claude/worktrees/x')).toBe(true)
  })

  it('reads a glob the way the rules use it', () => {
    expect(globToRegExp('src/core/usage/**').test('src/core/usage/a/b.ts')).toBe(true)
    expect(globToRegExp('src/core/pty-*.ts').test('src/core/pty-manager.ts')).toBe(true)
    expect(globToRegExp('src/core/pty-*.ts').test('src/core/pty-x/y.ts')).toBe(false)
  })
})
