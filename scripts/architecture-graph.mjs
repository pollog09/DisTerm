#!/usr/bin/env node
// Generates the code map in docs/architecture/ from the import statements under src/, so the map
// cannot drift from the code. docs/architecture/README.md is the hand-written half (what imports
// cannot show) and this script never touches it.
//
//   npm run arch:graph                 write graph.json + GRAPH.md
//   npm run arch:graph -- --check      exit 1 if the files on disk differ from a fresh generation
//   ... --root <dir>                   run against another tree (the test's fixture)
//
// A boundary crossing is REPORTED, never a failure, in both modes: `--check` answers only "is the
// map current?". What fails a build for src/core and src/server is their no-electron tests.
//
// Why a small lexer instead of a parser: `typescript` here is TS 7, the native port, whose package
// exposes no `createSourceFile` (only an `unstable/` client that drives the Go binary), and
// @babel/parser is only a transitive dependency. Regexes over raw text are not an option either: a
// string or a comment holding the word `import` is common in this repo, which embeds generated
// shell and JS. The lexer knows comments, strings, nested templates, regex literals and JSX, and that
// is all an import scan needs. Its output was compared with @babel/parser over every mapped file of
// src/ (specifier and type-only, a one-off run, no differences). What it can get wrong is listed in
// GRAPH.md, and a file it could not lex cleanly is counted there instead of passing in silence.
//
// The output must stay byte-identical for an unchanged tree on every platform: no timestamps, `/`
// paths only, and code-unit sorting (`localeCompare` depends on the machine's locale).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CODE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const OUT_DIR = 'docs/architecture'
const JSON_OUT = `${OUT_DIR}/graph.json`
const MD_OUT = `${OUT_DIR}/GRAPH.md`
const TSCONFIGS = ['tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json']

/** What one per-context diagram may hold. GitHub renders far more, but past this it is unreadable. */
export const MAX_DIAGRAM_NODES = 24
export const MAX_DIAGRAM_EDGES = 40
const TOP_SUBSYSTEMS = 20
const TOP_FAN_IN = 25
const MAX_UNRESOLVED_LISTED = 30

/** The boundaries CLAUDE.md forbids. `to` is a context under src/, or `electron` the package. */
export const FORBIDDEN = [
  { id: 'renderer->main', from: 'renderer', to: 'main', source: 'The renderer must never import src/main (process model).' },
  { id: 'core->main', from: 'core', to: 'main', source: 'src/core talks to its shell only through CorePlatform.' },
  { id: 'server->main', from: 'server', to: 'main', source: 'src/server must not import src/main.' },
  { id: 'core->electron', from: 'core', to: 'electron', source: 'src/core must not import electron.' },
  { id: 'server->electron', from: 'server', to: 'electron', source: 'src/server must not import electron.' }
]

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// ---------------------------------------------------------------- lexer

const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await', 'instanceof'
])
const CONTROL_PAREN_KEYWORD = new Set(['if', 'while', 'for', 'with'])
const JSX_AFTER_KEYWORD = new Set(['return', 'default', 'case', 'else', 'do', 'yield', 'await'])

function regexMayStart(prev) {
  if (!prev) return true
  if (prev.t === 'id') return REGEX_AFTER_KEYWORD.has(prev.v)
  if (prev.t !== 'p') return false
  if (prev.v === ')') return prev.closesControl === true // `if (x) /re/`, unlike `(a) / b`
  // `}` ends a block far more often than an object about to be divided; `<` opens a closing tag.
  return !']<'.includes(prev.v)
}

/** Whether a `<` stands where an expression can start. A generic in that spot fails the trial parse. */
function jsxMayStart(prev, beforePrev) {
  if (!prev) return true
  if (prev.t === 'id') return JSX_AFTER_KEYWORD.has(prev.v)
  if (prev.t !== 'p') return false
  if (prev.v === '>') return beforePrev?.t === 'p' && beforePrev.v === '=' // `=> <p/>`
  return '(,=?:[{};&|!'.includes(prev.v)
}

const ID_START = /[\p{ID_Start}$_]/u
const ID_PART = /[\p{ID_Continue}$\u200c\u200d]/u

/**
 * `{ tokens, problems }`. Tokens have comments removed: `id`, `str` (a string, or a template with no
 * substitution), `tpl` (a template with substitutions), `num`, `regex`, `jsx` (a whole element, with
 * the tokens of its `{}` expressions before it), `p` (one punctuation character). `depth` is the open
 * brace + template-substitution nesting at the token.
 *
 * `problems` lists what could not be lexed cleanly, each of which can hide imports: an unterminated
 * comment, template or string, and braces that do not balance. An unterminated template or comment
 * is recovered from by scanning on after its opener, so the code behind it is still read.
 *
 * `jsx` is whether to parse JSX: true for .tsx and .jsx, and false elsewhere, where `<T>x` is a cast.
 */
