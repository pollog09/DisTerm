import { execFile } from 'child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'util'
import { errorText } from '../../shared/error-text'
import { oneLine } from '../../shared/one-line'
import { quoteRemotePath } from '../../shared/ssh'
import {
  SYSTEM_MAP_FILE,
  SYSTEM_MAP_FILE_LIST_MAX,
  SYSTEM_MAP_MAX_BYTES,
  SYSTEM_MAP_NO_FOLDER_MESSAGE,
  compileSystemMap,
  parseSystemMap,
  systemMapEmptyParts,
  type CompiledSystemMap,
  type SystemMapCommit,
  type SystemMapFileCheck,
  type SystemMapRead,
  type SystemMapResult
} from '../../shared/system-map'
import { gitEnv } from '../git-env'
import { localGitCommand } from '../wsl-git'
import type { ShipConfigRouter } from '../ship-config/handlers'
import { newShipScriptNonce } from '../ship-config/discover'

const run = promisify(execFile)

/** The system map is read where the project's agents run, through the same router as ship config. */
export type SystemMapRouter = ShipConfigRouter

export interface SystemMapReadOutcome {
  result: SystemMapResult
  /** Absolute roots edits are matched under: local `[cwd, realpath(cwd)]` deduped; remote `[remoteCwd]`. */
  roots: string[]
  compiled: CompiledSystemMap | null // non-null only for a valid map
}

const COMMIT_SUBJECT_MAX = 120
const FILES_MAX_BUFFER = 64 * 1024 * 1024
const NOT_REGULAR_PROBLEM = `${SYSTEM_MAP_FILE} is not a regular file.`

function sizeProblem(bytes: number): string {
  return `The file is ${bytes} bytes; the limit is ${SYSTEM_MAP_MAX_BYTES}.`
}

/** Pure: `<sha>\t<unix seconds>\t<subject>` -> commit (subject oneLine, 120 chars), or null. */
export function parseCommitLine(line: string): SystemMapCommit | null {
  const first = line.split('\n').find((l) => l.trim() !== '')
  if (!first) return null
  const tab1 = first.indexOf('\t')
  const tab2 = tab1 < 0 ? -1 : first.indexOf('\t', tab1 + 1)
  if (tab1 < 0 || tab2 < 0) return null
  const sha = first.slice(0, tab1).trim()
  const seconds = first.slice(tab1 + 1, tab2).trim()
  if (!/^[0-9a-f]{7,64}$/i.test(sha) || !/^\d+$/.test(seconds)) return null
  return { sha, ts: Number(seconds) * 1000, subject: oneLine(first.slice(tab2 + 1)).slice(0, COMMIT_SUBJECT_MAX) }
}

/** The map's validation plus the file check, shared by the local and remote reads. The file list is
 *  only fetched for a map that validated. */
async function validRead(
  text: string,
  lastCommit: SystemMapCommit | null,
  listing: () => Promise<{ check: SystemMapFileCheck; files: readonly string[] }>
): Promise<{ read: SystemMapRead; compiled: CompiledSystemMap | null }> {
  const parsed = parseSystemMap(text)
  if (!parsed.ok) return { read: { kind: 'invalid', problems: parsed.problems, lastCommit }, compiled: null }
  const compiled = compileSystemMap(parsed.map)
  const { check, files } = await listing()
  let fileCheck: SystemMapFileCheck = check
  let emptyParts: string[] = []
  if (check === 'checked') {
    // Bounded (SYSTEM_MAP_CHECK_BUDGET steps): a map whose globs cost too much is reported, never a hang.
    const result = systemMapEmptyParts(compiled, files)
    if ('overBudget' in result) fileCheck = 'over-budget'
    else emptyParts = result.emptyParts
  }
  return { read: { kind: 'valid', map: parsed.map, emptyParts, fileCheck, lastCommit }, compiled }
}

/** Repo-relative paths, one per line. A git-quoted name (a leading `"`) is skipped: it is not a path. */
function fileLines(text: string): string[] {
  return text.split('\n').filter((l) => l !== '' && !l.startsWith('"'))
}

async function localLastCommit(cwd: string): Promise<SystemMapCommit | null> {
  try {
    const cmd = localGitCommand(cwd, ['log', '-1', '--format=%H%x09%ct%x09%s', '--', SYSTEM_MAP_FILE], { env: gitEnv(), timeout: 10_000 })
    const { stdout } = await run(cmd.file, cmd.args, cmd.options)
    return parseCommitLine(cmd.mapOutput(String(stdout)))
  } catch {
    return null
  }
}

