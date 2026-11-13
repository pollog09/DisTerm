// The repo's system map: `docs/system-map.json`, written by an agent, committed by a person, and only
// ever READ by DisTerm (CLAUDE.md "System map" in docs/reference/agent-graph.md). Pure, no Node imports:
// the core reads the file and the renderer draws it, and both go through this validator.
//
// The file is hostile input like any other repo content. It is validated field by field (never spread,
// unknown keys ignored, `__proto__` never read), every string is made one line, and a map that fails any
// rule is not drawn at all: the view lists its problems instead, so the agent that wrote it can fix them.
import { oneLine } from './one-line'

export const SYSTEM_MAP_FILE = 'docs/system-map.json'
export const SYSTEM_MAP_VERSION = 1
export const SYSTEM_MAP_MAX_BYTES = 1_048_576
export const SYSTEM_MAP_MAX_PARTS = 200
export const SYSTEM_MAP_MAX_GLOBS = 50 // per part
export const SYSTEM_MAP_MAX_TOTAL_GLOBS = 2000 // whole map
export const SYSTEM_MAP_GLOB_MAX = 200 // chars
export const SYSTEM_MAP_MAX_STARS_PER_NAME = 3 // `*` in one segment
export const SYSTEM_MAP_MAX_GLOBSTARS = 4 // `**` segments
export const SYSTEM_MAP_MATCH_PATH_MAX = 4096 // longer paths never match
export const SYSTEM_MAP_CHECK_BUDGET = 60_000_000 // steps per empty-parts check
export const SYSTEM_MAP_OWNER_BUDGET = 2_000_000 // steps per owner lookup
export const SYSTEM_MAP_MAX_LINKS = 1000
export const SYSTEM_MAP_MAX_FLOWS = 200
export const SYSTEM_MAP_MAX_STEPS = 100 // per flow
export const SYSTEM_MAP_MAX_TOTAL_STEPS = 2000
export const SYSTEM_MAP_MAX_PROBLEMS = 50
export const SYSTEM_MAP_FILE_LIST_MAX = 50_000
export const SYSTEM_MAP_NO_FOLDER_MESSAGE = 'This canvas has no folder, so there is no repo to map.'

export type SystemMapPartKind = 'caller' | 'service' | 'store' | 'worker' | 'external'
/** Column order, left to right. */
export const SYSTEM_MAP_KINDS: readonly SystemMapPartKind[] = ['caller', 'service', 'store', 'worker', 'external']
export type SystemMapMark = 'guard' | 'refusal'
const SYSTEM_MAP_MARKS: readonly SystemMapMark[] = ['guard', 'refusal']

export interface SystemMapPart { id: string; label: string; subtitle?: string; kind: SystemMapPartKind; files: string[] }
export interface SystemMapLink { from: string; to: string; label?: string }
export interface SystemMapStep { from: string; to: string; label: string; mark?: SystemMapMark }
export interface SystemMapFlow { id: string; name: string; group: string; steps: SystemMapStep[] }
export interface SystemMap { version: 1; title: string; parts: SystemMapPart[]; links: SystemMapLink[]; flows: SystemMapFlow[] }

export interface SystemMapCommit { sha: string; ts: number /* ms */; subject: string }
export type SystemMapFileCheck = 'checked' | 'not-git' | 'too-many-files' | 'failed' | 'over-budget'
export type SystemMapRead =
  | { kind: 'missing' }
  | { kind: 'invalid'; problems: string[]; lastCommit: SystemMapCommit | null }
  | { kind: 'valid'; map: SystemMap; emptyParts: string[]; fileCheck: SystemMapFileCheck; lastCommit: SystemMapCommit | null }
export type SystemMapResult = { ok: true; read: SystemMapRead } | { ok: false; reason: string }

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TITLE_MAX = 120
const LABEL_MAX = 80
const GROUP_MAX = 60
const STEP_LABEL_MAX = 160

