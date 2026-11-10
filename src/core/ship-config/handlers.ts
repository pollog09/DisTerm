import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { errorText } from '../../shared/error-text'
import { IPC } from '../../shared/ipc'
import {
  SHIP_LEASE_MS,
  SHIP_NO_FOLDER_MESSAGE,
  SHIP_SHARED_CONFIG_MESSAGE,
  isShipAgentModel,
  type ShipAgentModelResult,
  type ShipConfigResult,
  type ShipGraphCreateResult,
  type ShipMachine,
  type ShipScope,
  type ShipTemplateCreateResult
} from '../../shared/ship-config'
import { posixQuote, quoteRemotePath } from '../../shared/ssh'
import type { CorePlatform } from '../platform'
import { updateTextFile } from '../agents/hooks/settings-file'
import { updateRemoteTextFile, type SettingsRunner } from '../agents/hooks/remote-settings-file'
import { setFrontmatterModel } from './agent-model'
import {
  buildShipConfig,
  isAgentLeaf,
  REMOTE_GLOBAL_DIR,
  newShipScriptNonce,
  parseRemoteShipOutput,
  readLocalShipInput,
  remoteShipScript
} from './discover'
import { SHIP_GRAPH_EXAMPLE_TEXT, SHIP_GRAPH_FILE, planShipTemplate, shipTemplateRel, type ShipTemplateFile } from './template'

/** Where one project's agents run, resolved per call by the shell. */
export type ShipConfigRoute =
  /** `cwd` null = a canvas with no folder: this machine's global config, and no project half. */
  | { kind: 'local'; cwd: string | null }
  /** `runScript` feeds a POSIX sh script to the host (`sh -s` over the project's ControlMaster). */
  | {
      kind: 'remote'
      remoteCwd: string
      host: string
      runScript: (script: string) => Promise<{ code: number; stdout: string }>
      /** Runs `command` on the host with `stdin`, for the guarded edit of an existing file
       *  (`updateRemoteTextFile`). Absent = this route cannot edit, and says so. */
      runCommand?: SettingsRunner
    }
  | { kind: 'unsupported'; reason: string }

export interface ShipConfigRouter {
  route(projectId: string): ShipConfigRoute
}

/** How often a subscribed view re-reads. Polled rather than `fs.watch`ed because an agent file is
 *  usually a SYMLINK: a watch on the folder never fires for an edit of the link's target, and a watch
 *  on a target would have to follow every link and re-arm when one moves. */
export const SHIP_POLL_LOCAL_MS = 5_000
export const SHIP_POLL_REMOTE_MS = 20_000

const GRAPH_FILE = SHIP_GRAPH_FILE
const EXAMPLE_TEXT = SHIP_GRAPH_EXAMPLE_TEXT

function localGlobalDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
}

export async function readShipConfig(projectId: unknown, router: ShipConfigRouter): Promise<ShipConfigResult> {
  if (typeof projectId !== 'string' || !projectId) return { ok: false, reason: 'No project.' }
  let route: ShipConfigRoute
  try {
    route = router.route(projectId)
  } catch (err) {
    return { ok: false, reason: errorText(err) }
  }
  if (route.kind === 'unsupported') return { ok: false, reason: route.reason }
  if (route.kind === 'local') {
    const globalDir = localGlobalDir()
    const machine: ShipMachine = { kind: 'local', label: '' }
    const input = await readLocalShipInput(globalDir, route.cwd)
    return {
      ok: true,
      config: buildShipConfig(input, {
        machine,
        globalGraphPath: path.join(globalDir, GRAPH_FILE),
        projectGraphPath: route.cwd ? path.join(route.cwd, '.claude', GRAPH_FILE) : null
      })
    }
  }
  const nonce = newShipScriptNonce()
  let result: { code: number; stdout: string }
  try {
    result = await route.runScript(remoteShipScript(nonce, route.remoteCwd))
  } catch (err) {
    return { ok: false, reason: `Could not read the host's agents: ${errorText(err)}` }
  }
  const parsed = parseRemoteShipOutput(nonce, result.stdout, true)
  if (!parsed.complete) {
    return { ok: false, reason: `Could not read the host's agents (ssh exited ${result.code}).` }
  }
  return {
    ok: true,
    config: buildShipConfig(parsed.input, {
      machine: { kind: 'ssh', label: route.host },
      globalGraphPath: `${parsed.globalDir ?? '~/.claude'}/${GRAPH_FILE}`,
      projectGraphPath: `${route.remoteCwd.replace(/\/+$/, '')}/.claude/${GRAPH_FILE}`
    })
  }
}