async function localFileListing(cwd: string): Promise<{ check: SystemMapFileCheck; files: readonly string[] }> {
  try {
    const cmd = localGitCommand(cwd, ['-c', 'core.quotePath=false', 'ls-files', '-co', '--exclude-standard'], {
      env: gitEnv(),
      timeout: 10_000,
      maxBuffer: FILES_MAX_BUFFER
    })
    const { stdout } = await run(cmd.file, cmd.args, cmd.options)
    const lines = fileLines(cmd.mapOutput(String(stdout)))
    if (lines.length > SYSTEM_MAP_FILE_LIST_MAX) return { check: 'too-many-files', files: [] }
    return { check: 'checked', files: lines }
  } catch (e) {
    const err = e as { stderr?: unknown }
    if (/not a git repository/i.test(String(err.stderr ?? ''))) return { check: 'not-git', files: [] }
    return { check: 'failed', files: [] }
  }
}

async function localRoots(cwd: string): Promise<string[]> {
  const roots = [cwd]
  try {
    const real = await fs.promises.realpath(cwd)
    if (real !== cwd) roots.push(real)
  } catch {
    /* a folder that cannot be resolved matches under its own path only */
  }
  return roots
}

async function readLocal(cwd: string): Promise<SystemMapReadOutcome> {
  const roots = await localRoots(cwd)
  const file = path.join(cwd, SYSTEM_MAP_FILE)
  let stat: fs.Stats
  try {
    // stat before open: a FIFO at the path must never be opened, and a link is followed to what it names.
    stat = await fs.promises.stat(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { result: { ok: true, read: { kind: 'missing' } }, roots, compiled: null }
    return { result: { ok: false, reason: `Could not read ${SYSTEM_MAP_FILE}: ${errorText(err)}` }, roots, compiled: null }
  }
  const lastCommit = await localLastCommit(cwd)
  if (!stat.isFile()) return { result: { ok: true, read: { kind: 'invalid', problems: [NOT_REGULAR_PROBLEM], lastCommit } }, roots, compiled: null }
  if (stat.size > SYSTEM_MAP_MAX_BYTES) {
    return { result: { ok: true, read: { kind: 'invalid', problems: [sizeProblem(stat.size)], lastCommit } }, roots, compiled: null }
  }
  let text: string
  try {
    text = await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    return { result: { ok: false, reason: `Could not read ${SYSTEM_MAP_FILE}: ${errorText(err)}` }, roots, compiled: null }
  }
  const { read, compiled } = await validRead(text, lastCommit, () => localFileListing(cwd))
  return { result: { ok: true, read }, roots, compiled }
}

/**
 * The read on a host, as ONE function called on its last line (a cut-off script runs nothing), printing
 * only nonce-prefixed markers. Read-only: it never writes, and there is no write path in this module.
 */
export function systemMapScript(nonce: string, remoteCwd: string): string {
  const n = nonce
  return (
    `nt_system_map() {\n` +
    `cd -- ${quoteRemotePath(remoteCwd)} 2>/dev/null || { printf '\\n${n} nofolder\\n'; printf '\\n${n} done\\n'; exit 0; }\n` +
    `f=${SYSTEM_MAP_FILE}\n` +
    `if [ ! -e "$f" ] && [ ! -L "$f" ]; then printf '\\n${n} nofile\\n'\n` +
    `elif [ ! -f "$f" ]; then printf '\\n${n} notregular\\n'\n` +
    `else s=$(wc -c < "$f" | tr -d ' '); if [ "$s" -gt ${SYSTEM_MAP_MAX_BYTES} ]; then printf '\\n${n} toolarge %s\\n' "$s"\n` +
    `else printf '\\n${n} file\\n'; cat -- "$f"; printf '\\n${n} endfile\\n'; fi; fi\n` +
    `printf '\\n${n} commit\\n'; git log -1 --format='%H%x09%ct%x09%s' -- "$f" 2>/dev/null\n` +
    `printf '\\n${n} files\\n'; if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git -c core.quotePath=false ls-files -co --exclude-standard 2>/dev/null | head -n ${SYSTEM_MAP_FILE_LIST_MAX + 1}; printf '\\n${n} endfiles\\n'; else printf '\\n${n} notgit\\n'; fi\n` +
    `printf '\\n${n} done\\n'\n` +
    `}\n` +
    `nt_system_map\n`
  )
}

type ScriptFile = 'missing' | 'not-regular' | { tooLarge: number } | { text: string }

export function parseSystemMapScriptOutput(
  nonce: string,
  stdout: string
):
  | { complete: false }
  | { complete: true; folder: false }
  | { complete: true; folder: true; file: ScriptFile; commitLine: string; files: string[] | null; listedOver: boolean } {
  const marker = (word: string): string => `\n${nonce} ${word}\n`
  if (!stdout.includes(marker('done'))) return { complete: false }
  if (stdout.includes(marker('nofolder'))) return { complete: true, folder: false }

  let file: ScriptFile
  let rest = 0
  const fileStart = stdout.indexOf(marker('file'))
  if (fileStart >= 0) {
    // Exactly the bytes `cat` printed: the endfile marker's leading newline is the script's own.
    const textStart = fileStart + marker('file').length
    const end = stdout.indexOf(`\n${nonce} endfile\n`, textStart)
    if (end < 0) return { complete: false }
    file = { text: stdout.slice(textStart, end) }
    rest = end
  } else {
    const tooLarge = new RegExp(`\\n${nonce} toolarge (\\d+)\\n`).exec(stdout)
    if (tooLarge) file = { tooLarge: Number(tooLarge[1]) }
    else if (stdout.includes(marker('notregular'))) file = 'not-regular'
    else if (stdout.includes(marker('nofile'))) file = 'missing'
    else return { complete: false }
  }

  const commitAt = stdout.indexOf(marker('commit'), rest)
  const filesAt = commitAt < 0 ? -1 : stdout.indexOf(marker('files'), commitAt)
  if (filesAt < 0) return { complete: false }
  const commitLine = stdout.slice(commitAt + marker('commit').length, filesAt).trim()

  const listStart = filesAt + marker('files').length
  if (stdout.indexOf(marker('notgit'), filesAt) >= 0) return { complete: true, folder: true, file, commitLine, files: null, listedOver: false }
  const listEnd = stdout.indexOf(`\n${nonce} endfiles\n`, listStart)
  if (listEnd < 0) return { complete: false }
  const lines = fileLines(stdout.slice(listStart, listEnd))
  const listedOver = lines.length > SYSTEM_MAP_FILE_LIST_MAX
  return { complete: true, folder: true, file, commitLine, files: listedOver ? lines.slice(0, SYSTEM_MAP_FILE_LIST_MAX) : lines, listedOver }
}

async function readRemote(
  route: { remoteCwd: string; runScript: (script: string) => Promise<{ code: number; stdout: string }> }
): Promise<SystemMapReadOutcome> {
  const roots = [route.remoteCwd]
  const fail = (reason: string): SystemMapReadOutcome => ({ result: { ok: false, reason }, roots, compiled: null })
  const nonce = newShipScriptNonce()
  let out: { code: number; stdout: string }
  try {
    out = await route.runScript(systemMapScript(nonce, route.remoteCwd))
  } catch (err) {
    return fail(`Could not read the host's system map: ${errorText(err)}`)
  }
  const parsed = parseSystemMapScriptOutput(nonce, out.stdout)
  if (!parsed.complete) return fail(`Could not read the host's system map (ssh exited ${out.code}).`)
  if (!parsed.folder) return fail(`The project folder ${route.remoteCwd} is not on the host.`)
  const lastCommit = parseCommitLine(parsed.commitLine)
  const invalid = (problems: string[]): SystemMapReadOutcome => ({ result: { ok: true, read: { kind: 'invalid', problems, lastCommit } }, roots, compiled: null })
  if (parsed.file === 'missing') return { result: { ok: true, read: { kind: 'missing' } }, roots, compiled: null }
  if (parsed.file === 'not-regular') return invalid([NOT_REGULAR_PROBLEM])
  if ('tooLarge' in parsed.file) return invalid([sizeProblem(parsed.file.tooLarge)])
  const listing: { check: SystemMapFileCheck; files: readonly string[] } =
    parsed.files === null ? { check: 'not-git', files: [] } : parsed.listedOver ? { check: 'too-many-files', files: [] } : { check: 'checked', files: parsed.files }
  const { read, compiled } = await validRead(parsed.file.text, lastCommit, async () => listing)
  return { result: { ok: true, read }, roots, compiled }
}

/** One project's system map, read through the route that owns its folder, plus what touches need. */
export async function readSystemMapFull(projectId: unknown, router: SystemMapRouter): Promise<SystemMapReadOutcome> {
  const none = (reason: string): SystemMapReadOutcome => ({ result: { ok: false, reason }, roots: [], compiled: null })
  if (typeof projectId !== 'string' || !projectId) return none('No project.')
  let route: ReturnType<SystemMapRouter['route']>
  try {
    route = router.route(projectId)
  } catch (err) {
    return none(errorText(err))
  }
  if (route.kind === 'unsupported') return none(route.reason)
  if (route.kind === 'local') {
    if (!route.cwd) return none(SYSTEM_MAP_NO_FOLDER_MESSAGE)
    return readLocal(route.cwd)
  }
  return readRemote(route)
}

export async function readSystemMap(projectId: unknown, router: SystemMapRouter): Promise<SystemMapResult> {
  return (await readSystemMapFull(projectId, router)).result
}
