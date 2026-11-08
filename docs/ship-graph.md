# Ship process and `ship-graph.json`

The agent graph view (the graph button on the active project's tab, or **Agent graph** in ⌘K) shows a
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

## Setting a project up

A graph with nothing to draw offers **Set up graph engineering** when there is no routing file at all,
in the project or in the global config. A file at either path ends the offer even if it is not usable,
and even if it routes nothing. The action adds a starter pipeline to the project's `.claude` folder, on
the machine the project runs on:

| File | What it is |
|---|---|
| `agents/implementer.md`, `agents/doc-writer.md`, `agents/change-reviewer.md` | The three agents. |
| `commands/ship-change.md` | The `/ship-change` command that runs them. |
| `ship-graph.json` | The route, as in the example below. |

Nothing runs until you type `/ship-change <task>` in a Claude session.

It never overwrites a file, and it does not shadow what you already have, because a project agent
replaces a global one of the same name. It keeps, without writing:

- any file already at that path, including a dead link;
- an agent the machine already has, whatever file declares that name;
- the command, when a command or skill named `ship-change` exists;
- `ship-graph.json`, when a routing file has appeared since the offer, in the project or in the global
  config.

The note after it finishes lists what was created and what was kept. The routing file is written last and
the write stops at the first failure, so a failure leaves no route naming an agent that is not there; the
message names what was created before it stopped. A project folder that no longer exists is refused, not
recreated. On a canvas with no folder the button is disabled and says why.

A project whose `.claude` is part of the machine's Claude config is refused before anything is written,
because a file there would reach every project on that machine. That is usually a project opened on the
home folder, and a new SSH project's folder is the home folder. The same refusal applies to **Create
example** on the "This project" row in Settings → Ship process. The "All projects" row still writes to the
global config, because that is what it asks for.

Both compare real paths: the project's `.claude` is refused if it is the global config or lies inside it.
So a project opened on `~/.claude` or under it is refused, and so is a link to the home folder or a `.claude`
linked into the global config, even to a subfolder that does not exist yet. A sibling like `~/.claude-2` is
not refused, and a home folder is fine when `CLAUDE_CONFIG_DIR` points somewhere else. A check that cannot run
also refuses. Both buttons stay enabled for such a project, and the refusal appears after you click.

**Set up graph engineering** checks more, because it writes more. It also checks `.claude/agents` and
`.claude/commands`, and it compares all three with the global `agents` and `commands` folders as well, since
those can be links out to a shared kit. It also refuses when a global `agents` or `commands` folder exists but
cannot be read, since that says nothing about what is in it. Create example only writes the routing file, so
it checks `.claude` against the global config alone, and an unreadable global `agents` folder does not block
it.

## With no file

The graph draws what it observes. Each agent type a session starts becomes a box, and a line joins a
subagent to the latest one that had already finished when it started. Subagents running at the same
time are siblings. Going back to a type first seen earlier in the run is drawn in amber with its count
(`×2`). With no file there is no order to judge by, so that line can be a rejection or a clean second
run in the same turn; it does not say which, and its hover text says so. Add a file to tell them apart.
A new prompt or a `/clear` does separate them.

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
goes on the earliest stage by the declared order, with a notice. That position is a guess, as is choosing
between stages of one agent that fan out, and it stays one through later runs of agents several stages
use, until an agent only one stage uses settles it. Only declared `next` moves are drawn into or out of a
guess, so it is never called a loop or a rejection. A real rejection that follows one is not drawn either.

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

## Harness, skills and MCP

The graph is also the place to check the harness your sessions run in: which skills and MCP servers
they actually reached for, drawn with the sessions and subagents that used them.

**What is drawn.**

- **One Harness box per machine**, to the left of the sessions on it, with a quiet line to each
  session. It says how many sessions run there, how many are working, how many skills are installed
  and how many MCP servers are configured. A figure the machine's config could not state is left off
  rather than shown as zero.
- **A box per skill and per MCP server that was used**, shared by every session of the project, so a
  skill three sessions use is one box with three lines into it. Installed but unused skills and servers
  are not boxes. They are in the Harness panel.
- **A line from whoever called it.** A subagent's calls leave the box its run is drawn in (its stage, or
  its agent type), and the session's own calls leave the session. When a run is only a guess, was drawn
  twice or is no longer in the history, its calls leave the session instead, because naming a stage
  would claim more than the hooks say.