export function tokenize(s, { jsx = true } = {}) {
  const tokens = []
  const problems = []
  let line = 1
  let i = 0
  let depth = 0
  const push = (t, v, atLine = line) => {
    tokens.push({ t, v, depth, line: atLine })
    return tokens[tokens.length - 1]
  }
  const problem = (kind, atLine) => problems.push({ kind, line: atLine })
  const save = () => ({ i, line, depth, tokens: tokens.length, problems: problems.length })
  const restore = (st) => {
    i = st.i
    line = st.line
    depth = st.depth
    tokens.length = st.tokens
    problems.length = st.problems
  }
  const advanceTo = (k) => {
    for (let n = i; n < k; n++) if (s[n] === '\n') line++
    i = k
  }
  /** Runs the code inside a `{` already consumed, through its `}`. False if the file ends first. */
  const lexNested = () => {
    depth++
    const closed = lexCode(true)
    depth--
    return closed
  }

  function lexTemplate() {
    const start = save()
    const text = i + 1
    i++
    let opened = false
    while (i < s.length) {
      const c = s[i]
      if (c === '\\') {
        advanceTo(i + 2)
      } else if (c === '`') {
        if (opened) push('tpl', '', start.line)
        else push('str', s.slice(text, i), start.line)
        i++
        return
      } else if (c === '$' && s[i + 1] === '{') {
        if (!opened) push('tpl', '', start.line)
        opened = true
        i += 2
        if (!lexNested()) break
      } else {
        advanceTo(i + 1)
      }
    }
    restore(start)
    problem('unterminated-template', start.line)
    i = start.i + 1
  }

  function lexString(quote) {
    let k = i + 1
    let text = ''
    while (k < s.length && s[k] !== '\n') {
      if (s[k] === quote) {
        push('str', text)
        advanceTo(k + 1)
        return
      }
      if (s[k] === '\\') {
        if (s[k + 1] === '\r' && s[k + 2] === '\n') k += 3
        else {
          text += s[k + 1] ?? ''
          k += 2
        }
        continue
      }
      text += s[k]
      k++
    }
    problem('unterminated-string', line)
    i++
  }

  /** A regex is one line and ends at an unescaped `/` outside a class. Else this `/` was plain. */
  function lexSlash() {
    if (!regexMayStart(tokens[tokens.length - 1])) {
      push('p', '/')
      i++
      return
    }
    let k = i + 1
    let inClass = false
    while (k < s.length && s[k] !== '\n') {
      if (s[k] === '\\') {
        k += 2
        continue
      }
      if (s[k] === '[') inClass = true
      else if (s[k] === ']') inClass = false
      else if (s[k] === '/' && !inClass) {
        push('regex', '')
        i = k + 1
        return
      }
      k++
    }
    push('p', '/')
    i++
  }

  function skipJsxTrivia() {
    while (i < s.length) {
      if (/\s/.test(s[i])) advanceTo(i + 1)
      else if (s[i] === '/' && s[i + 1] === '/') {
        const end = s.indexOf('\n', i)
        i = end === -1 ? s.length : end
      } else if (s[i] === '/' && s[i + 1] === '*') {
        const end = s.indexOf('*/', i + 2)
        if (end === -1) return
        advanceTo(end + 2)
      } else return
    }
  }

  function readJsxName(extra) {
    const start = i
    if (i < s.length && ID_START.test(s[i])) {
      i++
      while (i < s.length && (ID_PART.test(s[i]) || extra.includes(s[i]))) i++
    }
    return s.slice(start, i)
  }

  /** From a `<`: one element, through its end. False means this was not JSX; the caller rewinds. */
  function lexJsxElement() {
    i++
    skipJsxTrivia()
    const name = readJsxName('.-:')
    if (name === '' && s[i] !== '>') return false
    skipJsxTrivia()
    if (name !== '' && s[i] === '<') {
      // <Foo<Bar> a="b">
      let nest = 0
      while (i < s.length) {
        if (s[i] === '<') nest++
        else if (s[i] === '>' && --nest === 0) break
        advanceTo(i + 1)
      }
      i++
    }
    for (;;) {
      skipJsxTrivia()
      if (i >= s.length) return false
      if (s[i] === '/' && s[i + 1] === '>') {
        i += 2
        return true
      }
      if (s[i] === '>') {
        i++
        break
      }
      if (s[i] === '{') {
        i++
        if (!lexNested()) return false
        continue
      }
      if (readJsxName('-:') === '') return false
      skipJsxTrivia()
      if (s[i] !== '=') continue
      i++
      skipJsxTrivia()
      if (s[i] === '"' || s[i] === "'") {
        const end = s.indexOf(s[i], i + 1) // no escapes in a JSX attribute string
        if (end === -1) return false
        advanceTo(end + 1)
      } else if (s[i] === '{') {
        i++
        if (!lexNested()) return false
      } else if (s[i] !== '<' || !lexJsxElement()) {
        return false
      }
    }
    // Children: text up to the next `<` or `{`. Quotes, backticks and slashes mean nothing here.
    while (i < s.length) {
      if (s[i] === '{') {
        i++
        if (!lexNested()) return false
      } else if (s[i] === '<' && s[i + 1] === '/') {
        i += 2
        skipJsxTrivia()
        if (readJsxName('.-:') !== name) return false
        skipJsxTrivia()
        if (s[i] !== '>') return false
        i++
        return true
      } else if (s[i] === '<') {
        if (!lexJsxElement()) return false
      } else {
        advanceTo(i + 1)
      }
    }
    return false
  }

  /** Code, until the file ends, or with `closeOnBrace`, until the `}` that closes the caller's `{`. */
  function lexCode(closeOnBrace) {
    const openLines = []
    const parens = []
    while (i < s.length) {
      const c = s[i]
      if (c === '\n') {
        line++
        i++
      } else if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\ufeff') {
        i++
      } else if (c === '/' && s[i + 1] === '/') {
        const end = s.indexOf('\n', i)
        i = end === -1 ? s.length : end
      } else if (c === '/' && s[i + 1] === '*') {
        const end = s.indexOf('*/', i + 2)
        if (end === -1) {
          problem('unterminated-comment', line)
          i += 2
        } else {
          advanceTo(end + 2)
        }
      } else if (c === '"' || c === "'") {
        lexString(c)
      } else if (c === '`') {
        lexTemplate()
      } else if (c === '(') {
        const prev = tokens[tokens.length - 1]
        const before = tokens[tokens.length - 2]
        parens.push(prev?.t === 'id' && CONTROL_PAREN_KEYWORD.has(prev.v) && !(before?.t === 'p' && before.v === '.'))
        push('p', c)
        i++
      } else if (c === ')') {
        const tok = push('p', c)
        if (parens.pop()) tok.closesControl = true
        i++
      } else if (c === '{') {
        push('p', c)
        openLines.push(line)
        depth++
        i++
      } else if (c === '}') {
        if (openLines.length > 0) {
          openLines.pop()
          depth--
          push('p', c)
        } else if (closeOnBrace) {
          i++
          return true
        } else {
          problem('stray-brace', line)
          push('p', c)
        }
        i++
      } else if (c === '/') {
        lexSlash()
      } else if (
        c === '<' &&
        jsx &&
        jsxMayStart(tokens[tokens.length - 1], tokens[tokens.length - 2])
      ) {
        const start = save()
        const startLine = line
        if (lexJsxElement()) {
          push('jsx', '', startLine)
        } else {
          restore(start)
          push('p', c)
          i++
        }
      } else if (ID_START.test(c)) {
        let k = i + 1
        while (k < s.length && ID_PART.test(s[k])) k++
        push('id', s.slice(i, k))
        i = k
      } else if (c >= '0' && c <= '9') {
        let k = i + 1
        while (k < s.length && /[\w.]/.test(s[k])) k++
        push('num', '')
        i = k
      } else {
        push('p', c)
        i++
      }
    }
    if (closeOnBrace) return false
    if (openLines.length > 0) problem('unclosed-brace', openLines[0])
    return false
  }

  lexCode(false)
  return { tokens, problems }
}

