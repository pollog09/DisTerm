import type { Project } from '@shared/types'

/**
 * "Set folder…" (tab ⌄) points an EXISTING project — typically a cwd-less "New project" — at a
 * directory. That single act promotes the project from an INLINE canvas (stored verbatim inside
 * `workspace.json`) to a REF whose canvas is written to `<cwd>/.nodeterm/project.json`.
 *
 * It is therefore a WRITE into a folder we may never have read, and until this module existed it
 * did exactly that: the very next autosave overwrote whatever canvas the folder already held. A
 * teammate's committed `project.json` (rev 40, its own nodes) came back as this project's canvas at
 * rev 1, with no sideline copy and nothing on screen to say it had happened. "Open folder…" never
 * had the bug — it probes and ADOPTS (`openOrAdoptFolder`) — so the two entrances to the same
 * "attach a folder" idea disagreed, and the destructive one was the one a scratch project leads to.
 *
 * The decision is pure and lives here so both the refusal and its reason are testable, and so the
 * rule reads as one thing rather than as three branches inside a Canvas callback.
 */
export type SetProjectFolderPlan =
  /** Another project in this workspace already owns the folder — go there instead of pointing a
   *  second tab at one file (two same-cwd tabs collapse on save). `reopen` when that project is
   *  closed: switching to a closed project would land on a tab the user cannot see. */
  | { kind: 'switch'; projectId: string; reopen: boolean }
  /** The folder already carries a canvas (or one we could not read). Binding would overwrite it,
   *  so refuse and say so; the user's route is "Open folder…", which adopts it as its own project. */
  | { kind: 'occupied'; reason: string }
  /** The folder is free (no project file): bind it. */
  | { kind: 'bind' }

/** Shown when the folder already holds a canvas. Names the file, because the user's next question
 *  is "which folder?" and the answer has to be actionable without opening a terminal. */
export const folderOccupiedNotice = (folder: string): string =>
  `${folder} already contains a DisTerm canvas (.nodeterm/project.json). ` +
  `Setting it as this project's folder would overwrite it — use “Open folder…” to open that canvas instead.`

/** Shown when the file is there but unreadable (permissions, a stalled mount). A failed read is
 *  never evidence of absence (issue #385), so this refuses for the same reason the present case
 *  does, and says which of the two it is. */
export const folderUnreadableNotice = (folder: string): string =>
  `${folder} has a .nodeterm/project.json that could not be read. ` +
  `Setting it as this project's folder would overwrite it, so nothing was changed.`

/**
 * @param folder     the directory the user picked.
 * @param projectId  the project being pointed at it.
 * @param projects   every project in the workspace, CLOSED ONES INCLUDED — a closed project still
 *                   owns its folder on disk, and treating its folder as free is how the second
 *                   entry gets minted for one `project.json`.
 * @param fileState  `workspace.projectFileState(folder)` — 'present' | 'absent' | 'unreadable'.
 */
export function planSetProjectFolder(
  folder: string,
  projectId: string,
  projects: Pick<Project, 'id' | 'cwd' | 'closed'>[],
  fileState: 'present' | 'absent' | 'unreadable'
): SetProjectFolderPlan {
  const existing = projects.find((p) => p.cwd === folder && p.id !== projectId)
  if (existing) return { kind: 'switch', projectId: existing.id, reopen: !!existing.closed }
  if (fileState === 'present') return { kind: 'occupied', reason: folderOccupiedNotice(folder) }
  if (fileState === 'unreadable') return { kind: 'occupied', reason: folderUnreadableNotice(folder) }
  return { kind: 'bind' }
}
