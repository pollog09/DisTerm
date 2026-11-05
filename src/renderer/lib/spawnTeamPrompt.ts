// The conductor prompt behind the user-facing "Spawn a team…" entry (issue #78). The app ships
// no built-in model, so the role split is BYO by design: the entry point opens ONE agent node
// pre-prompted with the task, and that conductor uses its own manage-nodeterm-canvas skill to
// plan and spawn the team. Kept out of React (verifyPanel.ts precedent) so the wording is
// unit-testable.

/** Hard cap on team size — must match the spawn-team handler's `.slice(0, 8)` in Canvas.tsx. */
export const MAX_TEAM_ROLES = 8

/**
 * The prompt the conductor node launches with.
 *
 * "Build with DisTerm orchestration" is load-bearing: it is the trigger phrase the
 * manage-nodeterm-canvas skill documents (canvas-control-core.ts, "Nodeterm orchestration"
 * section), and the whole station/worktree/collect-and-synthesize doctrine hangs off it —
 * re-stating that doctrine here would just be a second copy to drift. The only thing this
 * prompt adds is the worktree decision, which is the user's (the dialog checkbox), not the
 * conductor's.
 *
 * Written as prose on one line: createAgentNode collapses all whitespace to single spaces when
 * it bakes the prompt into the launch argv, so bullets or newlines would arrive mangled.
 */
export function conductorPrompt(opts: { task: string; worktrees: boolean }): string {
  const task = opts.task.replace(/\s+/g, ' ').trim()
  const worktreeSentence = opts.worktrees
    ? 'Give each independent workstream its own worktree station (open-worktree per stream).'
    : 'Do not create git worktrees for this run — open the team in the shared working tree instead (spawn-team, or open-agent per stream).'
  return `Build with DisTerm orchestration: ${task} ${worktreeSentence}`
}
