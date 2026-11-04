import { randomBytes } from 'crypto'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { oneLine } from '../../shared/one-line'
import { quoteRemotePath } from '../../shared/ssh'
import {
  SHIP_AGENT_COLORS,
  type ShipAgent,
  type ShipAgentColor,
  type ShipConfig,
  type ShipMachine,
  type ShipMcpServer,
  type ShipMcpTransport,
  type ShipScope
} from '../../shared/ship-config'
import { parseFrontmatter } from '../chat-catalog'
import { SHIP_GRAPH_MAX_BYTES, sanitizeShipGraph } from './sanitize'

/**
 * Reading one machine's ship config. Discovery runs where the agents run, because that is whose
 * `~/.claude` they load: locally through node:fs, or through one script over the project's SSH
 * master. Both produce the same `RawShipInput`, and everything after that is one pure function, so
 * the two cannot disagree about what a file means.
 *
 * SYMLINKS ARE FOLLOWED ON PURPOSE. Agents installed from a shared kit are symlinks, so reading only
 * regular directory entries finds nothing on exactly the machines that have the most agents. A
 * symlink in a cloned project can point anywhere, which is why a target must be a regular file (a
 * FIFO would hang the read), why only the first 16 KiB is read, and why what comes back is parsed
 * for frontmatter and never echoed: pointing an "agent" at a private key yields an agent card
 * carrying the link's own name.
 */

const AGENT_READ_BYTES = 16 * 1024
const MAX_AGENT_FILES = 100
const MAX_LISTED = 200
const NAME_MAX = 64
const DESCRIPTION_MAX = 280
const MODEL_MAX = 64
const MAX_TOOLS = 40

export interface RawShipFile {
  name: string
  text: string
}

export interface RawShipScope {
  agents: RawShipFile[]
  commands: string[]
  workflows: string[]
  skills: string[]
  /** The ship-graph.json text; null = none to read. */
  graph: string | null
  /** Why something at that path could not be read as one. Absent = there is simply no file. */
  graphProblem?: string
}

/** One file that can declare MCP servers, as text. Parsed in `buildShipConfig`, so the two readers
 *  cannot disagree about what it means. */
export interface RawMcpFile {
  /** `claude-json` is `~/.claude.json` (servers at the top level and under `projects[cwd]`);
   *  `mcp-json` is a project's `.mcp.json`. */
  source: 'claude-json' | 'mcp-json'
  text: string
}

export interface RawShipInput {
  global: RawShipScope
  project: RawShipScope | null
  /** Absent = MCP config was not read on this machine (an SSH host). */
  mcp?: { files: RawMcpFile[]; problems: string[] }
  /** The project's folder, which keys its entry in `~/.claude.json`. */
  projectCwd?: string | null
  /** What a reader had to leave out. */
  truncated: string[]
}

const emptyScope = (): RawShipScope => ({ agents: [], commands: [], workflows: [], skills: [], graph: null })

const isColor = (v: string): v is ShipAgentColor => (SHIP_AGENT_COLORS as readonly string[]).includes(v)

function cleanName(raw: string): string | null {
  const name = oneLine(raw).trim().slice(0, NAME_MAX)
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name) ? name : null
}