/** The folders a template writes into. `createShipGraph` writes only into `.claude` itself. */
const TEMPLATE_SUBS = ['', 'agents', 'commands'] as const
const GRAPH_SUBS = [''] as const
/** A project agent's folders, checked before its model is set. */
const AGENT_SUBS = ['', 'agents'] as const

/** A path as the filesystem resolves it, for one that may not exist yet: the deepest part that does,
 *  resolved, plus the rest as written. A link to something missing is followed, because it says where a
 *  write through it would go. Only a definite absence walks up; anything else is thrown. */
async function realPathAllowingAbsent(p: string, hops = 0): Promise<string> {
  try {
    return await fs.promises.realpath(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(p) === p || hops > 40) throw err
  }
  const stat = await fs.promises.lstat(p).catch(() => null)
  if (stat?.isSymbolicLink()) {
    return realPathAllowingAbsent(path.resolve(path.dirname(p), await fs.promises.readlink(p)), hops + 1)
  }
  return path.join(await realPathAllowingAbsent(path.dirname(p), hops), path.basename(p))
}

/** `inner` is `outer` or below it, by whole segments: `~/.claude-2` is not inside `~/.claude`. */
function isSameOrInside(inner: string, outer: string): boolean {
  const rel = path.relative(outer, inner)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/**
 * Would a write to these folders of `root` land in the machine's Claude config? By real path, because a
 * link gets there too, and against the config's own subfolders as well, because one can be a link out to
 * a shared kit. Throws when it cannot tell: a check that could not run must not let a home folder through.
 */
async function leadsIntoGlobalConfig(root: string, globalDir: string, subs: readonly string[]): Promise<boolean> {
  const inConfig: string[] = []
  for (const sub of subs) inConfig.push(await realPathAllowingAbsent(path.join(globalDir, sub)))
  for (const sub of subs) {
    const real = await realPathAllowingAbsent(path.join(root, sub))
    if (inConfig.some((outer) => isSameOrInside(real, outer))) return true
  }
  return false
}

/**
 * The same check in a host's shell (`test -ef` is not POSIX), reading `$root` and `$glob`. Its failures are
 * markers, read by `remoteConfigRefusal`. A folder that exists and cannot be entered fails here: past this
 * point `[ -e ]` would read it as empty. `case` with a quoted pattern is what compares by segment, and a
 * tail holding `..` cannot be judged without the folders it names, so it fails too.
 */
function remoteSharedConfigCheck(nonce: string, subs: readonly string[]): string {
  const list = subs.map((s) => (s ? `/${s}` : "''")).join(' ')
  return (
    `nt_real() {\nnt_p=$1\nnt_tail=\nnt_n=0\nwhile [ ! -d "$nt_p" ]; do\n` +
    `nt_n=$((nt_n+1))\n[ "$nt_n" -le 64 ] || return 1\n` +
    `if [ -L "$nt_p" ]; then\nnt_l=$(readlink -- "$nt_p") || return 1\n` +
    `case $nt_l in\n/*) nt_p=$nt_l ;;\n*) nt_p="$(dirname -- "$nt_p")/$nt_l" ;;\nesac\ncontinue\nfi\n` +
    `nt_tail="/$(basename -- "$nt_p")$nt_tail"\nnt_p=$(dirname -- "$nt_p")\ndone\n` +
    `case "$nt_tail/" in\n*/../*) return 1 ;;\nesac\n` +
    `nt_base=$(CDPATH= cd -P -- "$nt_p" 2>/dev/null && pwd -P) || return 1\nprintf '%s%s\\n' "$nt_base" "$nt_tail"\n}\n` +
    `for nt_o in ${list}; do\n` +
    `if ! nt_b=$(nt_real "$glob$nt_o"); then printf '\\n${nonce} unverifiable\\n'; exit 1; fi\n` +
    `[ "$nt_b" = / ] && nt_b=\n` +
    `for nt_i in ${list}; do\n` +
    `if ! nt_a=$(nt_real "$root$nt_i"); then printf '\\n${nonce} unverifiable\\n'; exit 1; fi\n` +
    `case "$nt_a/" in\n"$nt_b"/*) printf '\\n${nonce} sharedconfig\\n'; exit 1 ;;\nesac\n` +
    `done\ndone\n`
  )
}

/** What the check's markers mean, for either script. */
function remoteConfigRefusal(nonce: string, stdout: string, root: string): { ok: false; reason: 'unsupported' | 'failed'; message: string } | null {
  if (stdout.includes(`${nonce} sharedconfig`)) return { ok: false, reason: 'unsupported', message: SHIP_SHARED_CONFIG_MESSAGE }
  if (stdout.includes(`${nonce} unverifiable`)) {
    return { ok: false, reason: 'failed', message: `Could not tell whether ${root} would change the host's Claude config, because a folder there could not be read. Nothing was written.` }
  }
  return null
}

/**
 * `nt_put <dir> <leaf> <bytes> <body>`: publish a file on a host, only if nothing is there. Returns 0
 * written, 17 something is there, 1 failed. Never a bare `cat >` (remote-write.guard.test.ts): the body
 * goes into a temp of ours, its size is checked, and `ln` publishes it, failing on an existing file as
 * `wx` does and a rename would not. Defined inside the caller's one function (see below), and `t` is left
 * for the caller's EXIT trap, so a killed script leaves no temp.
 */
function remotePutFunction(nonce: string): string {
  return (
    `nt_put() {\n` +
    `f="$1/$2"\n` +
    `if [ -e "$f" ] || [ -L "$f" ]; then return 17; fi\nmkdir -p "$1" || return 1\n` +
    `t="$1/.nodeterm-${nonce}.tmp"\n` +
    `printf '%s' "$4" > "$t" || { rm -f "$t"; return 1; }\n` +
    `[ $(wc -c < "$t") -eq "$3" ] || { rm -f "$t"; return 1; }\n` +
    `if ln "$t" "$f" 2>/dev/null; then rm -f "$t"; return 0; fi\n` +
    `rm -f "$t"\n` +
    `if [ -e "$f" ] || [ -L "$f" ]; then return 17; fi\nreturn 1\n}\n`
  )
}

/** Write the example, only if nothing is there. An example never replaces anything a person wrote. */
export async function createShipGraph(
  projectId: unknown,
  scope: unknown,
  router: ShipConfigRouter
): Promise<ShipGraphCreateResult> {
  const unsupported = (message: string): ShipGraphCreateResult => ({ ok: false, reason: 'unsupported', message })
  if (typeof projectId !== 'string' || !projectId) return unsupported('No project.')
  if (scope !== 'project' && scope !== 'global') return unsupported('Unknown location.')
  const where = scope as ShipScope
  let route: ShipConfigRoute
  try {
    route = router.route(projectId)
  } catch (err) {
    return unsupported(errorText(err))
  }
  if (route.kind === 'unsupported') return unsupported(route.reason)
  if (route.kind === 'local') {
    if (where === 'project' && !route.cwd) return unsupported(SHIP_NO_FOLDER_MESSAGE)
    const dir = where === 'project' ? path.join(route.cwd!, '.claude') : localGlobalDir()
    const file = path.join(dir, GRAPH_FILE)
    try {
      // Scope `global` is the person asking for exactly that. A project file there is not what they asked.
      if (where === 'project' && (await leadsIntoGlobalConfig(dir, localGlobalDir(), GRAPH_SUBS))) return unsupported(SHIP_SHARED_CONFIG_MESSAGE)
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.writeFile(file, EXAMPLE_TEXT, { flag: 'wx' })
      return { ok: true, path: file }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, reason: 'exists', message: `${file} already exists.` }
      }
      return { ok: false, reason: 'failed', message: errorText(err) }
    }
  }
  const dir = where === 'project' ? `${quoteRemotePath(route.remoteCwd)}/.claude` : '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"'
  const nonce = newShipScriptNonce()
  // The whole script is one function, called on its last line: it arrives over the ssh channel, and a
  // cut-off script must run NOTHING. Run line by line, a cut mid-line is a different command (`mkdir -`,
  // and `ln "$t"` with one argument links into wherever the shell is). A cut function is a syntax error.
  // The script reports the path it used, because the host's shell resolves `~` and CLAUDE_CONFIG_DIR,
  // and success is its done marker, because exit 0 alone can be a shell that read nothing.
  const bytes = Buffer.byteLength(EXAMPLE_TEXT, 'utf8')
  const script =
    `nt_create_ship_graph() {\n` +
    remotePutFunction(nonce) +
    `dir=${dir}\nprintf '\\n${nonce} path %s\\n' "$dir/${GRAPH_FILE}"\n` +
    (where === 'project' ? `root=$dir\nglob="${REMOTE_GLOBAL_DIR}"\n${remoteSharedConfigCheck(nonce, GRAPH_SUBS)}` : '') +
    `trap 'rm -f "$t"' EXIT\n` +
    `nt_put "$dir" ${GRAPH_FILE} ${bytes} ${posixQuote(EXAMPLE_TEXT)}\n` +
    `case $? in\n0) printf '\\n${nonce} done\\n'; exit 0 ;;\n17) exit 17 ;;\nesac\nexit 1\n}\nnt_create_ship_graph\n`
  try {
    const { code, stdout } = await route.runScript(script)
    const written = new RegExp(`${nonce} path (.+)`).exec(stdout)?.[1]
    const shown = written ?? `${where === 'project' ? route.remoteCwd : '~/.claude'}/${GRAPH_FILE}`
    if (code === 0 && stdout.includes(`${nonce} done`)) return { ok: true, path: shown }
    if (code === 17) return { ok: false, reason: 'exists', message: `${shown} already exists.` }
    const refused = remoteConfigRefusal(nonce, stdout, shown)
    if (refused) return refused
    return { ok: false, reason: 'failed', message: `Could not write ${shown} (ssh exited ${code}).` }
  } catch (err) {
    return { ok: false, reason: 'failed', message: errorText(err) }
  }
}

