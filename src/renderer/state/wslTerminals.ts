import { create } from 'zustand'
import type { TerminalProfile } from '@shared/terminal-profiles'
import { useProjects } from './projects'
import { trustedProjectShell } from './projectLaunchInfo'
import { useSettings } from './settings'
import type { AgentId } from '@shared/agents/config'
import type { Project } from '@shared/types'
import { isWslShellValue, parseWslShell } from '@shared/terminal-profiles'

/** One WSL distribution offered as a terminal: the row's name and the `shell` value it starts. */
export interface WslTerminalRow {
  label: string
  shell: string
}

const NONE: readonly WslTerminalRow[] = []

/**
 * This machine's WSL distributions, for every "new terminal" surface. Canvas lists them once and
 * publishes them here, so a menu on each of many nodes costs no `wsl.exe` launch. The list is empty
 * unless the core runs on Windows: `listTerminalProfiles` answers nothing anywhere else, and Canvas
 * does not ask. So Mac and Linux get no rows.
 */
export const useWslTerminals = create<{
  rows: readonly WslTerminalRow[]
  publish: (profiles: readonly TerminalProfile[]) => void
}>((set) => ({
  rows: NONE,
  publish: (profiles) => {
    const rows = profiles
      .filter((p) => p.kind === 'wsl')
      .map((p) => ({ label: p.label, shell: p.value }))
    set({ rows: rows.length > 0 ? rows : NONE })
  }
}))

/**
 * A distribution belongs to this desktop, so only a project on this machine can start one. An SSH
 * project (a WSL project included, whose terminals are already in its distro) and a relay tab run on
 * another core.
 */
export function mayStartWslTerminal(project: Pick<Project, 'ssh' | 'remote'> | null | undefined): boolean {
  return !!project && !project.ssh && !project.remote
}

/** The rows to offer for a project, read at the moment a menu is built. */
export function wslTerminalsForProject(projectId: string | null | undefined): readonly WslTerminalRow[] {
  const project = projectId ? useProjects.getState().getProject(projectId) : undefined
  return mayStartWslTerminal(project) ? useWslTerminals.getState().rows : NONE
}

/** {@link wslTerminalsForProject} for a surface that stays on screen. */
export function useWslTerminalsFor(projectId: string | null | undefined): readonly WslTerminalRow[] {
  const allowed = useProjects((s) => mayStartWslTerminal(s.projects.find((p) => p.id === projectId)))
  const rows = useWslTerminals((s) => s.rows)
  return allowed ? rows : NONE
}

/**
 * The distribution a new agent node runs in, or undefined for this machine: the row the person picked,
 * else what the spawn would resolve anyway, the project's shell and then the machine's default. Claude
 * only: the status hook and the version probe are not wired for another agent in a distribution.
 *
 * Decided at creation and stamped on the node, because the line is built for that CLI: a later change
 * of either setting must not move the node to a shell whose Claude it was not built for.
 */
export function wslShellForNewAgent(
  agentId: AgentId,
  picked: string | undefined,
  defaultShell: string | undefined,
  project: Pick<Project, 'ssh' | 'remote'> | null | undefined,
  projectShell?: string
): string | undefined {
  if (agentId !== 'claude' || !mayStartWslTerminal(project)) return undefined
  if (picked) return picked
  const shell = projectShell || defaultShell
  return parseWslShell(shell) ? shell : undefined
}

/**
 * Does this node's pane run in a distribution of THIS core? Answers the way the spawn resolves it: its
 * own shell, then the project's, then the default. The pane probes see `wsl.exe` whatever runs inside,
 * and a transcript is on the far side of the boundary, so callers ask this before trusting either.
 *
 * An SSH node ignores a `wsl:` value (its pane is on the host) and a relay node's is the host's
 * business: this machine's settings say nothing about either, and reading them would take the chat
 * view and Restart away from a healthy remote node.
 *
 * A node with no shell of its own is read from TODAY's settings, which can differ from what its live
 * pane was spawned with. Nodes this app creates in a distribution are stamped, so that needs a setting
 * changed under an older node.
 */
export function paneRunsInWsl(
  node: { shell?: unknown; ssh?: unknown; sshRemoteTmux?: unknown } | null | undefined,
  defaultShell: string | undefined,
  sessionSource?: string,
  projectShell?: string
): boolean {
  if (!node || node.ssh || node.sshRemoteTmux) return false
  if (sessionSource !== undefined && sessionSource !== 'local') return false
  const own = typeof node.shell === 'string' ? node.shell : ''
  return isWslShellValue(own || projectShell || defaultShell)
}

/** {@link paneRunsInWsl} from the live settings, for a node of `projectId`. */
export function nodePaneRunsInWsl(
  node: { shell?: unknown; ssh?: unknown; sshRemoteTmux?: unknown } | null | undefined,
  projectId: string | null | undefined,
  sessionSource?: string
): boolean {
  return paneRunsInWsl(
    node,
    useSettings.getState().settings.defaultShell,
    sessionSource,
    trustedProjectShell(projectId)
  )
}

/** Why an action that needs to see the CLI quit is refused on such a pane. */
export const WSL_PANE_EXIT_HINT =
  'This agent runs inside WSL, where DisTerm cannot see it quit. Type its exit command in the pane, then resume it there.'

/** Why a managed account cannot be picked for a pane in a distribution. */
export const WSL_ACCOUNT_REFUSED =
  'New terminals here start in WSL, and a managed Claude account does not reach WSL. Use the System account, or pick another shell for this project.'