// ---------------------------------------------------------------- import extraction

const isP = (tok, v) => tok?.t === 'p' && tok.v === v
const isId = (tok, v) => tok?.t === 'id' && (v === undefined || tok.v === v)

/** Reads `{ a, type b, c as d }` starting at the `{`. */
function readNamedClause(tokens, open) {
  let j = open + 1
  let count = 0
  let valueCount = 0
  while (j < tokens.length && !isP(tokens[j], '}')) {
    const start = j
    while (j < tokens.length && !isP(tokens[j], ',') && !isP(tokens[j], '}')) j++
    const spec = tokens.slice(start, j)
    if (spec.length > 0) {
      count++
      // `type A`, `type A as B` carry the modifier; `type` and `type as B` import a value named type.
      const importsNamedType =
        spec.length === 1 || (spec.length === 3 && isId(spec[1], 'as'))
      const typeModifier = isId(spec[0], 'type') && !importsNamedType
      if (!typeModifier) valueCount++
    }
    if (isP(tokens[j], ',')) j++
  }
  return { close: j, count, valueCount }
}

/** A `typeof import('x')` or `import('x').Foo` is a type; `import('x').then(...)` is a load. */
function dynamicIsTypeOnly(tokens, idx, close) {
  const prev = tokens[idx - 1]
  if (isId(prev, 'typeof')) return true
  if (isId(prev, 'await')) return false
  const next = tokens[close + 1]
  if (isP(next, '.')) {
    const member = tokens[close + 2]
    return !(isId(member, 'then') || isId(member, 'catch') || isId(member, 'finally'))
  }
  return false
}

/**
 * Every import a file makes, by syntax. `typeOnly` follows what the statement SAYS: an
 * `import { Foo }` whose Foo is used only as a type is elided by the bundler but still reads as a
 * value import here, because telling them apart takes a type checker.
 */
