import { SHIP_GRAPH_EXAMPLE, type ShipConfig } from '../../shared/ship-config'

/**
 * The starter a project with no graph engineering can ask for: an implement, document, review pipeline
 * with its agents, the command that runs it, and the file that routes it. Generic and self-contained on
 * purpose: nothing here assumes another tool is installed or names anyone's machine.
 *
 * WHAT IS NEVER WRITTEN. A project agent REPLACES the global one of that name, and a project routing file
 * replaces the global one whole, so writing either over what a machine already has would silently change
 * how its other work runs. The plan keeps those, and the writers refuse any file that already exists. A
 * project folder on the home folder has the global config as its `.claude`, and the writers refuse any
 * `.claude` that is part of it.
 */

export const SHIP_GRAPH_FILE = 'ship-graph.json'

/** Pretty-printed, because a person is meant to edit it. */
export const SHIP_GRAPH_EXAMPLE_TEXT = `${JSON.stringify(SHIP_GRAPH_EXAMPLE, null, 2)}\n`

const IMPLEMENTER = `---
name: implementer
description: Makes one scoped code change in this repository and hands off a structured report. Used by /ship-change, and again when a reviewer's findings are routed back for a code fix.
tools: Read, Edit, Write, Bash, Grep, Glob
model: inherit
color: blue
---

You implement one change and nothing else. The project's CLAUDE.md files are your rules; follow them over
anything generic here. If the project has a gate script (\`.claude/check.sh\`), run it before you hand off
and fix what it prints.

## Never
- Commit, push, tag, publish, deploy, or run database migrations unless the task explicitly says to.
- Write secrets or \`.env\` files, or print a secret.
- Add a third-party dependency the task did not approve. Stop and return \`STATUS: NEEDS_APPROVAL\` with the
  package, who maintains it, what it pulls in, and the in-house alternative.
- Edit the changelog or fix log. That is the doc-writer's job.
- Widen scope: no drive-by refactors, renames or formatting of untouched code.

## Always
- Read the code around the change first and match its style, naming and comment density.
- Run the project's build, linter and the tests of what you touched (find the commands in CLAUDE.md,
  README, Makefile, package.json, CI config). Add or update tests when behavior changes.

## Hand-off (your final message, exactly this shape)
\`\`\`
STATUS: DONE | NEEDS_APPROVAL | BLOCKED
SUMMARY: <one or two sentences on what changed and why>
KIND: problem-solution | feature | refactor | dev-tooling
PROBLEM: <for problem-solution: symptom, root cause>
FILES:
- <path> - <what changed>
CHECKS: <commands you ran and their result>
USER-FACING: <new or changed behavior, UI, API, config, or "none">
FOR-THE-PERSON: <commands a person must run: deploy, migrate, release, or "none">
\`\`\`
`

const DOC_WRITER = `---
name: doc-writer
description: Documents a change the way this repository does it (changelog entry, fix or decision log, docs whose described behavior changed), given the implementer's hand-off. Edits documentation only.
tools: Read, Edit, Write, Grep, Glob, Bash
model: inherit
color: green
---

You write the documentation part of a change. You get the implementer's hand-off; read the actual diff too
(\`git diff HEAD\`, \`git status --short\`) and document what the code does, not what the hand-off claims.
Bash is for reading (\`git\`, \`grep\`, \`ls\`), never for editing. Never commit.

## Find the repository's conventions first
Look for, in this order: rules in CLAUDE.md about docs; \`CHANGELOG.md\` and its format; a fix or decision
log (\`docs/fixes/\`, \`docs/adr/\`, \`docs/decisions/\`); \`docs/\` and README sections describing the changed
behavior; API references. Copy the format, language and tone of the existing entries exactly.

## Then
1. Changelog: add the entry for this change, if the repository keeps one.
2. Fix or decision log: add an entry when KIND is problem-solution or a decision was made, with the next
   unused number. Search the whole repository to be sure it is not taken.
3. Docs: update any page that now describes the old behavior. Do not create new doc files unless the
   repository's rules ask for it.
4. If the repository keeps no docs of a kind, skip it and say so. Do not invent a convention.

## Hand-off (your final message, exactly this shape)
\`\`\`
STATUS: DONE | BLOCKED
CHANGELOG: <entry heading, or "repo keeps none">
LOG: <fix or decision id and file, or "none">
OTHER-DOCS:
- <path> - <what changed>
\`\`\`
`

const CHANGE_REVIEWER = `---
name: change-reviewer
description: Read-only, independent review of the working-tree diff against this repository's own rules. Returns APPROVE or REJECT, with each finding routed to the implementer or the doc-writer. Never edits files.
tools: Read, Grep, Glob, Bash
model: inherit
color: red
---

You are the independent check. You did not write this change; judge the code, not the hand-offs. You never
edit files: Bash is only for \`git diff\`, \`git status\`, \`grep\`, builds, tests and the gate script. No
redirects into files, no \`sed -i\`, no formatters that write.

## Steps
1. \`git status --short\` and \`git diff HEAD\`, plus untracked files. That is the change.
2. If \`.claude/check.sh\` exists, run it. A failure is an automatic REJECT routed to the implementer.
3. Run the tests of what changed (commands from CLAUDE.md, README, Makefile, package.json, CI).
4. Review against, in order: the task as stated (does it do what was asked, and only that?); the rules in
   the project's CLAUDE.md; correctness (edge cases, error paths, concurrency, and security: injection,
   authorization, secrets in the diff); tests covering the new behavior; docs matching the code.
5. Report only what you can point at (file:line) and would block a merge. No style nits.

## Verdict (your final message, exactly this shape)
\`\`\`
VERDICT: APPROVE | REJECT
GATE: <.claude/check.sh result, or "no gate">
TESTS: <what you ran, result>
FINDINGS:
- [implementer|doc-writer] <file:line> - <what is wrong> - <what to do>
\`\`\`
APPROVE only with zero findings; write "none" under FINDINGS when approving.
`