- **A dot per call.** Each time a call happens, one dot travels along its line, once, and stops. Dots
  on the Harness line run from the session to the Harness box, because that is the way hooks flow. A
  burst shows at most three dots at once. An idle graph has no animation running, and with reduced
  motion on the dots are not drawn at all. Opening the view, or switching back to 2D from 3D, does not
  replay what already happened.

**The Harness panel** (the Harness button, or a click on a Harness, skill or MCP box) is the inventory:

- The machine, and how many of its agent sessions are running, need you, are idle, or have said
  nothing yet. An agent with no signal is "no signal yet", never idle.
- Which agents nodeterm may hook on that machine: enabled, declined or not asked. For an SSH host the
  host and the agent must both be enabled. For a team tab the host decides, and this panel says it
  cannot read that choice.
- Skills: those installed on the machine with how often each was used, plus used ones the machine has
  no folder for, which come from a plugin or are built in.
- MCP servers: those the machine's Claude config declares, with transport (stdio, http or sse) and
  where they are declared, plus used ones that are not in those files, which are connectors or plugins.
- Why something is missing, when the config could not be read.

**Where it comes from.** Skill and MCP use comes from Claude's own hooks: a `Skill` tool call and a
`mcp__<server>__<tool>` call, from a session or from one of its subagents. A skill typed as `/name`
fires no tool call, only the prompt, so it is drawn only when the name is a skill or command on the
machine. `/clear` and a stray `/word` are not. MCP configuration is read from `~/.claude.json` (or
`$CLAUDE_CONFIG_DIR/.claude.json`), including the entry for the project's folder, and from the
project's `.mcp.json`. Only each server's name and transport are kept. Its command, arguments,
environment, URL and headers can hold tokens and are never read past the parser, shown or logged.

**Limits.**

- Claude only. Other CLIs do not report skill or MCP use.
- Counts are calls started in this app run, read from `PreToolUse`, so a call later denied still counts.
  They are not saved, so a restart starts them again. On a relay tab that is not an Editor's, a typed
  `/skill` is not counted: its name could be anything typed after `/`.
- The newest 40 skills and servers used are drawn. Any more are named in a notice and still listed in
  the panel.
- An SSH host's MCP config is not read, because `~/.claude.json` holds credentials. Its servers appear
  once used, and the panel says so. Its skills are listed.
- Claude.ai connectors and plugin skills are not in any file, so they appear only once used.
- Claude rewrites characters outside letters, digits, `_` and `-` in a server's name when it names a
  tool, so a server called `my.server` shows as `my_server` once used. The panel matches the two.
- A team member with a Viewer or Commenter role sees the boxes and lines for the nodes shared with
  them, and not the machine's inventory. Project-scoped guests likewise.

## Which way a line runs

Every line except a context link or a Harness line carries small chevrons pointing the way it runs. A
context link has none because it is read on demand, not passed along, and a Harness line is a fact
about where a session runs. The chevrons move only while something is passing along
the line:

- a message, for 15 s after it is delivered;
- a line between agents that has been used, while the run it led to is going and for 15 s after that run
  started.

The rest stay still: a queued, failed or refused message, an "opened" line, a dependency, a declared line
nothing has used, and anything marked "maybe", since hooks cannot confirm that route was taken. A retry of
the same stage is a run count on its box, so no line moves for it.

A move placed by a guess (see "With a file") is still counted, and its line still pulses when the move
arrives, but its chevrons do not move. That holds for the line into the guess and the line out of it.

Moving chevrons pause while the window is unfocused or hidden, and stay still under Reduce Motion.

## 2D and 3D

The **2D / 3D** switch in the graph's header picks how the graph is drawn. Both views show the same
boxes and lines, and share the legend, the notices and the side panels. The graph opens in 2D the
first time. After that it opens in the view you used last, for every project. The choice is kept on
this computer, or in this browser for the Server Edition.