/**
 * `script` as one command any login shell hands to POSIX `sh` unchanged. The ssh exec channel runs a
 * command through the user's login shell, which may be fish or tcsh, and the guarded edit is POSIX sh
 * (functions, `${VAR:-x}`, `case`, `trap`). Its stdin carries the file's bytes, so it cannot arrive on
 * `sh -s` the way discovery's script does. Instead every byte goes as a `%b` octal escape inside one
 * single-quoted word that holds no quote and no doubled backslash: fish, tcsh and every POSIX shell pass
 * that word through as written, and `sh` decodes and runs it. Stdin goes to the script untouched.
 */
export function viaPosixSh(script: string): string {
  let octal = ''
  for (const byte of Buffer.from(script, 'utf8')) octal += `\\0${byte.toString(8).padStart(3, '0')}`
  return `sh -c 'eval "$(printf %b "${octal}")"'`
}

/**
 * Set one agent's `model:` line, in the file discovery read it from. The ONE ship-config write that edits
 * a file the person already has, so it takes nothing but names from the caller: the agent is looked up in
 * a fresh read of the machine by scope and name, and its path is built here from that scope's folder and
 * the leaf discovery recorded. Only a model from `SHIP_AGENT_MODELS` is written.
 *
 * WRITTEN THROUGH THE LINK. Agents installed from a shared kit are symlinks, and the kit's file is the
 * agent; replacing the link with a copy would quietly fork it from the kit. `updateTextFile` and
 * `updateRemoteTextFile` resolve the link, lock, keep the mode, and refuse to publish over a file that
 * changed since it was read. So a global agent's model changes for every project, and a kit agent's change
 * shows up in the kit's git status: the panel says the first, and the second is the point.
 */