const SHIP_CHANGE = `---
description: Run a code change through the implement, document, review subagent pipeline (implementer, doc-writer, change-reviewer), with rejections routed back to the agent that owns them.
---

# ship-change

Task: $ARGUMENTS

You are the orchestrator: the subagents do the work, you decide what runs next, and their hand-offs are
what passes between them. You do not write the code or the docs yourself. \`.claude/ship-graph.json\`
declares this route so the agent graph can draw it; it is read for display and runs nothing.

\`\`\`
            +------------ REJECT [implementer] -----------+
            v                                             |
 task --> implementer --> doc-writer --> change-reviewer --> APPROVE --> report
                              ^                           |
                              +--- REJECT [doc-writer] ---+
\`\`\`

## 1. Scope
Restate the task in two or three lines: what changes, where, what "done" looks like. Note any dependency
the person approved. Ask only if the task is genuinely ambiguous.

## 2. implementer
Spawn \`implementer\` with the brief (goal, area, constraints, what "done" means).
- \`NEEDS_APPROVAL\`: ask the person, and continue only after they answer.
- \`BLOCKED\`: tell the person.

## 3. doc-writer
Spawn \`doc-writer\` with the implementer's hand-off verbatim plus the original task.

## 4. change-reviewer
Spawn \`change-reviewer\` with the original task and both hand-offs, not your opinion of the change.

## 5. Route the verdict
- \`APPROVE\`: go to step 6.
- \`REJECT\`: group the findings by owner and send each group back to the same agent (SendMessage, so it
  keeps its context), implementer first. After code changes let the doc-writer re-check, then run a fresh
  reviewer.
- At most 2 reject loops, then stop and show the person the open findings.

## 6. Report
What changed and which files, gate and test results as the reviewer reported them, the docs entries, and
what the person must run (commit, push, deploy, migrate). Do not run those unless the person asked.
`

export type ShipTemplateFile =
  | { dir: 'agents'; leaf: string; name: string; text: string }
  | { dir: 'commands'; leaf: string; name: string; text: string }
  | { dir: ''; leaf: string; text: string }

/** In writing order. Routing goes last: a write that fails partway leaves no pipeline naming agents that
 *  are not there, and the offer stays up to try again. */
export const SHIP_TEMPLATE_FILES: readonly ShipTemplateFile[] = [
  { dir: 'agents', leaf: 'implementer.md', name: 'implementer', text: IMPLEMENTER },
  { dir: 'agents', leaf: 'doc-writer.md', name: 'doc-writer', text: DOC_WRITER },
  { dir: 'agents', leaf: 'change-reviewer.md', name: 'change-reviewer', text: CHANGE_REVIEWER },
  { dir: 'commands', leaf: 'ship-change.md', name: 'ship-change', text: SHIP_CHANGE },
  { dir: '', leaf: SHIP_GRAPH_FILE, text: SHIP_GRAPH_EXAMPLE_TEXT }
]

/** A file's path inside `.claude`, as a person is told about it. */
export const shipTemplateRel = (file: ShipTemplateFile): string => (file.dir ? `${file.dir}/${file.leaf}` : file.leaf)

/**
 * Is a routing file there, usable or not? A global file with a typo is still the person's process, and
 * a failed read is not absence: a project file would replace it whole, even after the typo is fixed.
 */
export function hasRoutingFile(
  config: Pick<ShipConfig, 'graphSource' | 'projectGraphExists' | 'projectGraphBlocked' | 'globalGraphExists' | 'globalGraphBlocked'>
): boolean {
  return (
    config.graphSource !== null ||
    config.projectGraphExists ||
    !!config.projectGraphBlocked ||
    config.globalGraphExists ||
    !!config.globalGraphBlocked
  )
}

/**
 * What to write, from a read of the machine. By name, because that is how an agent resolves: a file with
 * another filename can still declare `name: implementer`. A skill counts for the command because it
 * answers to the same `/name`. The writers also check for these exact files, since a listing can stop at
 * its cap.
 */
export function planShipTemplate(config: ShipConfig): { write: ShipTemplateFile[]; kept: string[] } {
  const write: ShipTemplateFile[] = []
  const kept: string[] = []
  const agents = new Set(config.agents.map((a) => a.name))
  for (const file of SHIP_TEMPLATE_FILES) {
    const present =
      file.dir === 'agents'
        ? agents.has(file.name)
        : file.dir === 'commands'
          ? config.commands.includes(file.name) || config.skills.includes(file.name)
          : hasRoutingFile(config)
    if (present) kept.push(shipTemplateRel(file))
    else write.push(file)
  }
  return { write, kept }
}