**2D** is the layout described above. A box or a line fades in when it first appears, and not again
when its status changes. Everything fades in again when you switch back from 3D. A session's box glows in its status colour: working, needs you or idle.
Working and needs you pulse four times and then stay lit, and pulse again each time a session moves
into either one. Idle is lit and still. Dots grow in and out
with a soft halo in their line's colour. Glows stop pulsing while the window is unfocused or hidden.
Under Reduce Motion nothing fades in and nothing pulses.

**3D** draws the same graph as a force layout you can turn. Its code loads the first time you open
it.

- Each kind of box has its own shape. A session is a sphere in its agent's colour. A Harness is an
  icosahedron, a stage or subagent a dodecahedron, a skill an octahedron, an MCP server a cube and a
  note a tetrahedron. A session has a still halo in its status colour, and any box whose run is in
  progress has the working one.
- Each name floats above its shape, cut at 40 characters. Hover a shape to read everything its 2D box
  says. Hover a line to read its label and its description.
- Drag to turn the camera and scroll to zoom. Shapes cannot be dragged. **Fit**, at the top left,
  frames the whole graph. The camera also frames it by itself each time the layout settles after a box
  or a line comes or goes. The view never rotates on its own.
- A click does what it does in 2D. A session opens its terminal. A Harness, skill or MCP shape opens
  the Harness panel. A note is shown on the canvas. A shape and its name take a click or a hover, but
  the halo around it does not, so a line beside a glowing session can still be hovered.
- One particle travels along a line per event, as the 2D dots do, at most three on a line at once.
  Harness particles run from the session to the Harness, as in 2D. Opening the view does not replay
  what already happened.
- The view draws only while something on it moves or your pointer is over it. It stops while the
  window is unfocused or hidden, and while a terminal is open over it. An event that happens then gets
  no particle, then or later. Boxes that arrive while it is stopped find their place when you come
  back.
- Under Reduce Motion the layout appears already settled, the camera jumps instead of flying, and no
  particles are drawn.

**When 3D cannot draw.** The 3D view needs WebGL. If this window cannot create it, loses its
graphics context, cannot load the 3D view, or the 3D view stops with an error, the graph shows 2D
with a notice that says why. The switch then shows 2D, but your choice stays 3D.

| Notice | What happens next |
|---|---|
| The 3D view needs WebGL, which this window cannot create. | The next time the graph opens it tries 3D again. You can also click 3D to try at once. |
| The 3D view lost its graphics context. | The same: the next open, or a click on 3D, tries again. |
| The 3D view stopped with an error. | The same: the next open, or a click on 3D, tries again. |
| The 3D view could not be loaded. | 3D stays unavailable until DisTerm restarts or its window is reloaded. Until then, clicking 3D or reopening the graph shows this notice again. |

Each notice ends with "Showing the 2D view."

**What 3D shows differently.**

- No moving chevrons. A line in use shows only its particles. An arrowhead marks which way each line
  runs, except a Harness line.
- A line that is dashed in 2D (a dependency, a context link, a rejection, a loop, a move not declared,
  anything marked "maybe") is a fainter solid line. The legend still draws it dashed.
- Badges and line labels, such as message counts and a line's `×2`, appear only on hover. A box's run
  count stays in its name.
- Nothing pulses when a move or message arrives. The particle is the arrival.
- Status halos do not pulse.

## Known limits

- Subagent, skill and MCP mapping is Claude-only. Other CLIs appear as sessions and message lines.
- `/shipit` delegates share one agent type (`shipit-agent`), so they cannot be told apart by stage.
- Workflow `agent()` runs and `SubagentStop` gate results are not shown: neither is confirmed visible
  to hooks.
- A session running under a managed Claude account has its own config dir. Discovery reads the default
  one (`~/.claude` or `$CLAUDE_CONFIG_DIR`), not the account's.
- There is no visual pipeline editor.
- **Set up graph engineering** needs the Editor role or above on a shared project, and is not offered to
  project-scoped guests. It is not offered while the machine cannot be read, such as a disconnected SSH
  project.
- Message counts count traces: a message that queued and then landed is one queued and one delivered.
  Subagent history lasts for one app run; message history lasts as long as the project's board log.
- Project members with a Viewer or Commenter role, and project-scoped guests, see the observed graph
  only. A machine's Claude config belongs to its user.