/** One agent file, as a card. Null when neither its frontmatter nor its filename gives a usable name. */
export function parseAgentFile(fileName: string, text: string, scope: ShipScope): ShipAgent | null {
  const { fields } = parseFrontmatter(text)
  const name = cleanName(fields.name ?? '') ?? cleanName(fileName.replace(/\.md$/i, ''))
  if (!name) return null
  const description = oneLine(fields.description ?? '').trim().slice(0, DESCRIPTION_MAX)
  const model = oneLine(fields.model ?? '').trim().slice(0, MODEL_MAX)
  const color = (fields.color ?? '').trim().toLowerCase()
  const tools = (fields.tools ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => oneLine(t).replace(/^['"\s]+|['"\s]+$/g, '').slice(0, NAME_MAX))
    .filter(Boolean)
    .slice(0, MAX_TOOLS)
  return {
    name,
    scope,
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    ...(isColor(color) ? { color } : {}),
    ...(tools.length ? { tools } : {})
  }
}

/** A project's agent replaces the global one of the same name, the way Claude Code resolves them. */
export function mergeAgents(global: readonly ShipAgent[], project: readonly ShipAgent[]): ShipAgent[] {
  const byName = new Map<string, ShipAgent>()
  for (const a of global) byName.set(a.name, a)
  for (const a of project) byName.set(a.name, byName.has(a.name) ? { ...a, overridesGlobal: true } : a)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function listedNames(lists: ReadonlyArray<readonly string[]>): string[] {
  const out = new Set<string>()
  for (const list of lists) {
    for (const entry of list) {
      const name = cleanName(entry.replace(/\.(md|js|mjs|cjs|ts|json|toml)$/i, ''))
      if (name) out.add(name)
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b))
}

// ── MCP servers ─────────────────────────────────────────────────────────────────────────────────

/** `~/.claude.json` and a project's `.mcp.json` are read whole, so they are bounded. Over this, the
 *  file is left out and a warning says so. */
export const MCP_FILE_MAX_BYTES = 16 * 1024 * 1024
const MAX_MCP_SERVERS = 100
const MCP_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/

function transportOf(entry: unknown): ShipMcpTransport {
  if (!entry || typeof entry !== 'object') return 'unknown'
  const e = entry as Record<string, unknown>
  const type = typeof e.type === 'string' ? e.type : ''
  if (type === 'stdio' || type === 'http' || type === 'sse') return type
  if (typeof e.command === 'string') return 'stdio'
  if (typeof e.url === 'string') return 'http'
  return 'unknown'
}

/**
 * The servers one `mcpServers` object declares. THE ONLY THINGS THAT LEAVE ARE name AND transport:
 * `command`, `args`, `env`, `url` and `headers` hold tokens, so they are looked at for the transport's
 * sake and never copied. A name outside the closed alphabet is skipped and counted, never repaired.
 */
function serversOf(table: unknown, scope: ShipScope, skipped: { n: number }): ShipMcpServer[] {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return []
  const out: ShipMcpServer[] = []
  for (const [name, entry] of Object.entries(table as Record<string, unknown>)) {
    if (!MCP_NAME_RE.test(name) || name === '__proto__') {
      skipped.n++
      continue
    }
    out.push({ name, scope, transport: transportOf(entry) })
  }
  return out
}

/** Every MCP server the raw files declare, the project's replacing the global one of the same name. */
export function parseMcpServers(
  files: readonly RawMcpFile[],
  projectCwd: string | null,
  warnings: string[]
): ShipMcpServer[] {
  const byName = new Map<string, ShipMcpServer>()
  const skipped = { n: 0 }
  const labelOf = (f: RawMcpFile): string => (f.source === 'claude-json' ? '~/.claude.json' : '.mcp.json')
  // Global entries first so a project entry replaces them.
  const found: ShipMcpServer[][] = [[], []]
  for (const file of files) {
    let doc: unknown
    try {
      doc = JSON.parse(file.text)
    } catch {
      // The parser's own message quotes the text it choked on, which can be a token.
      warnings.push(`${labelOf(file)} is not valid JSON, so its MCP servers were not read.`)
      continue
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      warnings.push(`${labelOf(file)} is not a JSON object, so its MCP servers were not read.`)
      continue
    }
    const root = doc as Record<string, unknown>
    if (file.source === 'claude-json') {
      found[0].push(...serversOf(root.mcpServers, 'global', skipped))
      const projects = root.projects
      if (projectCwd && projects && typeof projects === 'object' && Object.hasOwn(projects, projectCwd)) {
        const mine = (projects as Record<string, unknown>)[projectCwd]
        if (mine && typeof mine === 'object') found[1].push(...serversOf((mine as Record<string, unknown>).mcpServers, 'project', skipped))
      }
    } else {
      found[1].push(...serversOf(root.mcpServers, 'project', skipped))
    }
  }
  for (const list of found) for (const server of list) byName.set(server.name, server)
  if (skipped.n) warnings.push(`Skipped ${skipped.n} MCP server${skipped.n === 1 ? '' : 's'} whose name is not plain text.`)
  const all = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  if (all.length > MAX_MCP_SERVERS) {
    warnings.push(`Only the first ${MAX_MCP_SERVERS} of ${all.length} MCP servers are listed.`)
    return all.slice(0, MAX_MCP_SERVERS)
  }
  return all
}

export interface ShipPaths {
  machine: ShipMachine
  projectGraphPath: string | null
  globalGraphPath: string
}

/** The one interpretation of a machine's files, whichever reader produced them. */
export function buildShipConfig(raw: RawShipInput, paths: ShipPaths): ShipConfig {
  const warnings = [...raw.truncated]
  if (raw.project?.graphProblem) warnings.push(`Project ship-graph.json: ${raw.project.graphProblem}, so it was ignored.`)
  if (raw.global.graphProblem) warnings.push(`Global ship-graph.json: ${raw.global.graphProblem}, so it was ignored.`)
  const agentsOf = (scope: RawShipScope, kind: ShipScope): ShipAgent[] => {
    const out: ShipAgent[] = []
    for (const f of scope.agents) {
      const agent = parseAgentFile(f.name, f.text, kind)
      if (agent) out.push(agent)
      else warnings.push(`Skipped an agent file with no usable name: ${oneLine(f.name).slice(0, NAME_MAX)}.`)
    }
    return out
  }
  const scopes = raw.project ? [raw.global, raw.project] : [raw.global]
  if (raw.mcp) warnings.push(...raw.mcp.problems)
  const mcpServers = raw.mcp ? parseMcpServers(raw.mcp.files, raw.projectCwd ?? null, warnings) : []

  // The project's file wins whole, not stage by stage: a process is one decision, and half of two
  // would be a graph nobody wrote. A project file that cannot be read says so and falls back, so a
  // typo in one repo does not read as "this machine has no process".
  let pipelines: ShipConfig['pipelines'] = []
  let graphSource: ShipConfig['graphSource'] = null
  if (raw.project?.graph != null) {
    const s = sanitizeShipGraph(raw.project.graph, 'Project ship-graph.json')
    warnings.push(...s.warnings)
    if (s.pipelines) {
      pipelines = s.pipelines
      graphSource = 'project'
    }
  }
  if (!graphSource && raw.global.graph !== null) {
    const s = sanitizeShipGraph(raw.global.graph, 'Global ship-graph.json')
    warnings.push(...s.warnings)
    if (s.pipelines) {
      pipelines = s.pipelines
      graphSource = 'global'
    }
  }

  return {
    machine: paths.machine,
    agents: mergeAgents(agentsOf(raw.global, 'global'), raw.project ? agentsOf(raw.project, 'project') : []),
    commands: listedNames(scopes.map((s) => s.commands)),
    workflows: listedNames(scopes.map((s) => s.workflows)),
    skills: listedNames(scopes.map((s) => s.skills)),
    mcpServers,
    mcpRead: !!raw.mcp,
    pipelines,
    graphSource,
    projectGraphPath: paths.projectGraphPath,
    globalGraphPath: paths.globalGraphPath,
    projectGraphExists: raw.project?.graph != null,
    globalGraphExists: raw.global.graph !== null,
    ...(raw.project?.graphProblem ? { projectGraphBlocked: true as const } : {}),
    ...(raw.global.graphProblem ? { globalGraphBlocked: true as const } : {}),
    warnings
  }
}

// ── Local reader ────────────────────────────────────────────────────────────────────────────────

async function readHead(file: string, bytes: number): Promise<string | null> {
  try {
    // stat, not lstat: this is where a symlink is followed, and where a FIFO is refused before the
    // open that would block on it.
    const stat = await fs.promises.stat(file)
    if (!stat.isFile()) return null
    const handle = await fs.promises.open(file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(bytes, stat.size))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return buffer.toString('utf8', 0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/** The routing file, or what is wrong with whatever sits at its path. lstat first: a dead link is not
 *  "no file", because creating one there would refuse. */
async function readGraphFile(file: string): Promise<Pick<RawShipScope, 'graph' | 'graphProblem'>> {
  try {
    await fs.promises.lstat(file)
  } catch {
    return { graph: null }
  }
  let isFile = false
  try {
    isFile = (await fs.promises.stat(file)).isFile()
  } catch {
    return { graph: null, graphProblem: 'is a link to nothing' }
  }
  if (!isFile) return { graph: null, graphProblem: 'is not a regular file' }
  // One byte over the bound, so the sanitizer can see the file is too large rather than parse a cut.
  const graph = await readHead(file, SHIP_GRAPH_MAX_BYTES + 1)
  return graph === null ? { graph: null, graphProblem: 'could not be read' } : { graph }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(dir)).sort()
  } catch {
    return []
  }
}

async function readLocalScope(root: string, label: string, truncated: string[]): Promise<RawShipScope> {
  const scope = emptyScope()
  const agentFiles = (await listDir(path.join(root, 'agents'))).filter((n) => n.toLowerCase().endsWith('.md'))
  if (agentFiles.length > MAX_AGENT_FILES) {
    truncated.push(`${label}: only the first ${MAX_AGENT_FILES} of ${agentFiles.length} agents were read.`)
  }
  for (const name of agentFiles.slice(0, MAX_AGENT_FILES)) {
    const text = await readHead(path.join(root, 'agents', name), AGENT_READ_BYTES)
    if (text !== null) scope.agents.push({ name, text })
  }
  const listed = async (sub: 'commands' | 'workflows' | 'skills'): Promise<string[]> => {
    const names = (await listDir(path.join(root, sub))).filter((n) => !n.startsWith('.'))
    if (names.length > MAX_LISTED) truncated.push(`${label}: only the first ${MAX_LISTED} of ${names.length} ${sub} are listed.`)
    return names.slice(0, MAX_LISTED)
  }
  scope.commands = await listed('commands')
  scope.workflows = await listed('workflows')
  scope.skills = await listed('skills')
  return { ...scope, ...(await readGraphFile(path.join(root, 'ship-graph.json'))) }
}

/** Claude Code keeps its user-level config in `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`
 *  (beside, not inside, `~/.claude`). */
export function claudeJsonPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR
  return dir ? path.join(dir, '.claude.json') : path.join(homedir(), '.claude.json')
}

/** One file's text, or why not. A regular file only (a FIFO would hang the open), bounded, and the
 *  reason carries no content. Absent is not a problem: most projects have no `.mcp.json`. */
async function readMcpFile(file: string, source: RawMcpFile['source'], label: string): Promise<{ file?: RawMcpFile; problem?: string }> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(file)
  } catch {
    return {}
  }
  if (!stat.isFile()) return { problem: `${label} is not a regular file, so its MCP servers were not read.` }
  if (stat.size > MCP_FILE_MAX_BYTES) return { problem: `${label} is larger than ${MCP_FILE_MAX_BYTES / 1024 / 1024} MB, so its MCP servers were not read.` }
  const text = await readHead(file, MCP_FILE_MAX_BYTES)
  return text === null ? { problem: `${label} could not be read, so its MCP servers were not listed.` } : { file: { source, text } }
}

export async function readLocalShipInput(
  globalDir: string,
  projectCwd: string | null,
  claudeJson: string = claudeJsonPath()
): Promise<RawShipInput> {
  const truncated: string[] = []
  const files: RawMcpFile[] = []
  const problems: string[] = []
  const reads = [
    await readMcpFile(claudeJson, 'claude-json', '~/.claude.json'),
    ...(projectCwd ? [await readMcpFile(path.join(projectCwd, '.mcp.json'), 'mcp-json', '.mcp.json')] : [])
  ]
  for (const r of reads) {
    if (r.file) files.push(r.file)
    if (r.problem) problems.push(r.problem)
  }
  return {
    global: await readLocalScope(globalDir, 'Global .claude', truncated),
    project: projectCwd ? await readLocalScope(path.join(projectCwd, '.claude'), 'Project .claude', truncated) : null,
    truncated,
    mcp: { files, problems },
    projectCwd
  }
}

// ── Remote reader ───────────────────────────────────────────────────────────────────────────────

/** A marker no file on the host can have been written to contain, so a hostile agent file cannot
 *  fake a second file or a listing in the output. */
export function newShipScriptNonce(): string {
  return `NTSC${randomBytes(12).toString('hex')}`
}

/** The global config dir as the host's own shell resolves it. */
export const REMOTE_GLOBAL_DIR = '${CLAUDE_CONFIG_DIR:-$HOME/.claude}'

/**
 * One POSIX `sh` script, fed on stdin (`sh -s`), so it runs the same under a login shell of any
 * dialect. Every quoted expansion is ours and the only outside text is the quoted project path; file
 * contents go through `head`, never through the shell. `-f` and `head` both follow symlinks.
 */
export function remoteShipScript(nonce: string, remoteCwd: string | null): string {
  const scope = (label: string, root: string): string => `
n=0
for f in "${root}"/agents/*.md; do
  [ -f "$f" ] || continue
  n=$((n+1))
  [ "$n" -le ${MAX_AGENT_FILES} ] || continue
  printf '\\n${nonce} agent ${label} %s\\n' "$(basename "$f")"
  head -c ${AGENT_READ_BYTES} "$f" 2>/dev/null
done
[ "$n" -le ${MAX_AGENT_FILES} ] || printf '\\n${nonce} over ${label} agents %s\\n' "$n"
for sub in commands workflows skills; do
  printf '\\n${nonce} list ${label} %s\\n' "$sub"
  ls -1 "${root}/$sub" 2>/dev/null | head -n ${MAX_LISTED}
done
g="${root}/ship-graph.json"
if [ -f "$g" ] && [ -r "$g" ]; then
  printf '\\n${nonce} graph ${label}\\n'
  head -c ${SHIP_GRAPH_MAX_BYTES + 1} "$g" 2>/dev/null
elif [ -e "$g" ] || [ -L "$g" ]; then
  printf '\\n${nonce} blocked ${label}\\n'
fi
`
  const project = remoteCwd
    ? `proj=${quoteRemotePath(remoteCwd)}/.claude\n${scope('project', '$proj')}`
    : ''
  return `glob="${REMOTE_GLOBAL_DIR}"\nprintf '\\n${nonce} home %s\\n' "$glob"\n${scope('global', '$glob')}${project}printf '\\n${nonce} end\\n'\n`
}

export interface ParsedRemoteShip {
  input: RawShipInput
  /** The global dir as the host resolved it, for the paths the UI shows. */
  globalDir: string | null
  /** The script reached its last line, so nothing was cut off by a dropped channel. */
  complete: boolean
}

export function parseRemoteShipOutput(nonce: string, stdout: string, hasProject: boolean): ParsedRemoteShip {
  const input: RawShipInput = { global: emptyScope(), project: hasProject ? emptyScope() : null, truncated: [] }
  let globalDir: string | null = null
  let complete = false
  const scopeOf = (label: string): RawShipScope | null =>
    label === 'global' ? input.global : label === 'project' ? input.project : null
  // Each record starts at a marker line; a record's body is what lies between it and the next one.
  const parts = stdout.split(`\n${nonce} `).slice(1)
  for (const part of parts) {
    const eol = part.indexOf('\n')
    const head = eol < 0 ? part : part.slice(0, eol)
    const body = eol < 0 ? '' : part.slice(eol + 1)
    const [kind, label, ...rest] = head.split(' ')
    const arg = rest.join(' ')
    if (kind === 'end') complete = true
    else if (kind === 'home') globalDir = [label, ...rest].join(' ')
    else if (kind === 'over') {
      input.truncated.push(`${label === 'project' ? 'Project' : 'Global'} .claude: only the first ${MAX_AGENT_FILES} agents were read.`)
    } else {
      const scope = scopeOf(label)
      if (!scope) continue
      if (kind === 'agent') scope.agents.push({ name: arg, text: body })
      else if (kind === 'graph') scope.graph = body
      else if (kind === 'blocked') scope.graphProblem = 'is not a readable regular file'
      else if (kind === 'list' && (arg === 'commands' || arg === 'workflows' || arg === 'skills')) {
        const names = body.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('.'))
        scope[arg] = names
        if (names.length >= MAX_LISTED) {
          input.truncated.push(`${label === 'project' ? 'Project' : 'Global'} .claude: only the first ${MAX_LISTED} ${arg} are listed.`)
        }
      }
    }
  }
  return { input, globalDir, complete }
}