export function scanImports(source, { jsx = true } = {}) {
  const { tokens, problems } = tokenize(source, { jsx })
  const found = []
  const nonLiteral = []
  const add = (specifier, kind, typeOnly, tok) => found.push({ specifier, kind, typeOnly, line: tok.line })
  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx]
    if (tok.t !== 'id') continue
    const prev = tokens[idx - 1]
    const memberAccess = isP(prev, '.')
    if (tok.v === 'import' && !memberAccess) {
      const next = tokens[idx + 1]
      if (isP(next, '(')) {
        const arg = tokens[idx + 2]
        if (arg?.t === 'str' && (isP(tokens[idx + 3], ')') || isP(tokens[idx + 3], ','))) {
          let close = idx + 3
          let nest = 0
          while (close < tokens.length) {
            if (isP(tokens[close], '(')) nest++
            else if (isP(tokens[close], ')')) {
              if (nest === 0) break
              nest--
            }
            close++
          }
          const typeOnly = dynamicIsTypeOnly(tokens, idx, close)
          add(arg.v, typeOnly ? 'import-type' : 'dynamic', typeOnly, tok)
        } else {
          nonLiteral.push({ line: tok.line })
        }
        continue
      }
      if (isP(next, '.') || tok.depth !== 0) continue
      if (next?.t === 'str') {
        add(next.v, 'static', false, tok)
        continue
      }
      let j = idx + 1
      let declaredType = false
      if (isId(tokens[j], 'type')) {
        const after = tokens[j + 1]
        const typeIsTheBinding = (isId(after, 'from') && tokens[j + 2]?.t === 'str') || isP(after, ',') || isP(after, '=')
        if (!typeIsTheBinding) {
          declaredType = true
          j++
        }
      }
      let bindsValue = false
      let named = null
      let ok = true
      for (let guard = 0; guard < 8 && ok; guard++) {
        const t = tokens[j]
        if (isId(t, 'from') && tokens[j + 1]?.t === 'str') break
        if (isP(t, '{')) {
          named = readNamedClause(tokens, j)
          j = named.close + 1
        } else if (isP(t, '*')) {
          bindsValue = true
          j += isId(tokens[j + 1], 'as') ? 3 : 1
        } else if (isP(t, ',')) {
          j++
        } else if (t?.t === 'id' && !isP(tokens[j + 1], '=')) {
          bindsValue = true
          j++
        } else {
          ok = false // `import a = require('x')`: the require branch below counts it.
        }
      }
      if (!ok || !isId(tokens[j], 'from')) continue
      const allInlineTypes = named !== null && named.count > 0 && named.valueCount === 0
      add(tokens[j + 1].v, 'static', declaredType || (allInlineTypes && !bindsValue), tok)
    } else if (tok.v === 'export' && tok.depth === 0 && !memberAccess) {
      let j = idx + 1
      let declaredType = false
      if (isId(tokens[j], 'type') && (isP(tokens[j + 1], '{') || isP(tokens[j + 1], '*'))) {
        declaredType = true
        j++
      }
      if (isP(tokens[j], '*')) {
        j += isId(tokens[j + 1], 'as') ? 3 : 1
        if (isId(tokens[j], 'from') && tokens[j + 1]?.t === 'str') {
          add(tokens[j + 1].v, 'reexport', declaredType, tok)
        }
      } else if (isP(tokens[j], '{')) {
        const named = readNamedClause(tokens, j)
        j = named.close + 1
        if (isId(tokens[j], 'from') && tokens[j + 1]?.t === 'str') {
          const allInlineTypes = named.count > 0 && named.valueCount === 0
          add(tokens[j + 1].v, 'reexport', declaredType || allInlineTypes, tok)
        }
      }
    } else if (tok.v === 'require' && !memberAccess && !isId(prev, 'function')) {
      if (isP(tokens[idx + 1], '(') && tokens[idx + 2]?.t === 'str' && isP(tokens[idx + 3], ')')) {
        add(tokens[idx + 2].v, 'require', false, tok)
      }
    }
  }
  return { imports: found, nonLiteralDynamic: nonLiteral.length, problems }
}

// ---------------------------------------------------------------- walking + resolving

function isFileOnDisk(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function walkFiles(root, dir, out) {
  const entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  entries.sort((a, b) => byCodeUnit(a.name, b.name))
  for (const e of entries) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) walkFiles(root, rel, out)
    else if (e.isFile()) out.push(rel)
  }
  return out
}

const isCode = (rel) => CODE_EXT.includes(path.posix.extname(rel))

/** Test code that is not part of the map. `x.test-support.ts` is this repo's test-helper spelling. */
export function isExcluded(rel) {
  if (rel.split('/').includes('__fixtures__')) return true
  return /\.test(-[\w-]+)?\.[cm]?[jt]sx?$/.test(path.posix.basename(rel))
}

/** `src/core/agents/hooks/a.ts` -> `{ context: 'core', subsystem: 'core/agents' }`. */
export function groupOf(rel) {
  const parts = rel.split('/')
  if (parts.length < 3) return { context: '(src)', subsystem: '(src)/(root)' }
  const context = parts[1]
  return { context, subsystem: parts.length === 3 ? `${context}/(root)` : `${context}/${parts[2]}` }
}

/** JSON with comments. A plain comment regex would eat `"@shared/*": ["./src/shared/*"]`. */
export function parseJsonc(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
      if (i === 0) break
    } else {
      out += c
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** `{ '@shared/': 'src/shared/' }`, the union of the projects' `paths`. */
export function readAliases(root) {
  const aliases = {}
  for (const name of TSCONFIGS) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) continue
    const paths = parseJsonc(fs.readFileSync(file, 'utf8')).compilerOptions?.paths ?? {}
    for (const [key, targets] of Object.entries(paths)) {
      if (!key.endsWith('/*') || !targets[0]?.endsWith('/*')) continue
      aliases[key.slice(0, -1)] = path.posix.normalize(targets[0].slice(0, -1))
    }
  }
  return aliases
}

/**
 * Where a specifier lands: `{ type: 'file', path }` for anything in the repo, `{ type: 'external' }`
 * for a package, `{ type: 'unresolved' }` for a relative or aliased path that names nothing.
 */
