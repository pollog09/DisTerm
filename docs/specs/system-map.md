# System map in the graph view

## Problem Statement

The graph view shows only the **agent graph**: which agent sessions ran, what passed between them and how work moved through the ship process. It says nothing about the code those agents are working on. To see how a repo is put together, which services call which, where data is stored, what runs in the background and what lives outside the repo, a person has to leave DisTerm and read docs or code. They also can't see *where* in the system an agent is working right now.

Agents start from zero, too. Each Claude Code session rediscovers a repo's structure by reading files, because nothing gives it a shared picture of the system that it can read and keep current.

## Solution

The graph view gets a second picture, the **system map**, and a switch **Agents | System map** in its header to move between the two. The existing 2D/3D switch works for both.

A system map shows a repo's parts (callers, services, stores, workers, outside services) as boxes in columns, with the links between them and named **flows** that can be played step by step. A dot travels along each step, and some steps are marked as a guard or a refusal. It looks like the "Flow Atlas" mock attached to the design discussion: a flow list on the left, the map in the middle, a legend and "what is moving" on the right, and a player (back, pause, forward, 0.5x/1x/2x) under the map.

An agent writes the map, as a committed file in the repo, and DisTerm only reads and draws it. A repo without a map shows an empty state with a **Map this repo** action. It opens a new Claude terminal node on the canvas with a ready prompt telling it to write the map, so you can watch the session work like any other.

Claude Code uses the map in three ways:
- it **reads** it to find its way around (skill text and a `nodeterm map` CLI verb),
- it **updates** it when it adds, removes or rewires a part,
- and while it works, the parts whose files it is editing **light up live** on the map.

## User Stories

1. As a developer, I want a switch in the graph view header between Agents and System map, so that I can move between how my agents work and how my code is built without leaving the view.
2. As a developer, I want the switch to be remembered per project, so that a project I use as a system map reopens as a system map.
3. As a developer, I want the 2D/3D switch to stay independent of the Agents/System map switch, so that I choose the picture and the dimension separately.
4. As a developer, I want the system map in 2D to lay out parts in columns by kind (callers and endpoints, entry services, storage, workers, outside services), so that I can read the system left to right.
5. As a developer, I want each part to show a label and a short subtitle (for example "Go API :8080"), so that I know what it is at a glance.
6. As a developer, I want parts outside the repo drawn with a dashed border, stores drawn as stores and callers drawn as callers, so that the shape tells me the kind.
7. As a developer, I want a legend that explains every shape and mark, so that I don't have to guess what a dashed box or a green dot means.
8. As a developer, I want the links between parts drawn as lines with optional labels, so that I can see who talks to whom.
9. As a developer, I want a list of named flows grouped into sections, each with its step count, so that I can find the path I care about.
10. As a developer, I want an "Everything at once" entry that runs all flows together, so that I get a sense of the whole system's traffic.
11. As a developer, I want to pick one flow and step through it with back, pause and forward, so that I can follow a request hop by hop.
12. As a developer, I want playback speeds of 0.5x, 1x and 2x, so that I can slow down a complex flow or skim a simple one.
13. As a developer, I want each step's label shown in a "what is moving" panel, so that I can read what a hop does while the dot travels.
14. As a developer, I want steps marked as a guard or a refusal shown with distinct dots, so that I can see where the system protects or rejects something.
15. As a developer, I want the system map in 3D using the same engine, look and WASD flight as the agent graph, so that both pictures feel like one product.
16. As a developer, I want flow steps to travel as moving dots in 3D as well, so that playback works in both dimensions.
17. As a developer with a repo that has no map, I want an empty state that explains what a system map is and offers "Map this repo", so that I can get one without knowing the file format.
18. As a developer, I want "Map this repo" to open a visible Claude terminal node with a prepared prompt, so that I can watch and steer the agent writing my map.
19. As a developer, I want the mapping session to appear in the agent graph like any other session, so that nothing runs hidden.
20. As a developer, I want the map to be a committed file in the repo, so that it travels with the code, shows up in diffs and is shared with my team.
21. As a developer, I want a map file with errors shown as a readable list of problems (bad JSON, an unknown part in a link or flow, a missing field) instead of a blank view, so that I or an agent can fix it.
22. As a developer, I want a part whose file globs match no file flagged "no files", so that I can spot a stale map.
23. As a developer, I want the header to show the commit that last changed the map, so that I can judge how current it is.
24. As a developer, I want DisTerm never to rewrite my map on its own, so that the file only changes when I or an agent choose to change it.
25. As a developer, I want the parts whose files an agent is editing right now to light up on the map, so that I can see where in the system it is working.
26. As a developer, I want a lit part to fade when the agent stops touching it, so that the glow means "now", not "ever".
27. As a developer, I want hovering a lit part to show which session (or subagent) touched it, so that I can tell agents apart when several work at once.
28. As a developer, I want the view to reload the map when the file changes on disk, so that an agent's update appears without reopening the view.
29. As a developer, I want the map to follow the project's root, including SSH projects, so that a remote repo's map is read from the remote filesystem.
30. As a developer on the Server Edition, I want the system map to work in the browser the same as on desktop, so that I don't lose it on a server.
31. As Claude Code working in a repo, I want to run `nodeterm map` to get the system map as text, so that I can orient myself without reading every file.
32. As Claude Code, I want `nodeterm map` to tell me which part owns a given path, so that I know which part a change of mine affects.
33. As Claude Code, I want the skill text to tell me the file format and when to update the map, so that I keep it current when I add, remove or rewire a part.
34. As Claude Code, I want a clear error from `nodeterm map` when the repo has no map or the map is invalid, so that I can offer to write or fix it.
35. As a developer, I want file paths an agent edits never to be sent to the renderer, only the id of the part they matched, so that the graph's "no tool arguments on the wire" rule still holds.
36. As a developer, I want edits that match no part counted rather than shown, so that I can see the map's coverage without exposing paths.
37. As a developer working in a git worktree, I want the map read from that worktree's checkout, so that a branch that changes the map shows its own version.
38. As a developer, I want "go to node" requests (notifications, notch Go) to keep working while the system map is up, so that switching pictures doesn't make them dead.

