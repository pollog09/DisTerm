# The system map (`docs/system-map.json`)

The graph view (the graph button on the active project's tab, or **Agent graph** in ⌘K) has two
pictures, switched in its header: **Agents** (your sessions, see `docs/ship-graph.md`) and **System map**.
The system map shows how the repo is built: its callers, services, stores, workers and outside services,
the links between them, and flows you can play step by step. It is not generated from the code: an agent
reads the code and writes the file, you review and commit it, and DisTerm only reads it.

## Getting one

With no `docs/system-map.json` in the project's folder, the System map picture offers **Map this repo**.
It opens a Claude session on the canvas with a prompt to write the file, so you can watch it work. The
prompt tells it to write only what it has verified in the code and not to commit. Any agent can write the
file by hand too; agents with the canvas skill know the format, and `nodeterm map` checks it.

## The format

The skill text agents get prints the same lines:

```
  { "version": 1, "title": "<repo name>",
    "parts": [{ "id": "api", "label": "API", "subtitle": "Go API :8080", "kind": "service", "files": ["cmd/api/**", "internal/api/**"] }],
    "links": [{ "from": "web", "to": "api", "label": "REST" }],
    "flows": [{ "id": "login", "name": "Log in", "group": "Auth", "steps": [{ "from": "web", "to": "api", "label": "POST /login" }, { "from": "api", "to": "db", "label": "check the password", "mark": "guard" }] }] }
  kind is caller, service, store, worker or external (outside the repo; its files are usually []). mark is guard or refusal.
  Ids are letters, digits, `.`, `_` and `-`, 64 at most. files are globs from the repo root: `*` inside a name, `**` across folders,
  `?` one character; a path with no wildcard covers itself and everything under it. No `{}`, `[]` or `!`.
  At most 3 `*` in one name and 4 `**` in one glob. The first part whose globs match a file owns it, so list more specific parts first.
```

- `version` is `1`. `title` is required (120 characters at most).
- `parts` (1 to 200): `id`, `label` (80), optional `subtitle` (80), `kind`, `files` (required, may be
  empty; 50 globs at most, 200 characters each, 2000 globs in the whole map). A name (one segment of a
  glob) holds at most 3 `*`, and a glob at most 4 `**` segments; a run of `**/**` counts as one, and so
  does `**` inside a name. Parts are drawn in columns by kind, left to right:
  caller, service, store, worker, external. Within a column they keep the file's order.
- `links` (optional, up to 1000): `from`, `to`, optional `label` (80). A link to itself or a repeat is a
  problem.
- `flows` (optional, up to 200): `id`, `name` (80), `group` (60), `steps` (1 to 100 each, 2000 in all):
  `from`, `to`, `label` (160), optional `mark`. A step between parts with no link draws a faint line,
  marked in the legend as drawn for a flow step only.
- The file is at most 1 MiB. Unknown keys are ignored.

A map with any problem is not drawn. The view lists the problems (the first 50, then how many more) and
reloads when the file changes.

## What it shows

- **No files**: a part whose globs match none of the repo's files (tracked and untracked, ignoring what
  git ignores). In a folder that is not a git repository, or one with more than 50 000 files, parts are
  not checked and the side panel says so. The same happens when the map's globs are too costly to check
  against the files: globs are matched with a step budget, and a check that runs out says so instead of
  flagging anything. A path longer than 4096 characters matches no glob. A glob is checked only against
  files under its leading folders, so `src/api/**` costs little however many parts there are. A glob that
  starts with `*` or `**`, or has a wildcard right under a folder most files share (`src/**/*.x`), is
  tested against all those files: use few of them in a large repo.
- **Live parts**: while the System map picture is open, a part lights up when a Claude session of this
  project edits a file it owns (`Edit` and `Write`), for 20 minutes after the edit. Hover a part to see who.
  Only the part is recorded, never the file's path. Edits nobody's part owns are counted in the side panel.
  Edits made while no one is looking at the map are not recorded.
- **Flows**: pick one in the sidebar, or **Everything at once**, and it plays step by step, once. The player
  under the map steps back and forward and changes speed (0.5x, 1x, 2x). **What is moving** names each
  step and its mark: a guard, or a refusal.
- **2D and 3D** follow the graph view's own choice. In 3D the columns recede in depth.
- **The header** names the map and the last commit that changed the file, or says it is not committed yet.

The view re-reads the file every 5 s locally (a commit alone shows within a minute) and every 20 s over SSH.

## `nodeterm map`

Agents in a DisTerm session can run `nodeterm map` to print the map as text, or `nodeterm map <file>`
(`--path <file>`) to name the part that owns a file. It reads only the caller's own project, and answers
`map-missing`, `map-invalid` (with the problems), `map-path-outside`, `map-too-complex` (the lookup ran
out of its budget: simplify the globs), `map-unavailable` or
`map-no-project` when it cannot.

## Where it works

Desktop: local and SSH projects (an SSH project is read on its host while connected). Server Edition:
local projects; an SSH project there says it cannot be read. A relay Viewer, Commenter or invited guest
cannot read the map.
