import { create } from 'zustand'
import type { TerminalProfile } from '@shared/terminal-profiles'
import { useProjects } from './projects'
import type { Project } from '@shared/types'

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