/** A field of a parsed JSON object, own properties only: `__proto__` and inherited names read as absent. */
function field(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) && key !== '__proto__' ? obj[key] : undefined
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** A string value shown inside a problem: one line, quoted, cut short. */
function shown(v: string): string {
  return JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}…` : v)
}

class Problems {
  readonly list: string[] = []
  add(path: string, sentence: string): void {
    this.list.push(path ? `${path}: ${sentence}` : sentence)
  }
}

/** A string field: one-lined and trimmed. `undefined` when absent or empty (a problem when required). */
function readString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  max: number,
  required: boolean,
  problems: Problems
): string | undefined {
  const raw = field(obj, key)
  if (raw === undefined) {
    if (required) problems.add(path, 'is missing.')
    return undefined
  }
  if (typeof raw !== 'string') {
    problems.add(path, 'must be a string.')
    return undefined
  }
  const value = oneLine(raw).trim()
  if (!value) {
    if (required) problems.add(path, 'is empty.')
    return undefined
  }
  if (value.length > max) {
    problems.add(path, `is ${value.length} characters; the limit is ${max}.`)
    return undefined
  }
  return value
}

/** An optional list field: absent = `[]`; anything else that is not a list is a problem (null). */
function readList(obj: Record<string, unknown>, key: string, required: boolean, problems: Problems): unknown[] | null {
  const raw = field(obj, key)
  if (raw === undefined) {
    if (required) problems.add(key, 'is missing.')
    return required ? null : []
  }
  if (!Array.isArray(raw)) {
    problems.add(key, 'must be a list.')
    return null
  }
  return raw
}

function readId(obj: Record<string, unknown>, path: string, problems: Problems): string | undefined {
  const raw = field(obj, 'id')
  if (raw === undefined) {
    problems.add(path, 'is missing.')
    return undefined
  }
  if (typeof raw !== 'string') {
    problems.add(path, 'must be a string.')
    return undefined
  }
  const id = oneLine(raw).trim()
  if (!ID_RE.test(id)) {
    problems.add(path, `${shown(id)} is not a valid id (letters, digits, ., _ and -, 64 at most, starting with a letter or digit).`)
    return undefined
  }
  return id
}

/** Validate a system map file's text. Every problem is collected; at most 50 are listed. */
export function parseSystemMap(text: string): { ok: true; map: SystemMap } | { ok: false; problems: string[] } {
  const bytes = utf8Bytes(text)
  if (bytes > SYSTEM_MAP_MAX_BYTES) return { ok: false, problems: [`The file is ${bytes} bytes; the limit is ${SYSTEM_MAP_MAX_BYTES}.`] }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, problems: [`Not valid JSON: ${oneLine(message).slice(0, 200)}`] }
  }
  if (!isObject(root)) return { ok: false, problems: ['The file must hold one JSON object.'] }

  const problems = new Problems()
  if (field(root, 'version') !== SYSTEM_MAP_VERSION) problems.add('version', `must be ${SYSTEM_MAP_VERSION}.`)
  const title = readString(root, 'title', 'title', TITLE_MAX, true, problems)

  // Parts
  const parts: SystemMapPart[] = []
  const partIndex = new Map<string, number>()
  const rawParts = readList(root, 'parts', true, problems)
  if (rawParts) {
    if (rawParts.length === 0) problems.add('parts', 'must list at least one part.')
    if (rawParts.length > SYSTEM_MAP_MAX_PARTS) problems.add('parts', `${rawParts.length} parts; the limit is ${SYSTEM_MAP_MAX_PARTS}.`)
    rawParts.forEach((raw, i) => {
      const at = `parts[${i}]`
      if (!isObject(raw)) {
        problems.add(at, 'must be an object.')
        return
      }
      const id = readId(raw, `${at}.id`, problems)
      if (id !== undefined) {
        const first = partIndex.get(id)
        if (first !== undefined) problems.add(`${at}.id`, `${shown(id)} is already used by parts[${first}].`)
        else partIndex.set(id, i)
      }
      const label = readString(raw, 'label', `${at}.label`, LABEL_MAX, true, problems)
      const subtitle = readString(raw, 'subtitle', `${at}.subtitle`, LABEL_MAX, false, problems)
      const rawKind = field(raw, 'kind')
      let kind: SystemMapPartKind | undefined
      if (rawKind === undefined) problems.add(`${at}.kind`, 'is missing.')
      else if (typeof rawKind !== 'string') problems.add(`${at}.kind`, 'must be a string.')
      else {
        const k = oneLine(rawKind).trim()
        if ((SYSTEM_MAP_KINDS as readonly string[]).includes(k)) kind = k as SystemMapPartKind
        else problems.add(`${at}.kind`, `${shown(k)} is not one of ${SYSTEM_MAP_KINDS.join(', ')}.`)
      }
      const rawFiles = field(raw, 'files')
      const files: string[] = []
      let filesOk = true
      if (rawFiles === undefined) {
        problems.add(`${at}.files`, 'is missing.')
        filesOk = false
      } else if (!Array.isArray(rawFiles)) {
        problems.add(`${at}.files`, 'must be a list.')
        filesOk = false
      } else {
        if (rawFiles.length > SYSTEM_MAP_MAX_GLOBS) {
          problems.add(`${at}.files`, `${rawFiles.length} globs; the limit is ${SYSTEM_MAP_MAX_GLOBS}.`)
          filesOk = false
        }
        rawFiles.forEach((g, j) => {
          if (typeof g !== 'string') {
            problems.add(`${at}.files[${j}]`, 'must be a string.')
            filesOk = false
            return
          }
          const glob = oneLine(g).trim()
          const problem = systemMapGlobProblem(glob)
          if (problem) {
            problems.add(`${at}.files[${j}]`, problem)
            filesOk = false
          } else files.push(glob)
        })
      }
      if (id !== undefined && label !== undefined && kind !== undefined && filesOk) {
        parts.push({ id, label, ...(subtitle !== undefined ? { subtitle } : {}), kind, files })
      }
    })
  }
  if (rawParts) {
    let totalGlobs = 0
    for (const raw of rawParts) {
      const files = isObject(raw) ? field(raw, 'files') : undefined
      if (Array.isArray(files)) totalGlobs += files.length
    }
    if (totalGlobs > SYSTEM_MAP_MAX_TOTAL_GLOBS) problems.add('parts', `${totalGlobs} file globs in all; the limit is ${SYSTEM_MAP_MAX_TOTAL_GLOBS}.`)
  }
  const isPart = (id: string): boolean => partIndex.has(id)

  /** `from` / `to` of a link or step: a string naming a part. */
  const readEnd = (obj: Record<string, unknown>, key: 'from' | 'to', at: string): string | undefined => {
    const raw = field(obj, key)
    if (raw === undefined) {
      problems.add(`${at}.${key}`, 'is missing.')
      return undefined
    }
    if (typeof raw !== 'string') {
      problems.add(`${at}.${key}`, 'must be a string.')
      return undefined
    }
    const id = oneLine(raw).trim()
    if (!isPart(id)) {
      problems.add(`${at}.${key}`, `${shown(id)} is not a part.`)
      return undefined
    }
    return id
  }

  // Links
  const links: SystemMapLink[] = []
  const rawLinks = readList(root, 'links', false, problems)
  if (rawLinks) {
    if (rawLinks.length > SYSTEM_MAP_MAX_LINKS) problems.add('links', `${rawLinks.length} links; the limit is ${SYSTEM_MAP_MAX_LINKS}.`)
    const seen = new Set<string>()
    rawLinks.forEach((raw, i) => {
      const at = `links[${i}]`
      if (!isObject(raw)) {
        problems.add(at, 'must be an object.')
        return
      }
      const from = readEnd(raw, 'from', at)
      const to = readEnd(raw, 'to', at)
      const label = readString(raw, 'label', `${at}.label`, LABEL_MAX, false, problems)
      if (from === undefined || to === undefined) return
      if (from === to) {
        problems.add(at, `goes from ${from} to itself.`)
        return
      }
      const key = `${from}>${to}`
      if (seen.has(key)) {
        problems.add(at, `repeats ${from} -> ${to}.`)
        return
      }
      seen.add(key)
      links.push({ from, to, ...(label !== undefined ? { label } : {}) })
    })
  }

  // Flows
  const flows: SystemMapFlow[] = []
  const rawFlows = readList(root, 'flows', false, problems)
  if (rawFlows) {
    if (rawFlows.length > SYSTEM_MAP_MAX_FLOWS) problems.add('flows', `${rawFlows.length} flows; the limit is ${SYSTEM_MAP_MAX_FLOWS}.`)
    const flowIndex = new Map<string, number>()
    let totalSteps = 0
    rawFlows.forEach((raw, i) => {
      const at = `flows[${i}]`
      if (!isObject(raw)) {
        problems.add(at, 'must be an object.')
        return
      }
      const id = readId(raw, `${at}.id`, problems)
      if (id !== undefined) {
        const first = flowIndex.get(id)
        if (first !== undefined) problems.add(`${at}.id`, `${shown(id)} is already used by flows[${first}].`)
        else flowIndex.set(id, i)
      }
      const name = readString(raw, 'name', `${at}.name`, LABEL_MAX, true, problems)
      const group = readString(raw, 'group', `${at}.group`, GROUP_MAX, true, problems)
      const rawSteps = field(raw, 'steps')
      const steps: SystemMapStep[] = []
      let stepsOk = true
      if (rawSteps === undefined) {
        problems.add(`${at}.steps`, 'is missing.')
        stepsOk = false
      } else if (!Array.isArray(rawSteps)) {
        problems.add(`${at}.steps`, 'must be a list.')
        stepsOk = false
      } else {
        totalSteps += rawSteps.length
        if (rawSteps.length === 0) {
          problems.add(`${at}.steps`, 'must list at least one step.')
          stepsOk = false
        }
        if (rawSteps.length > SYSTEM_MAP_MAX_STEPS) {
          problems.add(`${at}.steps`, `${rawSteps.length} steps; the limit is ${SYSTEM_MAP_MAX_STEPS}.`)
          stepsOk = false
        }
        rawSteps.forEach((s, j) => {
          const sat = `${at}.steps[${j}]`
          if (!isObject(s)) {
            problems.add(sat, 'must be an object.')
            stepsOk = false
            return
          }
          const from = readEnd(s, 'from', sat)
          const to = readEnd(s, 'to', sat)
          const label = readString(s, 'label', `${sat}.label`, STEP_LABEL_MAX, true, problems)
          const rawMark = field(s, 'mark')
          let mark: SystemMapMark | undefined
          let markOk = true
          if (rawMark !== undefined) {
            if (typeof rawMark !== 'string') {
              problems.add(`${sat}.mark`, 'must be a string.')
              markOk = false
            } else {
              const m = oneLine(rawMark).trim()
              if ((SYSTEM_MAP_MARKS as readonly string[]).includes(m)) mark = m as SystemMapMark
              else {
                problems.add(`${sat}.mark`, `${shown(m)} is not one of ${SYSTEM_MAP_MARKS.join(', ')}.`)
                markOk = false
              }
            }
          }
          if (from !== undefined && to !== undefined && from === to) {
            problems.add(sat, `goes from ${from} to itself.`)
            stepsOk = false
            return
          }
          if (from === undefined || to === undefined || label === undefined || !markOk) {
            stepsOk = false
            return
          }
          steps.push({ from, to, label, ...(mark !== undefined ? { mark } : {}) })
        })
      }
      if (id !== undefined && name !== undefined && group !== undefined && stepsOk) flows.push({ id, name, group, steps })
    })
    if (totalSteps > SYSTEM_MAP_MAX_TOTAL_STEPS) {
      problems.add('flows', `${totalSteps} steps in all; the limit is ${SYSTEM_MAP_MAX_TOTAL_STEPS}.`)
    }
  }

  if (problems.list.length > 0) {
    const all = problems.list
    if (all.length <= SYSTEM_MAP_MAX_PROBLEMS) return { ok: false, problems: all }
    const more = all.length - SYSTEM_MAP_MAX_PROBLEMS
    return { ok: false, problems: [...all.slice(0, SYSTEM_MAP_MAX_PROBLEMS), `…and ${more} more problems.`] }
  }
  return { ok: true, map: { version: 1, title: title!, parts, links, flows } }
}

const UNSUPPORTED_GLOB_CHARS = ['{', '}', '[', ']', '!'] as const

/** Runs of `*` inside a name collapse to one: same meaning, less work. */
function collapseStars(name: string): string {
  return name.replace(/\*+/g, '*')
}

function countStars(name: string): number {
  let n = 0
  for (const ch of name) if (ch === '*') n++
  return n
}

/** Why `glob` is not a usable file glob, or null. */
export function systemMapGlobProblem(glob: string): string | null {
  if (glob.length === 0) return 'is empty.'
  if (glob.length > SYSTEM_MAP_GLOB_MAX) return `is ${glob.length} characters; the limit is ${SYSTEM_MAP_GLOB_MAX}.`
  if (glob.startsWith('/')) return `${shown(glob)} starts with /; globs are relative to the repo root.`
  if (glob.includes('\\')) return `${shown(glob)}: \\ is not supported; use /.`
  for (const ch of UNSUPPORTED_GLOB_CHARS) {
    if (glob.includes(ch)) return `${shown(glob)}: ${ch} is not supported.`
  }
  const segments = stripTrailingSlash(glob).split('/')
  if (segments.some((s) => s === '')) return `${shown(glob)} has an empty segment.`
  if (segments.some((s) => s === '.' || s === '..')) return `${shown(glob)} has a . or .. segment.`
  if (segments.some((s) => s !== '**' && countStars(collapseStars(s)) > SYSTEM_MAP_MAX_STARS_PER_NAME)) {
    return `${shown(glob)}: a name may hold at most ${SYSTEM_MAP_MAX_STARS_PER_NAME} *.`
  }
  if (compileSystemMapGlob(glob).tokens.filter((t) => t.kind === 'globstar').length > SYSTEM_MAP_MAX_GLOBSTARS) {
    return `${shown(glob)} has more than ${SYSTEM_MAP_MAX_GLOBSTARS} ** segments.`
  }
  return null
}

function stripTrailingSlash(glob: string): string {
  return glob.endsWith('/') ? glob.slice(0, -1) : glob
}

// GLOBS ARE MATCHED WITHOUT REGEXES, UNDER A BUDGET. The map is hostile input read on the core thread
// (the empty-parts check, the hook POST, `nodeterm map --path`), and a backtracking RegExp built from
// `*a*a*a*a*a*b` or a run of `**` segments can take minutes on one path. The matcher below is a
// segment-wise reachability pass plus a one-backtrack-point wildcard match per segment: its worst cost is
// O(glob characters × path length), and every step is charged to a budget that throws when spent.

export type GlobToken = { kind: 'globstar' } | { kind: 'name'; text: string; wild: boolean }
export interface CompiledGlob {
  /** As written. */
  glob: string
  /** No `*` or `?` anywhere: prefix match by whole segments. */
  literal: boolean
  /** After collapsing; for a literal glob, all `name` with wild false. */
  tokens: GlobToken[]
  /** The leading wildcard-free name tokens' texts (all tokens for a literal glob): the index key, so a
   *  glob is only ever tried on files under these folders. */
  prefix: readonly string[]
  /** `prefix.join('/')`, '' when the prefix is empty. */
  prefixKey: string
  /** `prefix[0] ?? null`. */
  head: string | null
}
export interface MatchBudget { left: number }
export class SystemMapBudgetError extends Error {
  constructor() {
    super('The system map glob match ran out of budget.')
  }
}

function charge(budget: MatchBudget, steps = 1): void {
  budget.left -= steps
  if (budget.left <= 0) throw new SystemMapBudgetError()
}

/** A glob as tokens: consecutive `**` segments become one globstar, runs of `*` in a name one `*`.
 *  Call only on a glob `systemMapGlobProblem` accepted (or from it). */
export function compileSystemMapGlob(glob: string): CompiledGlob {
  const tokens: GlobToken[] = []
  for (const seg of stripTrailingSlash(glob).split('/')) {
    if (seg === '**') {
      if (tokens[tokens.length - 1]?.kind !== 'globstar') tokens.push({ kind: 'globstar' })
      continue
    }
    const text = collapseStars(seg)
    tokens.push({ kind: 'name', text, wild: text.includes('*') || text.includes('?') })
  }
  const literal = tokens.every((t) => t.kind === 'name' && !t.wild)
  const prefix: string[] = []
  for (const t of tokens) {
    if (t.kind !== 'name' || t.wild) break
    prefix.push(t.text)
  }
  return { glob, literal, tokens, prefix, prefixKey: prefix.join('/'), head: prefix[0] ?? null }
}

/** One path segment against one glob name; `*` never crosses `/` because neither string holds one. */
export function matchGlobName(pattern: string, name: string, budget: MatchBudget): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    charge(budget)
    return pattern === name
  }
  let p = 0
  let n = 0
  let star = -1
  let starName = 0
  while (n < name.length) {
    charge(budget)
    if (p < pattern.length && (pattern[p] === '?' || (pattern[p] !== '*' && pattern[p] === name[n]))) {
      p++
      n++
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p
      starName = n
      p++
    } else if (star >= 0) {
      starName++
      n = starName
      p = star + 1
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

/** One path, split once, with reach arrays sized for it. Reused across globs and files. */
export interface PreparedSystemMapPath {
  segments: readonly string[]
  /** Length >= segments.length + 1. All zero between matches (invariant). */
  reach: Uint8Array
  next: Uint8Array
}

/** Splits and checks `relPath` (charged P + 1). Reuses `scratch`'s arrays when they are long enough,
 *  else allocates new ones (charged 2 × (P + 1)). Null for an empty path, one over
 *  SYSTEM_MAP_MATCH_PATH_MAX, or one with an empty segment: such a path matches nothing. */
export function prepareSystemMapPath(relPath: string, budget: MatchBudget, scratch?: PreparedSystemMapPath | null): PreparedSystemMapPath | null {
  if (relPath.length === 0 || relPath.length > SYSTEM_MAP_MATCH_PATH_MAX) {
    charge(budget)
    return null
  }
  const segments = relPath.split('/')
  const P = segments.length
  charge(budget, P + 1)
  for (let i = 0; i < P; i++) if (segments[i] === '') return null
  if (scratch && scratch.reach.length >= P + 1 && scratch.next.length >= P + 1) {
    return { segments, reach: scratch.reach, next: scratch.next }
  }
  charge(budget, 2 * (P + 1))
  return { segments, reach: new Uint8Array(P + 1), next: new Uint8Array(P + 1) }
}

/**
 * The matcher proper: no fixed per-call charge. It charges every position it visits, every clear, and
 * every `matchGlobName` step, walks only the window of positions that can be reachable, and stops the
 * moment nothing is. Both arrays are all zero on every exit, a thrown SystemMapBudgetError included, so the
 * next glob or file can reuse them without a clearing pass.
 */
export function matchPreparedGlob(g: CompiledGlob, path: PreparedSystemMapPath, budget: MatchBudget): boolean {
  const s = path.segments
  const P = s.length
  const tokens = g.tokens
  // The literal prefix first: a quick reject, and for a literal glob the whole answer.
  const pl = g.prefix.length
  if (P < pl) {
    charge(budget)
    return false
  }
  for (let i = 0; i < pl; i++) {
    charge(budget)
    if (g.prefix[i] !== s[i]) return false
  }
  if (g.literal) return true
  // `reach[j]` = the tokens so far can end exactly before segment j. Only [lo, hi] can hold a true entry.
  let reach = path.reach
  let next = path.next
  const clear = (arr: Uint8Array, from: number, to: number): void => {
    charge(budget, to - from + 1)
    for (let j = from; j <= to; j++) arr[j] = 0
  }
  try {
    // The prefix is matched: start after it, with the remaining tokens.
    reach[pl] = 1
    let lo = pl
    let hi = pl
    for (let t = pl; t < tokens.length; t++) {
      const token = tokens[t]
      if (token.kind === 'globstar') {
        if (t === tokens.length - 1) {
          // At the end: one or more segments, so some position before the last must be reached.
          const answer = lo < P
          clear(reach, lo, hi)
          return answer
        }
        // Zero or more segments: every position from the first reachable one on.
        charge(budget, P - lo + 1)
        for (let j = lo; j <= P; j++) next[j] = 1
        clear(reach, lo, hi)
        hi = P
      } else {
        let nlo = -1
        let nhi = -1
        const end = Math.min(hi, P - 1)
        for (let j = lo; j <= end; j++) {
          charge(budget)
          if (reach[j] && matchGlobName(token.text, s[j], budget)) {
            next[j + 1] = 1
            if (nlo < 0) nlo = j + 1
            nhi = j + 1
          }
        }
        clear(reach, lo, hi)
        if (nlo < 0) return false
        lo = nlo
        hi = nhi
      }
      const swap = reach
      reach = next
      next = swap
    }
    const answer = reach[P] === 1
    clear(reach, lo, hi)
    return answer
  } catch (err) {
    // The budget is spent: clear without charging, bounded by P + 1, so the arrays stay reusable.
    path.reach.fill(0, 0, P + 1)
    path.next.fill(0, 0, P + 1)
    throw err
  }
}

/** prepareSystemMapPath + matchPreparedGlob, for one-off callers and tests. Throws SystemMapBudgetError
 *  when `budget.left` reaches 0. */
export function matchSystemMapGlob(g: CompiledGlob, relPath: string, budget: MatchBudget): boolean {
  const p = prepareSystemMapPath(relPath, budget)
  return p ? matchPreparedGlob(g, p, budget) : false
}

export interface IndexedGlob { order: number; partId: string; glob: CompiledGlob }

export interface CompiledSystemMap {
  map: SystemMap
  /** File order. */
  globs: ReadonlyArray<{ partId: string; glob: CompiledGlob }>
  /** Globs with a non-empty literal prefix, by `prefixKey`, each list in file order. */
  byPrefix: ReadonlyMap<string, readonly IndexedGlob[]>
  /** Globs that start with a wildcard: tried on every file. */
  wildLed: readonly IndexedGlob[]
  /** The longest literal prefix in `byPrefix`. */
  maxPrefix: number
}

/** The globs in file order, plus the literal-prefix index (built once: O(globs), at most 2000). */
export function compileSystemMap(map: SystemMap): CompiledSystemMap {
  const globs: Array<{ partId: string; glob: CompiledGlob }> = []
  const byPrefix = new Map<string, IndexedGlob[]>()
  const wildLed: IndexedGlob[] = []
  let maxPrefix = 0
  for (const part of map.parts) {
    for (const text of part.files) {
      const glob = compileSystemMapGlob(text)
      const entry: IndexedGlob = { order: globs.length, partId: part.id, glob }
      globs.push({ partId: part.id, glob })
      if (glob.prefix.length === 0) {
        wildLed.push(entry)
        continue
      }
      const list = byPrefix.get(glob.prefixKey)
      if (list) list.push(entry)
      else byPrefix.set(glob.prefixKey, [entry])
      maxPrefix = Math.max(maxPrefix, glob.prefix.length)
    }
  }
  return { map, globs, byPrefix, wildLed, maxPrefix }
}

/**
 * The indexed globs a prepared path is a candidate for: every `byPrefix` bucket of its own prefixes
 * (k = 1..min(P, maxPrefix), each lookup charged `s[k-1].length + 1`), then `wildLed`. Visiting does not
 * charge; the caller charges what it does with a candidate. `foundAtPrefix` is true for `byPrefix` entries.
 */
export function forEachSystemMapCandidate(
  byPrefix: ReadonlyMap<string, readonly IndexedGlob[]>,
  wildLed: readonly IndexedGlob[],
  maxPrefix: number,
  path: PreparedSystemMapPath,
  budget: MatchBudget,
  visit: (candidate: IndexedGlob, foundAtPrefix: boolean) => void
): void {
  const s = path.segments
  const upTo = Math.min(s.length, maxPrefix)
  let key = ''
  for (let k = 1; k <= upTo; k++) {
    key = k === 1 ? s[0] : `${key}/${s[k - 1]}`
    charge(budget, s[k - 1].length + 1)
    const list = byPrefix.get(key)
    if (list) for (const entry of list) visit(entry, true)
  }
  for (const entry of wildLed) visit(entry, false)
}

/** A candidate found under its own literal prefix: a literal glob there IS a match (it covers its path and
 *  everything under it); any other is tested. */
function candidateMatches(c: IndexedGlob, foundAtPrefix: boolean, path: PreparedSystemMapPath, budget: MatchBudget): boolean {
  if (c.glob.literal && foundAtPrefix) {
    charge(budget)
    return true
  }
  return matchPreparedGlob(c.glob, path, budget)
}

/** The part that owns a repo-relative path: the FIRST part in file order with a matching glob, under
 *  `SYSTEM_MAP_OWNER_BUDGET` steps. Only the globs the index names for this path are tried, in file order,
 *  so the answer is the one testing every glob in order would give. */
export function systemMapOwner(compiled: CompiledSystemMap, relPath: string): { partId: string; glob: string } | null | 'over-budget' {
  const budget: MatchBudget = { left: SYSTEM_MAP_OWNER_BUDGET }
  try {
    const path = prepareSystemMapPath(relPath, budget)
    if (!path) return null
    const candidates: Array<{ c: IndexedGlob; atPrefix: boolean }> = []
    forEachSystemMapCandidate(compiled.byPrefix, compiled.wildLed, compiled.maxPrefix, path, budget, (c, atPrefix) => {
      charge(budget)
      candidates.push({ c, atPrefix })
    })
    charge(budget, candidates.length + 1)
    candidates.sort((a, b) => a.c.order - b.c.order)
    for (const { c, atPrefix } of candidates) {
      if (candidateMatches(c, atPrefix, path, budget)) return { partId: c.partId, glob: c.glob.glob }
    }
    return null
  } catch (err) {
    if (err instanceof SystemMapBudgetError) return 'over-budget'
    throw err
  }
}

/**
 * Parts with globs that match none of `files`, in file order, under `SYSTEM_MAP_CHECK_BUDGET` steps. A
 * part with `files: []` is never empty. Over budget: no partial list, so no part is wrongly flagged.
 *
 * Each file is prepared once (split, arrays reused across files) and tried only against the globs whose
 * whole literal prefix it sits under, plus the wildcard-led ones, so its cost does not grow with the
 * pending globs elsewhere under a shared folder like `src/`. A part's globs drop out once it resolves
 * (lists compacted lazily), and the check stops once none is pending.
 */
export function systemMapEmptyParts(compiled: CompiledSystemMap, files: readonly string[]): { emptyParts: string[] } | { overBudget: true } {
  const budget: MatchBudget = { left: SYSTEM_MAP_CHECK_BUDGET }
  try {
    const pending = new Set<string>()
    const byPrefix = new Map<string, IndexedGlob[]>()
    /** How many buckets have each prefix length, so `maxPrefix` can fall as buckets empty. */
    const bucketsOfLength: number[] = []
    for (const [key, list] of compiled.byPrefix) {
      charge(budget, list.length)
      for (const e of list) pending.add(e.partId)
      byPrefix.set(key, [...list])
      const len = list[0].glob.prefix.length
      bucketsOfLength[len] = (bucketsOfLength[len] ?? 0) + 1
    }
    let wildLed = [...compiled.wildLed]
    charge(budget, wildLed.length + 1)
    for (const e of wildLed) pending.add(e.partId)
    let maxPrefix = compiled.maxPrefix

    /** Lists seen during one file with how many of their entries are resolved. */
    const touched = new Map<IndexedGlob[], number>()
    const note = (list: IndexedGlob[] | undefined, resolved: boolean): void => {
      if (list) touched.set(list, (touched.get(list) ?? 0) + (resolved ? 1 : 0))
    }
    let scratch: PreparedSystemMapPath | null = null
    for (const file of files) {
      if (pending.size === 0) break
      const path = prepareSystemMapPath(file, budget, scratch)
      if (!path) continue
      scratch = path
      touched.clear()
      forEachSystemMapCandidate(byPrefix, wildLed, maxPrefix, path, budget, (c, atPrefix) => {
        const current = atPrefix ? byPrefix.get(c.glob.prefixKey) : wildLed
        if (!pending.has(c.partId)) {
          charge(budget)
          note(current, true)
          return
        }
        if (candidateMatches(c, atPrefix, path, budget)) {
          pending.delete(c.partId)
          note(current, true)
        } else note(current, false)
      })
      // Compact what this file showed to be mostly resolved; an emptied bucket goes, and maxPrefix with it.
      for (const [list, resolved] of touched) {
        if (resolved * 2 <= list.length) continue
        const kept = list.filter((e) => pending.has(e.partId))
        charge(budget, kept.length + 1)
        if (list === wildLed) {
          wildLed = kept
          continue
        }
        const key = list[0].glob.prefixKey
        const len = list[0].glob.prefix.length
        if (kept.length) byPrefix.set(key, kept)
        else {
          byPrefix.delete(key)
          bucketsOfLength[len]--
          while (maxPrefix > 0 && !bucketsOfLength[maxPrefix]) maxPrefix--
        }
      }
    }
    return { emptyParts: compiled.map.parts.filter((p) => pending.has(p.id)).map((p) => p.id) }
  } catch (err) {
    if (err instanceof SystemMapBudgetError) return { overBudget: true }
    throw err
  }
}

const WINDOWS_ROOT_RE = /^[A-Za-z]:[\\/]|^\\\\/

/** POSIX-style normalisation: `//` collapsed, `.` dropped, `..` resolved; null when `..` climbs above the start. */
function normalisePath(p: string): string | null {
  const absolute = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(seg)
  }
  return (absolute ? '/' : '') + out.join('/')
}