export async function setShipAgentModel(
  projectId: unknown,
  scope: unknown,
  agentName: unknown,
  model: unknown,
  router: ShipConfigRouter
): Promise<ShipAgentModelResult> {
  const unsupported = (message: string): ShipAgentModelResult => ({ ok: false, reason: 'unsupported', message })
  if (typeof projectId !== 'string' || !projectId) return unsupported('No project.')
  if (scope !== 'project' && scope !== 'global') return unsupported('Unknown location.')
  if (typeof agentName !== 'string' || !agentName) return unsupported('No agent.')
  if (!isShipAgentModel(model)) return unsupported('That model is not one this view can set.')
  let route: ShipConfigRoute
  try {
    route = router.route(projectId)
  } catch (err) {
    return unsupported(errorText(err))
  }
  if (route.kind === 'unsupported') return unsupported(route.reason)
  if (route.kind === 'remote' && !route.runCommand) return unsupported('This connection cannot edit agent files.')
  const read = await readShipConfig(projectId, router)
  if (!read.ok) return { ok: false, reason: 'failed', message: read.reason }
  const agent = read.config.agents.find((a) => a.name === agentName && a.scope === scope)
  if (!agent) return { ok: false, reason: 'missing', message: `There is no ${scope} agent named ${agentName} on this machine now.` }
  if (!agent.fileName || !isAgentLeaf(agent.fileName)) {
    return { ok: false, reason: 'missing', message: `Could not tell which file declares ${agentName}.` }
  }
  if (agent.model === model) return { ok: true, model, unchanged: true }

  let missing = false
  let noFrontmatter = false
  const update = (before: string | null): string | null => {
    if (before === null) {
      missing = true
      return null
    }
    const next = setFrontmatterModel(before, model)
    if (next === null) noFrontmatter = true
    return next === before ? null : next
  }
  let outcome: 'written' | 'unchanged' | 'failed'
  let shown: string
  // A project folder can lead into the machine's own config (the home folder itself, or agents linked to
  // the global ones), and then every global agent reads as a project agent. Setting one "for this
  // project" would rewrite it for every project, so it is refused as the create paths refuse it.
  if (route.kind === 'local') {
    if (scope === 'project' && !route.cwd) return unsupported(SHIP_NO_FOLDER_MESSAGE)
    const dir = scope === 'project' ? path.join(route.cwd!, '.claude') : localGlobalDir()
    shown = path.join(dir, 'agents', agent.fileName)
    if (scope === 'project') {
      try {
        if (await leadsIntoGlobalConfig(dir, localGlobalDir(), AGENT_SUBS)) return unsupported(SHIP_SHARED_CONFIG_MESSAGE)
      } catch (err) {
        return { ok: false, reason: 'failed', message: `Could not tell whether ${shown} is this machine's own Claude config: ${errorText(err)}. Nothing was written.` }
      }
    }
    outcome = updateTextFile(shown, update)
  } else {
    const dir = scope === 'project' ? `${quoteRemotePath(route.remoteCwd)}/.claude` : `"${REMOTE_GLOBAL_DIR}"`
    shown = `${scope === 'project' ? route.remoteCwd.replace(/\/+$/, '') + '/.claude' : '~/.claude'}/agents/${agent.fileName}`
    if (scope === 'project') {
      const nonce = newShipScriptNonce()
      const check =
        `nt_ship_model_check() {\nroot=${dir}\nglob="${REMOTE_GLOBAL_DIR}"\n` +
        remoteSharedConfigCheck(nonce, AGENT_SUBS) +
        `printf '\\n${nonce} clear\\n'\n}\nnt_ship_model_check\n`
      let stdout: string
      try {
        stdout = (await route.runScript(check)).stdout
      } catch (err) {
        return { ok: false, reason: 'failed', message: `Could not check ${shown} on the host: ${errorText(err)}. Nothing was written.` }
      }
      const refused = remoteConfigRefusal(nonce, stdout, route.remoteCwd)
      if (refused) return refused
      if (!stdout.includes(`${nonce} clear`)) {
        return { ok: false, reason: 'failed', message: `Could not check ${shown} on the host. Nothing was written.` }
      }
    }
    const runCommand = route.runCommand!
    const run: SettingsRunner = (command, stdin) => runCommand(viaPosixSh(command), stdin)
    outcome = await updateRemoteTextFile({ pathExpr: `${dir}/agents/${posixQuote(agent.fileName)}`, label: shown }, run, update)
  }
  if (missing) return { ok: false, reason: 'missing', message: `${shown} is gone.` }
  if (noFrontmatter) return { ok: false, reason: 'failed', message: `${shown} has no frontmatter block to hold a model line. Nothing was written.` }
  if (outcome === 'failed') {
    const cause = route.kind === 'local'
      ? 'it changed while this ran, another DisTerm writer holds it, or it could not be read'
      : 'the host could not run the edit, the file changed while this ran, another DisTerm writer holds it, or it could not be read'
    return { ok: false, reason: 'failed', message: `Could not write ${shown}: ${cause}. Nothing was written.` }
  }
  return outcome === 'unchanged' ? { ok: true, model, unchanged: true } : { ok: true, model }
}