export function resolveSpecifier(specifier, fromRel, aliases, allFiles) {
  const bare = specifier.split('?')[0]
  let target = null
  if (bare.startsWith('./') || bare.startsWith('../') || bare === '.' || bare === '..') {
    target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), bare))
  } else {
    for (const [prefix, dir] of Object.entries(aliases)) {
      if (bare.startsWith(prefix)) target = path.posix.normalize(dir + bare.slice(prefix.length))
    }
    if (target === null) return { type: 'external' }
  }
  target = target.replace(/\/$/, '')
  const candidates = [target]
  for (const ext of ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) candidates.push(target + ext)
  // ESM-style `./x.js` names the `./x.ts` beside it.
  const swapped = { '.js': ['.ts', '.tsx', '.d.ts'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }[path.posix.extname(target)]
  if (swapped) for (const ext of swapped) candidates.push(target.slice(0, -path.posix.extname(target).length) + ext)
  for (const ext of ['.ts', '.tsx', '.d.ts', '.js', '.jsx']) candidates.push(`${target}/index${ext}`)
  for (const c of candidates) if (allFiles.has(c)) return { type: 'file', path: c }
  return { type: 'unresolved' }
}

// ---------------------------------------------------------------- the graph

function countLoc(text) {
  let n = 0
  for (const line of text.split('\n')) if (line.trim() !== '') n++
  return n
}

function bump(map, key, make) {
  let v = map.get(key)
  if (!v) {
    v = make()
    map.set(key, v)
  }
  return v
}

const newEdge = (from, to) => ({ from, to, imports: 0, value: 0, typeOnly: 0, dynamic: 0 })

function tallyEdge(edge, imp) {
  edge.imports++
  if (imp.typeOnly) edge.typeOnly++
  else edge.value++
  if (imp.kind === 'dynamic' || imp.kind === 'require') edge.dynamic++
}

const sealEdges = (map) =>
  [...map.values()]
    .map((e) => ({ ...e, kind: e.value === 0 ? 'type-only' : e.typeOnly === 0 ? 'value' : 'mixed' }))
    .sort((a, b) => byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to))

export function buildGraph(root) {
  const srcDir = path.join(root, 'src')
  const allPaths = fs.existsSync(srcDir) ? walkFiles(root, 'src', []) : []
  const srcFiles = new Set(allPaths)
  // Everything under src/ is listed; a path that leaves src/ is asked of the disk, and only then.
  const allFiles = {
    has: (rel) => srcFiles.has(rel) || (!rel.startsWith('src/') && isFileOnDisk(path.join(root, rel)))
  }
  const files = allPaths.filter((f) => isCode(f) && !isExcluded(f))
  const included = new Set(files)
  const excludedCount = allPaths.filter((f) => isCode(f) && isExcluded(f)).length
  const aliases = readAliases(root)

  const nodes = new Map()
  const contexts = new Map()
  const subsystemEdges = new Map()
  const contextEdges = new Map()
  const fanIn = new Map()
  const crossings = []
  const unresolved = []
  const lexProblems = []
  const stats = {
    files: files.length,
    loc: 0,
    excludedTestFiles: excludedCount,
    imports: 0,
    internalImports: 0,
    externalImports: 0,
    assetImports: 0,
    importsOfTestFiles: 0,
    importsOutsideSrc: 0,
    unresolvedImports: 0,
    nonLiteralDynamicImports: 0,
    filesWithLexProblems: 0
  }

  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')
    const { context, subsystem } = groupOf(file)
    const loc = countLoc(text)
    stats.loc += loc
    const node = bump(nodes, subsystem, () => ({ id: subsystem, context, files: 0, loc: 0, internalImports: 0 }))
    node.files++
    node.loc += loc
    const ctx = bump(contexts, context, () => ({ id: context, files: 0, loc: 0, subsystems: 0, internalImports: 0 }))
    ctx.files++
    ctx.loc += loc

    const { imports, nonLiteralDynamic, problems } = scanImports(text, { jsx: /\.[jt]sx$/.test(file) })
    stats.nonLiteralDynamicImports += nonLiteralDynamic
    if (problems.length > 0) stats.filesWithLexProblems++
    for (const p of problems) lexProblems.push({ file, line: p.line, kind: p.kind })
    for (const imp of imports) {
      stats.imports++
      const resolved = resolveSpecifier(imp.specifier, file, aliases, allFiles)
      if (resolved.type === 'external') {
        stats.externalImports++
        const pkg = imp.specifier.split('/')[0]
        const rule = FORBIDDEN.find((r) => r.from === context && r.to === pkg)
        if (rule) crossings.push(crossing(rule, file, imp, imp.specifier))
        continue
      }
      if (resolved.type === 'unresolved') {
        stats.unresolvedImports++
        unresolved.push({ file, line: imp.line, specifier: imp.specifier })
        continue
      }
      const target = resolved.path
      if (!target.startsWith('src/')) {
        stats.importsOutsideSrc++
        continue
      }
      if (!isCode(target)) {
        stats.assetImports++
        continue
      }
      if (!included.has(target)) {
        stats.importsOfTestFiles++
        continue
      }
      stats.internalImports++
      const to = groupOf(target)
      const rule = FORBIDDEN.find((r) => r.from === context && r.to === to.context)
      if (rule) crossings.push(crossing(rule, file, imp, imp.specifier, target))
      if (to.subsystem === subsystem) node.internalImports++
      else tallyEdge(bump(subsystemEdges, `${subsystem}\0${to.subsystem}`, () => newEdge(subsystem, to.subsystem)), imp)
      if (to.context === context) ctx.internalImports++
      else tallyEdge(bump(contextEdges, `${context}\0${to.context}`, () => newEdge(context, to.context)), imp)
      const row = bump(fanIn, target, () => ({
        file: target,
        subsystem: to.subsystem,
        importers: new Set(),
        outsideSubsystem: new Set(),
        value: 0,
        typeOnly: 0
      }))
      row.importers.add(file)
      if (to.subsystem !== subsystem) row.outsideSubsystem.add(file)
      if (imp.typeOnly) row.typeOnly++
      else row.value++
    }
  }

  for (const node of nodes.values()) bump(contexts, node.context, () => null).subsystems++

  const fanInRows = [...fanIn.values()]
    .map((r) => ({
      file: r.file,
      subsystem: r.subsystem,
      importers: r.importers.size,
      outsideSubsystem: r.outsideSubsystem.size,
      value: r.value,
      typeOnly: r.typeOnly
    }))
    .sort((a, b) => b.importers - a.importers || byCodeUnit(a.file, b.file))

  crossings.sort(
    (a, b) => byCodeUnit(a.rule, b.rule) || byCodeUnit(a.file, b.file) || a.line - b.line || byCodeUnit(a.specifier, b.specifier)
  )
  unresolved.sort((a, b) => byCodeUnit(a.file, b.file) || a.line - b.line || byCodeUnit(a.specifier, b.specifier))
  lexProblems.sort((a, b) => byCodeUnit(a.file, b.file) || a.line - b.line || byCodeUnit(a.kind, b.kind))

  return {
    generatedBy: 'scripts/architecture-graph.mjs',
    aliases: Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => byCodeUnit(a, b))),
    stats,
    contexts: [...contexts.values()].sort((a, b) => byCodeUnit(a.id, b.id)),
    contextEdges: sealEdges(contextEdges),
    nodes: [...nodes.values()].sort((a, b) => byCodeUnit(a.id, b.id)),
    edges: sealEdges(subsystemEdges),
    fanIn: fanInRows.slice(0, TOP_FAN_IN),
    filesWithImporters: fanInRows.length,
    crossings,
    unresolved,
    lexProblems
  }
}