## Implementation Decisions

- **Terms.** "System map" is the new picture, "agent graph" is the existing one, and "code map" keeps its meaning: the repo's own architecture docs. Recorded in the repo glossary.
- **The switch.** A per-project picture setting (`agents` | `system-map`) stored beside the existing per-project view mode, with the same parse-and-default rules. The 2D/3D display setting stays separate and applies to both pictures. The graph view's mount stays where it is; the canvas only gains what it needs to render the switch.
- **The file.** One JSON file at a fixed path under the repo's docs folder, committed. It's language-neutral, the agent writes it and DisTerm only reads it. Nothing goes under `.nodeterm/`, which is gitignored per-machine state. Shape:
  - `version`
  - `title`
  - `parts[]`: `id`, `label`, `subtitle?`, `kind` (`caller` | `service` | `store` | `worker` | `external`), `files[]` (globs relative to the repo root)
  - `links[]`: `from`, `to`, `label?`
  - `flows[]`: `id`, `name`, `group`, `steps[]` of `{ from, to, label, mark?: 'guard' | 'refusal' }`

  Columns come from `kind`, in the order caller, service, store, worker, external. The marks are generic, so the format isn't tied to any one domain.
- **Reading, in core.** A core module reads the file through the core that owns the project's filesystem (local, SSH, Server Edition), validates it into a typed map or a list of problems, checks each part's globs against the tree to produce "no files" warnings, and reports the last commit that touched the file. It runs behind `CorePlatform` and is polled on leases, like ship-config discovery, so a crashed renderer or a dropped relay peer can't leak a watcher. New IPC channels are declared in the shared channel list, and the preload and the Server Edition bridge both get real implementations.
- **Live touches.** Core takes the file path from the agent's file-editing tool hooks (Edit, Write and their equivalents), matches it against the current map's part globs, and adds a `map-touch` event `{ nodeId, subId?, partId, ts }` to the agent-graph event log. It's coalesced per (session, part) the way `access` events are. A path that matches no part only raises an unmatched counter. **No path ever crosses the wire.** The renderer treats a touch as live for the same staleness window the agent graph uses for activity.
- **The picture, in the renderer.** A pure model function turns a parsed map, the touches and `now` into boxes, columns, lines, flow lists and playback steps. A pure layout function places them in 2D, and the existing 3D lifting puts them in 3D (column becomes depth). The view parts are the switch, the flow sidebar, the player, the "what is moving" panel, the legend, the empty state and the problems list. Like the agent graph, layout is keyed on structure (parts and links), not on touches or playback.
- **Map this repo.** Creates a Claude terminal node on the canvas through the existing node-creation path, with a fixed prompt naming the file path, the format and the rule to write only what the agent has verified in the code. It doesn't start a hidden headless agent.
- **CLI and skill.** A `nodeterm map` canvas-control verb prints the map as text and, given a path, names the part that owns it. It returns a clear error when there's no map or the map is invalid. The canvas-control skill text gains the format and the rule: update the map when you add, remove or rewire a part.
- **Surfaces.** Desktop and Server Edition both get a real implementation. Kanban: not applicable (the system map isn't a view of nodes). Mobile companion: not in this fork. A note in the PR is enough.
- **The agent graph is untouched.** Its counting rules, layout and wire shapes don't change, except for the one new event kind, which its model ignores.

## Testing Decisions

- A good test drives the system from its edge (a real hook payload, a real map file, a rendered view) and asserts what a person or an agent would see. It never asserts internal calls or intermediate structures.
- **Main seam: hook payloads to the drawn map.** An acceptance test in the style of the existing real-hooks agent-graph suite. Recorded live Claude Code `PostToolUse` payloads for Edit and Write (a new fixture with provenance, captured the same way as the session-boundary fixture) go through the real normalizer, the core log and the snapshot into the model. It asserts that the right part is live, that it fades after the window, that an unmatched path only raises the counter, and that no path appears anywhere in the snapshot.
- **Map file to model, pure.** Unit tests on the validator and model, like the existing agent-graph model tests: valid file to columns, lines and flows in order; bad JSON, unknown part ids in links or flows, a duplicate id, a missing field to a problem list; globs that match nothing to the "no files" warning; and playback order and speed.
- **The view.** Component tests in the style of the existing graph view tests: the switch is remembered per project, 2D/3D stays separate, a missing map shows the empty state with Map this repo, an invalid map shows the problem list, and a request to go to a node is still consumed while the system map is up.
- **CLI verb.** Covered in the existing canvas-control core and shim tests: argv to body, the text output, a path-to-part lookup, the no-map error.
- **Core reader.** Handler tests like the ship-config handler tests: the read goes through the owning core, lease expiry stops polling, and the last-commit lookup works.

## Out of Scope

- An import or dependency graph generated by parsing source (the repo's own code-map script stays a docs tool).
- A sub-switch between a system map and a code graph inside the System map picture.
- DisTerm generating, repairing or rewriting a map by itself.
- The prose "how it works end to end" panel under the map; that belongs in the repo's docs.
- Editing the map in the UI (dragging parts, drawing links).
- Hand-placed positions in the file; layout is automatic.
- Traced flows from runtime telemetry; flows are what the agent wrote.
- The mobile companion.

## Further Notes

- The look follows the "SIEM Flow Atlas" mock from the design discussion (dark, columns, flow sidebar with counts, player under the map, legend on the right). That mock had its own "System map / Code graph" switch; only the system map half is in scope here.
- Settled in a design interview. Its two main corrections: the map can't live under `.nodeterm/` because that folder is gitignored, and live highlighting needs a new event because the graph wire deliberately carries no tool arguments.
- The reference doc for the agent graph gains a section on the system map's invariants (no paths on the wire, read-only file, layout keyed on structure), and the codemap gets a row for it.