function templateOutcome(root: string, created: readonly string[], kept: readonly string[], failure: string | null): ShipTemplateCreateResult {
  if (failure === null) return { ok: true, root, created: [...created], kept: [...kept] }
  const done = created.length ? ` Created before it stopped: ${created.join(', ')}.` : ''
  return { ok: false, reason: 'failed', message: `${failure}${done}` }
}

/** Publish one file only if nothing is there, including a dead link. A write that fails takes its file
 *  with it, so a retry is not stopped by half of one. */
async function writeNewFile(file: string, text: string): Promise<'created' | 'exists'> {
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(file, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
    throw err
  }
  try {
    await handle.writeFile(text)
    await handle.close()
  } catch (err) {
    await handle.close().catch(() => {})
    await fs.promises.unlink(file).catch(() => {})
    throw err
  }
  return 'created'
}

async function writeTemplateLocally(cwd: string, files: readonly ShipTemplateFile[], keptByPlan: readonly string[]): Promise<ShipTemplateCreateResult> {
  const root = path.join(cwd, '.claude')
  const globalDir = localGlobalDir()
  const created: string[] = []
  const kept = [...keptByPlan]
  // Never `mkdir -p` a folder back into being: the project may be a worktree someone removed.
  try {
    if (!(await fs.promises.stat(cwd)).isDirectory()) return templateOutcome(root, [], [], `${cwd} is not a folder.`)
  } catch (err) {
    return templateOutcome(root, [], [], `Could not use the project folder ${cwd}: ${errorText(err)}`)
  }
  // Everything that decides a write is settled before the first one, and fails closed: a global folder
  // that cannot be read says nothing about what is in it.
  const inGlobal = new Set<ShipTemplateFile>()
  try {
    if (await leadsIntoGlobalConfig(root, globalDir, TEMPLATE_SUBS)) {
      return { ok: false, reason: 'unsupported', message: SHIP_SHARED_CONFIG_MESSAGE }
    }
    // A listing can stop at its cap, and a project file here would replace this one.
    for (const file of files) {
      if (file.dir && (await lstatExists(path.join(globalDir, file.dir, file.leaf)))) inGlobal.add(file)
    }
  } catch (err) {
    return templateOutcome(root, [], [], `Could not tell whether ${root} would change this machine's Claude config: ${errorText(err)}`)
  }
  for (const file of files) {
    const rel = shipTemplateRel(file)
    try {
      if (inGlobal.has(file)) {
        kept.push(rel)
        continue
      }
      const dir = path.join(root, file.dir)
      await fs.promises.mkdir(dir, { recursive: true })
      if ((await writeNewFile(path.join(dir, file.leaf), file.text)) === 'created') created.push(rel)
      else kept.push(rel)
    } catch (err) {
      return templateOutcome(root, created, kept, `Could not write ${path.join(root, rel)}: ${errorText(err)}.`)
    }
  }
  return templateOutcome(root, created, kept, null)
}

