# Ship process and `ship-graph.json`

The agent graph view (the graph icon on the active project's tab, or **Agent graph** in ⌘K) shows a
project's sessions, what passes between them, and how work moves through your ship process.

That process is not built in. It is read from the machine the project runs on: this computer for a
local project, the host for an SSH project.

- **Agents** come from `agents/*.md` frontmatter in `~/.claude` (or `$CLAUDE_CONFIG_DIR`) and the
  project's `.claude`. Symlinks are followed. A project agent replaces the global one of the same name.
- **Commands, workflows and skills** are listed by name, for reference.
- **Routing** comes from an optional file. Agent files describe agents, not how work moves between
  them, so nothing else can say what follows what.

Settings → Ship process shows all of this for the active project and creates or opens the file. Both
places re-read the machine while open: every 5 s locally, every 20 s over SSH.

## With no file

The graph draws what it observes. Each agent type a session starts becomes a box, and a line joins a
subagent to the latest one that had already finished when it started. Subagents running at the same
time are siblings. Going back to a type first seen earlier in the run is labelled "went back". With no
file there is no order to judge by, so that line can be a rejection or a clean second run in the same
turn; it does not say which. Add a file to tell them apart. A new prompt or a `/clear` does separate
them.

## With a file

`.claude/ship-graph.json` in the project replaces `~/.claude/ship-graph.json` whole; they are not
merged. A file that cannot be read gives a warning and the other one is used. That includes something
at that path that is not a regular file (a folder, a FIFO, a dead link): the row says "Not usable".

```json
{
  "pipelines": [
    {
      "id": "ship-change",
      "name": "Ship change",
      "trigger": { "command": "ship-change" },
      "stages": [
        { "id": "impl", "agent": "implementer" },
        { "id": "docs", "agent": "doc-writer" },
        { "id": "review", "agent": "change-reviewer" }
      ],
      "edges": [
        { "from": "impl", "to": "docs" },
        { "from": "docs", "to": "review" },
        { "from": "review", "to": "impl", "kind": "reject" },
        { "from": "review", "to": "docs", "kind": "reject" }
      ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id`, stage `id` | A short token: letters, digits, `.`, `_`, `-`. |
| `name`, stage `label` | Display text. |
| stage `agent` | The agent type, matched exactly against live subagents. May contain `:` (`plugin:agent`). |
| edge `kind` | `next` (the default) or `reject`. |
| `trigger.command` | The command's name, shown on each stage beside the pipeline's name. |

Each run (a turn, or from one reset to the next) maps onto the pipeline that names the most of its
subagents. On a tie, the one whose `next` edges match the order they ran in wins; list order never
decides. If that is still a tie between pipelines sharing agents, the run is drawn as observed, with a
notice, and nothing is called a rejection. A session can run several pipelines, and a pipeline whose
agents ran is never shown as unrun.

An agent used by several stages is placed by position, in this order: the stage declared next after the
one before it, a declared reject from there, a retry of the same stage (or a stage fanning out beside it
that has not run yet), then the nearest one reachable from there. If nothing declares a route to it, it
goes on the earliest stage by the declared order, with a notice, draws no move, and is never called a loop.

When a stage has both a `next` and a `reject` edge to stages of the same agent, hooks cannot tell which
happened: with impl, r1, fix, r2, an implementer after r1 is either a passed review or a failed one. The
run is counted on neither stage, both edges are marked "maybe", each stage gets a "maybe" badge, and a
notice names them. What follows stays uncertain, placed from both positions, until a stage only one route
reaches or an agent only one stage uses.

Choosing a pipeline has limits. A clean run of one pipeline hides another that shares an agent with it,
since its agents ran, until those events age out. The fit ignores reject edges, and it is judged on what
has run so far, so a run's pipeline can change as more of it arrives.

A move backwards along the
order your `next` edges declare is highlighted as a loop, and a stage it returns to is marked
re-entered. A move the file does not declare is still drawn, marked "not declared". A pipeline nothing
has run yet is shown unattached, so you can see the process before using it. A stage whose agent has no
file says "no agent file found"; built-in and plugin agents have none, so that does not mean it cannot
run.

### Telling a second run from a rejection

A real reset (`/clear`, or launching the CLI fresh) or a new user prompt starts a new run, so running
`/ship-change` twice is not a loop. A compaction or a `--resume` does not start one: the same work goes
on, under the same session id, and a subagent still running when a compaction begins stays running
until its own stop. A custom slash command is a new user prompt. A hand-back or task notification
Claude injects when a background subagent finishes is not. Inside one turn, hooks cannot tell "the reviewer rejected, go back to the first stage" from
"start over", so the file decides:

- A move the file declares is taken as declared. With the example above, review to impl in one turn
  is a rejection.
- A move the file does not declare, from a last stage to a first stage, is a new run.

So a rejection a person relays in a new prompt reads as a new run, and is not drawn as a loop. That
under-reports on purpose: an invented loop would say a review failed when it did not.

A subagent started again under the same id after it stopped counts as another pass, with its own place
in the order, whether the parent resumed it with SendMessage, which is what a rejection does, or a
background agent picked up after its own child. Its first pass keeps its first end, including when
Claude reports a stop twice around a hand-back.

Write a way back with `"kind": "reject"`. A `next` edge that closes a cycle gets a warning and does not
count toward the order. Only `next` edges declare an order, never the order stages are listed in: with
none, nothing is called a loop, and a stage no `next` edge touches is never behind anything.

**Nothing in this file is ever executed.** It travels in git, so it is hostile input: it is sanitized
in the core and used only to draw. `trigger.command` is a name, and a value that is not a plain name is
dropped. Limits: 256 KiB, 16 pipelines, 32 stages and 64 edges each. Whatever is dropped from a file
that could be read is named in a warning, including a bad trigger or a repeated edge. Unknown fields are
ignored without one.

## Known limits

- Subagent mapping is Claude-only. Other CLIs appear as sessions and message lines.
- `/shipit` delegates share one agent type (`shipit-agent`), so they cannot be told apart by stage.
- Workflow `agent()` runs and `SubagentStop` gate results are not shown: neither is confirmed visible
  to hooks.
- A session running under a managed Claude account has its own config dir. Discovery reads the default
  one (`~/.claude` or `$CLAUDE_CONFIG_DIR`), not the account's.
- There is no visual pipeline editor.
- Message counts count traces: a message that queued and then landed is one queued and one delivered.
  Subagent history lasts for one app run; message history lasts as long as the project's board log.
- Project members with a Viewer or Commenter role, and project-scoped guests, see the observed graph
  only. A machine's Claude config belongs to its user.