function crossing(rule, file, imp, specifier, target) {
  return {
    rule: rule.id,
    file,
    line: imp.line,
    specifier,
    ...(target ? { target } : {}),
    kind: imp.typeOnly ? 'type-only' : 'value',
    syntax: imp.kind
  }
}

// ---------------------------------------------------------------- Mermaid + Markdown

/** A Mermaid id: `core/(root)` -> `n_core__root_`. The prefix keeps `end` and `graph` legal. */
export function sanitizeId(id) {
  return `n_${id.replace(/[^A-Za-z0-9]/g, '_')}`
}

function mermaidIds(ids) {
  const used = new Set()
  const map = new Map()
  for (const id of [...ids].sort(byCodeUnit)) {
    let candidate = sanitizeId(id)
    for (let n = 2; used.has(candidate); n++) candidate = `${sanitizeId(id)}_${n}`
    used.add(candidate)
    map.set(id, candidate)
  }
  return map
}

const mermaidLabel = (text) => text.replace(/"/g, '#quot;')
const num = (n) => n.toLocaleString('en-US')
const edgeLabel = (e) => (e.typeOnly === 0 ? `${num(e.value)}` : `${num(e.value)} + ${num(e.typeOnly)}t`)

function mermaidBlock(nodes, edges, nodeLabel) {
  const ids = mermaidIds(nodes.map((n) => n.id))
  const lines = ['```mermaid', 'flowchart LR']
  for (const n of nodes) lines.push(`  ${ids.get(n.id)}["${mermaidLabel(nodeLabel(n))}"]`)
  for (const e of edges) {
    const arrow = e.value === 0 ? '-.->' : '-->'
    lines.push(`  ${ids.get(e.from)} ${arrow}|"${edgeLabel(e)}"| ${ids.get(e.to)}`)
  }
  lines.push('```')
  return lines.join('\n')
}

/** Applies the caps and says exactly what fell off, so a reader never takes a sample for the whole. */
export function capDiagram(nodes, edges, maxNodes = MAX_DIAGRAM_NODES, maxEdges = MAX_DIAGRAM_EDGES) {
  const keptNodes = [...nodes].sort((a, b) => b.loc - a.loc || byCodeUnit(a.id, b.id)).slice(0, maxNodes)
  const keptIds = new Set(keptNodes.map((n) => n.id))
  const droppedNodes = nodes.filter((n) => !keptIds.has(n.id)).map((n) => n.id).sort(byCodeUnit)
  const eligible = edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to))
  const keptEdges = [...eligible]
    .sort((a, b) => b.imports - a.imports || byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to))
    .slice(0, maxEdges)
  const notes = []
  if (droppedNodes.length > 0) {
    notes.push(`${droppedNodes.length} of ${nodes.length} subsystems dropped (smallest by LOC): ${droppedNodes.map((d) => `\`${d}\``).join(', ')}.`)
  }
  const droppedEdges = edges.length - keptEdges.length
  if (droppedEdges > 0) {
    const floor = keptEdges.length > 0 ? keptEdges[keptEdges.length - 1].imports : 0
    notes.push(`${droppedEdges} of ${edges.length} edges dropped; only the ${keptEdges.length} heaviest are drawn (each with at least ${num(floor)} imports).`)
  }
  return {
    nodes: keptNodes.sort((a, b) => byCodeUnit(a.id, b.id)),
    edges: keptEdges.sort((a, b) => byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to)),
    notes
  }
}

const cell = (text) => String(text).replace(/\|/g, '\\|')
const code = (text) => `\`${cell(text)}\``

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`)
  ].join('\n')
}

export function renderMarkdown(graph) {
  const { stats } = graph
  const out = []
  out.push('# Code map (generated)')
  out.push('')
  out.push('<!-- GENERATED by scripts/architecture-graph.mjs. Do not edit: run `npm run arch:graph`. -->')
  out.push('')
  out.push('Generated from the import statements under `src/`. The runtime picture that imports cannot show is in')
  out.push('[README.md](README.md); the same data as JSON, with every subsystem edge, is in [graph.json](graph.json).')
  out.push('')
  out.push(`**${num(stats.files)} files, ${num(stats.loc)} lines of code** (non-blank), ${graph.contexts.length} process contexts, ${graph.nodes.length} subsystems, ${graph.edges.length} subsystem edges, ${graph.contextEdges.length} context edges.`)
  out.push('')
  out.push('## What is counted')
  out.push('')
  out.push(`- **Left out:** ${num(stats.excludedTestFiles)} test files (\`*.test.*\`, \`*.test-*.*\`, anything under \`__fixtures__\`). Test helpers without that spelling (\`platform-fake.ts\`, \`test-tmp.ts\`) are counted.`)
  out.push(`- **Imports:** ${num(stats.imports)} statements. ${num(stats.internalImports)} land on a mapped file, ${num(stats.externalImports)} on a package, ${num(stats.assetImports)} on a non-code file, ${num(stats.importsOfTestFiles)} on a left-out test file, ${num(stats.importsOutsideSrc)} outside \`src/\`, and ${num(stats.unresolvedImports)} resolve to nothing.`)
  out.push(`- **Not seen:** ${num(stats.nonLiteralDynamicImports)} \`import()\` calls whose argument is not a string literal, and anything loaded by path at runtime: \`new URL()\`, a bundler entry, a spawned bundle such as the session host.`)
  out.push('- **Type-only** means the statement says so (`import type`, every specifier `type`, `typeof import()`). An `import { Foo }` used only as a type is elided by the bundler but counts as a value import here, because telling them apart takes a type checker. Value counts are therefore an upper bound on what reaches a bundle.')
  out.push(`- **Scan trouble:** files not lexed cleanly: ${num(stats.filesWithLexProblems)} (an unterminated comment, template or string, or unbalanced braces). In such a file, imports after that point may be missing or wrong${stats.filesWithLexProblems > 0 ? ', and the files are listed under "Files the scanner could not read cleanly"' : ''}.`)
  out.push('- **Scanner limits:** this is a lexer, not a parser, and a mistake that happens to balance is not counted above. A regex literal directly after a `)` that does not close `if`, `while`, `for` or `with` reads as division, and a division directly after `}` reads as a regex. JSX is parsed by a trial in `.tsx` and `.jsx` only; an element that fails it has its text read as code. A static import inside a block (`declare module`) is not counted.')
  out.push('- A subsystem is the first directory under a context; files directly in a context form `<context>/(root)`.')
  out.push('')
  out.push('Edge labels read `value + type-only` (`12 + 3t`); a dashed arrow is an edge with no value import at all.')
  out.push('')
  out.push('## Process contexts')
  out.push('')
  out.push(mermaidBlock(graph.contexts, graph.contextEdges, (c) => `${c.id}<br/>${num(c.files)} files, ${num(c.loc)} LOC`))
  out.push('')
  out.push(table(['Context', 'Files', 'LOC', 'Subsystems', 'Imports inside'], graph.contexts.map((c) => [code(c.id), num(c.files), num(c.loc), num(c.subsystems), num(c.internalImports)])))
  out.push('')
  out.push('## Subsystems per context')
  out.push('')
  out.push(`Each diagram shows imports between subsystems of one context, capped at ${MAX_DIAGRAM_NODES} subsystems and ${MAX_DIAGRAM_EDGES} edges. What a cap drops is stated under its diagram. Imports that leave the context are listed in words.`)
  for (const ctx of graph.contexts) {
    const nodes = graph.nodes.filter((n) => n.context === ctx.id)
    const edges = graph.edges.filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to))
    out.push('')
    out.push(`### ${ctx.id}`)
    out.push('')
    const capped = capDiagram(nodes, edges)
    out.push(mermaidBlock(capped.nodes, capped.edges, (n) => `${n.id.slice(ctx.id.length + 1)}<br/>${num(n.files)} files, ${num(n.loc)} LOC`))
    out.push('')
    out.push(capped.notes.length > 0 ? `Dropped from this diagram: ${capped.notes.join(' ')}` : 'Nothing dropped from this diagram.')
    const leaving = graph.contextEdges.filter((e) => e.from === ctx.id).sort((a, b) => b.imports - a.imports || byCodeUnit(a.to, b.to))
    const arriving = graph.contextEdges.filter((e) => e.to === ctx.id).sort((a, b) => b.imports - a.imports || byCodeUnit(a.from, b.from))
    out.push('')
    out.push(`Imports out: ${leaving.length > 0 ? leaving.map((e) => `${code(e.to)} ${edgeLabel(e)}`).join(', ') : 'none'}. Imported by: ${arriving.length > 0 ? arriving.map((e) => `${code(e.from)} ${edgeLabel(e)}`).join(', ') : 'none'}.`)
  }
  out.push('')
  out.push('## Largest subsystems')
  out.push('')
  const largest = [...graph.nodes].sort((a, b) => b.loc - a.loc || byCodeUnit(a.id, b.id))
  out.push(`The ${Math.min(TOP_SUBSYSTEMS, largest.length)} largest of ${largest.length}, by LOC.`)
  out.push('')
  out.push(table(['Subsystem', 'Files', 'LOC', 'Imports inside'], largest.slice(0, TOP_SUBSYSTEMS).map((n) => [code(n.id), num(n.files), num(n.loc), num(n.internalImports)])))
  out.push('')
  out.push('## Most depended-on modules')
  out.push('')
  out.push(`The ${graph.fanIn.length} of ${num(graph.filesWithImporters)} imported files with the most distinct importing files. "Outside" counts importers from another subsystem.`)
  out.push('')
  out.push(table(['File', 'Importers', 'Outside', 'Value imports', 'Type-only imports'], graph.fanIn.map((r) => [code(r.file), num(r.importers), num(r.outsideSubsystem), num(r.value), num(r.typeOnly)])))
  out.push('')
  out.push('## Forbidden boundary crossings')
  out.push('')
  out.push('Imports that cross a boundary CLAUDE.md forbids. Reported here; this script fails on none of them.')
  out.push('')
  out.push(table(['Rule', 'Value', 'Type-only', 'Why it is a rule'], FORBIDDEN.map((rule) => {
    const hits = graph.crossings.filter((c) => c.rule === rule.id)
    return [code(rule.id), num(hits.filter((c) => c.kind === 'value').length), num(hits.filter((c) => c.kind === 'type-only').length), rule.source]
  })))
  out.push('')
  if (graph.crossings.length === 0) {
    out.push('None found.')
  } else {
    out.push(table(['Rule', 'File', 'Imports', 'Kind'], graph.crossings.map((c) => [code(c.rule), code(`${c.file}:${c.line}`), code(c.specifier), c.syntax === 'static' || c.syntax === 'reexport' ? c.kind : `${c.kind} (${c.syntax})`])))
  }
  out.push('')
  if (graph.unresolved.length > 0) {
    out.push('## Imports that resolve to nothing')
    out.push('')
    out.push(`${graph.unresolved.length} found${graph.unresolved.length > MAX_UNRESOLVED_LISTED ? `; the first ${MAX_UNRESOLVED_LISTED} are listed, and graph.json has them all` : ''}.`)
    out.push('')
    out.push(table(['File', 'Specifier'], graph.unresolved.slice(0, MAX_UNRESOLVED_LISTED).map((u) => [code(`${u.file}:${u.line}`), code(u.specifier)])))
    out.push('')
  }
  if (graph.lexProblems.length > 0) {
    out.push('## Files the scanner could not read cleanly')
    out.push('')
    out.push(table(['File', 'Problem'], graph.lexProblems.map((p) => [code(`${p.file}:${p.line}`), p.kind])))
    out.push('')
  }
  return `${out.join('\n')}`
}