async function lstatExists(file: string): Promise<boolean> {
  try {
    await fs.promises.lstat(file)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw err
  }
}

/** One script for the whole template, for the reasons `createShipGraph` gives: it runs whole or not at
 *  all, and only its done marker is success. Files after a failure are not attempted, so routing is never
 *  written after an agent it names failed. */
function remoteTemplateScript(nonce: string, remoteCwd: string, files: readonly ShipTemplateFile[]): string {
  const steps = files.map((file) => {
    const rel = shipTemplateRel(file)
    const dir = file.dir ? `"$root/${file.dir}"` : '"$root"'
    const put =
      `nt_put ${dir} ${file.leaf} ${Buffer.byteLength(file.text, 'utf8')} ${posixQuote(file.text)}\n` +
      `case $? in\n0) printf '\\n${nonce} created ${rel}\\n' ;;\n17) printf '\\n${nonce} kept ${rel}\\n' ;;\n` +
      `*) printf '\\n${nonce} failed ${rel}\\n'; exit 1 ;;\nesac\n`
    if (!file.dir) return put
    const inGlobal = `"$glob/${rel}"`
    return `if [ -e ${inGlobal} ] || [ -L ${inGlobal} ]; then printf '\\n${nonce} kept ${rel}\\n'; else\n${put}fi\n`
  })
  return (
    `nt_create_ship_template() {\n` +
    remotePutFunction(nonce) +
    `proj=${quoteRemotePath(remoteCwd)}\nroot="$proj/.claude"\nglob="${REMOTE_GLOBAL_DIR}"\n` +
    `printf '\\n${nonce} root %s\\n' "$root"\n` +
    `if [ ! -d "$proj" ]; then printf '\\n${nonce} nofolder\\n'; exit 1; fi\n` +
    remoteSharedConfigCheck(nonce, TEMPLATE_SUBS) +
    `trap 'rm -f "$t"' EXIT\n` +
    steps.join('') +
    `printf '\\n${nonce} done\\n'\nexit 0\n}\nnt_create_ship_template\n`
  )
}