/** `file` relative to `root` when it lies inside it (not equal to it), else null. A Windows root compares
 *  with `\` as `/` and without case; the remainder keeps `file`'s own case. */
export function relativeInsideRoot(root: string, file: string): string | null {
  const windows = WINDOWS_ROOT_RE.test(root)
  const r = normalisePath(windows ? root.replace(/\\/g, '/') : root)
  const f = normalisePath(windows ? file.replace(/\\/g, '/') : file)
  if (r === null || f === null || !r) return null
  const prefix = r.endsWith('/') ? r : `${r}/`
  const head = f.slice(0, prefix.length)
  const same = windows ? head.toLowerCase() === prefix.toLowerCase() : head === prefix
  if (!same) return null
  const rest = f.slice(prefix.length)
  return rest ? rest : null
}

/** The `map` verb's flags: only `--path`, and only with a value. */
export function systemMapArgsRefusal(args: Record<string, string>): string | null {
  for (const key of Object.keys(args)) {
    if (key !== 'path') return `map: unknown flag --${key}`
  }
  if (Object.prototype.hasOwnProperty.call(args, 'path') && !args.path) return 'map: --path needs a value'
  return null
}

/** The file format, line by line: the skill text and docs/system-map.md quote these verbatim. */
export const SYSTEM_MAP_FORMAT_LINES: readonly string[] = [
  '  { "version": 1, "title": "<repo name>",',
  '    "parts": [{ "id": "api", "label": "API", "subtitle": "Go API :8080", "kind": "service", "files": ["cmd/api/**", "internal/api/**"] }],',
  '    "links": [{ "from": "web", "to": "api", "label": "REST" }],',
  '    "flows": [{ "id": "login", "name": "Log in", "group": "Auth", "steps": [{ "from": "web", "to": "api", "label": "POST /login" }, { "from": "api", "to": "db", "label": "check the password", "mark": "guard" }] }] }',
  '  kind is caller, service, store, worker or external (outside the repo; its files are usually []). mark is guard or refusal.',
  '  Ids are letters, digits, `.`, `_` and `-`, 64 at most. files are globs from the repo root: `*` inside a name, `**` across folders,',
  '  `?` one character; a path with no wildcard covers itself and everything under it. No `{}`, `[]` or `!`.',
  '  At most 3 `*` in one name and 4 `**` in one glob. The first part whose globs match a file owns it, so list more specific parts first.'
]

/** The launch prompt of the Map-this-repo session. One paragraph; fits the inline launch budget. */
export const SYSTEM_MAP_PROMPT =
  'Write a system map of this repo to docs/system-map.json. Start from its code map: read docs/architecture/CODEMAP.md, ' +
  'or the map CLAUDE.md or AGENTS.md points to, and use it to pick the parts and their files. ' +
  'If the understand workflow is available, run it to trace how the parts connect. ' +
  'Then read the code and write only what you have verified in it. ' +
  'It is JSON: {"version":1,"title":string,"parts":[{"id","label","subtitle"?,"kind":"caller|service|store|worker|external","files":[globs from the repo root]}],' +
  '"links":[{"from","to","label"?}],"flows":[{"id","name","group","steps":[{"from","to","label","mark"?:"guard|refusal"}]}]}. ' +
  'Ids are letters, digits, . _ -. If the nodeterm command is available, run nodeterm map to check the file. ' +
  'Do not commit it; leave it for me to review.'

export const SYSTEM_MAP_NODE_TITLE = 'System map'