/** The two generated files, exactly as they go to disk. */
export function generate(root) {
  const graph = buildGraph(root)
  return {
    graph,
    outputs: {
      [JSON_OUT]: `${JSON.stringify(graph, null, 2)}\n`,
      [MD_OUT]: renderMarkdown(graph)
    }
  }
}

// ---------------------------------------------------------------- CLI

function main(argv) {
  let check = false
  let root = process.cwd()
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true
    else if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i])
    else {
      console.error(`Unknown argument: ${argv[i]}\nUsage: architecture-graph.mjs [--check] [--root <dir>]`)
      return 2
    }
  }
  const { graph, outputs } = generate(root)
  const summary = `${graph.stats.files} files, ${graph.nodes.length} subsystems, ${graph.edges.length} edges, ${graph.crossings.length} forbidden crossings (${graph.crossings.filter((c) => c.kind === 'value').length} value), ${graph.unresolved.length} unresolved, scan trouble in ${graph.stats.filesWithLexProblems} file(s)`
  if (check) {
    const stale = Object.entries(outputs)
      .filter(([rel, content]) => {
        const file = path.join(root, rel)
        return !fs.existsSync(file) || fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== content
      })
      .map(([rel]) => rel)
    if (stale.length > 0) {
      console.error(`Architecture graph is stale: ${stale.join(', ')}\nRun: npm run arch:graph`)
      return 1
    }
    console.log(`Architecture graph is current: ${summary}`)
    return 0
  }
  fs.mkdirSync(path.join(root, OUT_DIR), { recursive: true })
  for (const [rel, content] of Object.entries(outputs)) fs.writeFileSync(path.join(root, rel), content)
  console.log(`Wrote ${JSON_OUT} and ${MD_OUT}: ${summary}`)
  return 0
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