/**
 * Set a project up with the starter pipeline, on the machine it runs on. Reads the machine first and
 * refuses on a failed read: a read that failed says nothing about what is there, and absence is what
 * decides whether a file would shadow one of the person's own. A project whose `.claude` is part of the
 * machine's own config is refused outright: every file written there reaches all its projects.
 */
export async function createShipTemplate(projectId: unknown, router: ShipConfigRouter): Promise<ShipTemplateCreateResult> {
  const unsupported = (message: string): ShipTemplateCreateResult => ({ ok: false, reason: 'unsupported', message })
  if (typeof projectId !== 'string' || !projectId) return unsupported('No project.')
  let route: ShipConfigRoute
  try {
    route = router.route(projectId)
  } catch (err) {
    return unsupported(errorText(err))
  }
  if (route.kind === 'unsupported') return unsupported(route.reason)
  if (route.kind === 'local' && !route.cwd) return unsupported(SHIP_NO_FOLDER_MESSAGE)
  const read = await readShipConfig(projectId, router)
  if (!read.ok) return { ok: false, reason: 'failed', message: read.reason }
  const { write, kept } = planShipTemplate(read.config)
  if (route.kind === 'local') return writeTemplateLocally(route.cwd!, write, kept)

  const nonce = newShipScriptNonce()
  const fallbackRoot = `${route.remoteCwd.replace(/\/+$/, '')}/.claude`
  try {
    const { code, stdout } = await route.runScript(remoteTemplateScript(nonce, route.remoteCwd, write))
    const lines = (kind: string): string[] => [...stdout.matchAll(new RegExp(`^${nonce} ${kind} (.+)$`, 'gm'))].map((m) => m[1])
    const root = lines('root')[0] ?? fallbackRoot
    const created = lines('created')
    const keptToo = [...kept, ...lines('kept')]
    if (code === 0 && stdout.includes(`${nonce} done`)) return templateOutcome(root, created, keptToo, null)
    const refused = remoteConfigRefusal(nonce, stdout, root)
    if (refused) return refused
    const failed = lines('failed')[0]
    if (stdout.includes(`${nonce} nofolder`)) return templateOutcome(root, created, keptToo, `The project folder ${route.remoteCwd} is not on the host.`)
    return templateOutcome(root, created, keptToo, failed ? `Could not write ${root}/${failed} (ssh exited ${code}).` : `Could not set this project up (ssh exited ${code}).`)
  } catch (err) {
    return { ok: false, reason: 'failed', message: errorText(err) }
  }
}

/**
 * Registered once per shell. While a view holds a lease, this re-reads the machine and pushes only on a
 * real change.
 *
 * LEASES, not a ref count, because a renderer that crashes or reloads and a relay peer that drops send
 * no unsubscribe, and a count they never decrement would re-read the config, or spawn `ssh sh -s`, until
 * the app quits. A view renews its lease (`holdShipConfigLease`); a dead one simply stops.
 *
 * ROUTED ON EVERY TICK, because the answer changes: a persisted graph view can open an SSH project
 * before its master connects, and must not keep the local cadence once reads go over ssh.
 *
 * ONE POLL READ PER PROJECT AT A TIME. The next read is scheduled after this one ends, and a view closed
 * and reopened on a slow host waits for the read already out rather than starting another. A stopped
 * poll's answer is dropped. A view's own one-shot read (`shipConfigRead`) is separate from this.
 */
export function registerShipConfigHandlers(platform: CorePlatform, router: ShipConfigRouter): void {
  platform.handle(IPC.shipConfigRead, (projectId: unknown) => readShipConfig(projectId, router))
  platform.handle(IPC.shipGraphCreate, (projectId: unknown, scope: unknown) => createShipGraph(projectId, scope, router))
  platform.handle(IPC.shipTemplateCreate, (projectId: unknown) => createShipTemplate(projectId, router))
  platform.handle(IPC.shipAgentSetModel, async (projectId: unknown, scope: unknown, agent: unknown, model: unknown) => {
    const result = await setShipAgentModel(projectId, scope, agent, model, router)
    // Every view of this project re-reads now instead of on its next poll. Harmless twice: the poll's
    // own push follows only if its signature differs from what it last saw.
    if (result.ok && !result.unchanged && typeof projectId === 'string') platform.broadcast(IPC.shipConfigChanged(projectId), projectId)
    return result
  })

  interface Sub {
    leases: Map<string, number>
    stop: () => void
  }
  const subs = new Map<string, Sub>()
  /** Survives a lapsed subscription, so a view that lost its lease while hidden still hears of what
   *  changed in the meantime. One string per project someone looked at. */
  const lastSeen = new Map<string, string>()
  const polling = new Map<string, Promise<unknown>>()

  const start = (projectId: string, sub: Pick<Sub, 'leases'>): (() => void) => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const end = (): void => {
      alive = false
      clearTimeout(timer)
    }
    const tick = async (): Promise<void> => {
      if (!alive) return
      const now = Date.now()
      for (const [id, expires] of sub.leases) if (expires <= now) sub.leases.delete(id)
      if (sub.leases.size === 0) {
        end()
        subs.delete(projectId)
        return
      }
      for (let out = polling.get(projectId); out; out = polling.get(projectId)) {
        await out.catch(() => {})
        if (!alive) return
      }
      const read = readShipConfig(projectId, router)
      polling.set(projectId, read)
      try {
        const signature = JSON.stringify(await read)
        if (alive) {
          const last = lastSeen.get(projectId)
          if (last !== undefined && signature !== last) platform.broadcast(IPC.shipConfigChanged(projectId), projectId)
          lastSeen.set(projectId, signature)
        }
      } catch {
        /* a transient failure keeps the last signature; the next tick retries */
      } finally {
        if (polling.get(projectId) === read) polling.delete(projectId)
      }
      if (!alive) return
      let remote = false
      try {
        remote = router.route(projectId).kind === 'remote'
      } catch {
        /* the next read reports the failure to whoever asks */
      }
      timer = setTimeout(() => void tick(), remote ? SHIP_POLL_REMOTE_MS : SHIP_POLL_LOCAL_MS)
      timer.unref?.()
    }
    void tick()
    return end
  }

  platform.on(IPC.shipConfigSubscribe, (projectId: unknown, leaseId: unknown) => {
    if (typeof projectId !== 'string' || !projectId || typeof leaseId !== 'string' || !leaseId) return
    const existing = subs.get(projectId)
    if (existing) {
      existing.leases.set(leaseId, Date.now() + SHIP_LEASE_MS)
      return
    }
    const sub: Sub = { leases: new Map([[leaseId, Date.now() + SHIP_LEASE_MS]]), stop: () => {} }
    subs.set(projectId, sub)
    sub.stop = start(projectId, sub)
  })

  platform.on(IPC.shipConfigUnsubscribe, (projectId: unknown, leaseId: unknown) => {
    if (typeof projectId !== 'string' || typeof leaseId !== 'string') return
    const existing = subs.get(projectId)
    if (!existing) return
    existing.leases.delete(leaseId)
    if (existing.leases.size === 0) {
      existing.stop()
      subs.delete(projectId)
    }
  })
}
