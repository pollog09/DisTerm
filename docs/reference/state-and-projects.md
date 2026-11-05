# State, projects and durable orchestration state

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## State & persistence model

**React Flow is the single live source of truth** for nodes. There is intentionally no
separate store mirroring node state — earlier dual-source designs caused sync bugs.
`src/renderer/state/workspace.ts` holds only pure helpers: the color palette, the node
factories (`createTerminalNode`, `createSshTerminalNode`, `createAgentNode(agentId, …)`,
`createAccountLoginNode`, `createStickyNode`, `createGroupNode`, `createEditorNode`,
`createDiffNode`, `createVideoNode`, `createWebNode`, `createBrowserNode`, `createFilesNode`,
`createDinoNode`, `createTriggerNode`), the
group transforms (`groupSelectedNodes`, `ungroupNodes`, `duplicateNode`), and the
`nodeStatesToFlow` / `flowToNodeStates` serializers. Node kinds (`NodeKind` in
`src/shared/types.ts`): `terminal | sticky | group | editor | diff | video | web | browser |
files | subagent | loop | dino | trigger | simulator | whiteboard` — `subagent` and `loop` are render-only (ephemeral hook-driven
viz) and never persisted. `trigger` (issue #493, all four
phases landed) is a first-class PERSISTED kind. The whole host-side
machine is composed ONCE in `core/trigger-service.ts` (`startTriggerService`) and booted
identically by BOTH shells: `core/trigger-scheduler.ts` (sweep-service shape, no catch-up for
missed slots, cron via the dependency-free `@shared/cron` with the vixie dom/dow OR rule) decides
WHEN, and `core/trigger-delivery.ts` decides WHETHER — the `sendText` paste path, an agent target
only on a mirror-verified idle `done` (busy/blocked/unknown → the messaging `DeliveryQueue`, own
instance, flushed by the mirror's `done` edge via `onNodeStateChange`, with FULL flush-time
re-validation: a trigger disarmed or spec-edited while queued is dropped), a plain-terminal target
only into a SHELL pane and never queued, a dead target an honest `missed` and never a cold start.
Fire-time `TriggerArmStore.isArmed` re-ask everywhere; every rule test-pinned. The kind's spec: its spec (`CanvasNodeState.trigger`,
@shared/trigger) is git-shared CONTENT sanitized as hostile input on every load path
(`sanitizeNodeTriggers`), and the definition alone never fires — execution consent is the
machine-local, content-bound `core/trigger-arm-store.ts` (a spec that arrives or CHANGES via git
reads as disarmed until armed on this machine). A node's `data`
carries `title, color, group, tags, collapsed, expandedHeight, shell, cwd, text,
initialCommand, filePath, diffStaged`, `icon` (a user-chosen emoji, glyph or picture — see **Node icons**
below), `agentId` (which agent CLI a terminal node runs —
persisted), and `accountId` (which managed Claude account a terminal node runs under — resolved
at creation, changed ONLY by the explicit account-switch actions, persisted; see **Managed Claude accounts**). `nodeStatesToFlow` defaults a
missing `kind` to `terminal` for backward compat and migrates the legacy `tags:['claude']` marker
to `data.agentId = 'claude'`. The SDK **chat node** was removed (2026-07); `nodeStatesToFlow` also
migrates a persisted `chat` node into a **sticky tombstone** in place, reading its legacy
`chatSessionId` to print a `claude --resume <id>` hint (a chat is an ordinary resumable Claude
session).

Persistence has two layers:

- **Layout + config**: schema v3. `workspace.json` (in `app.getPath('userData')`) is now an
  **index**: local folder projects are refs to `<cwd>/.nodeterm/project.json` (the source of
  truth — git-shareable, machine-portable; pretty-printed, portable `./` node cwds, monotonic
  `rev`), SSH projects are refs to the same file on the server (offline `cache` in the index,
  reconciled by rev on connect, mirrored via `SshFs` with a 5 s write throttle), and cwd-less
  canvases are refs to `userData/inline-projects/<id>.json`. **Every entry is a ref — one shape,
  three kinds:**

  | kind | source of truth for the CONTENT | what the index entry carries |
  |---|---|---|
  | folder-ref | `<cwd>/.nodeterm/project.json` (git-shared) | `cwd` + header + machine-local half |
  | ssh-ref | the same file on the host | `ssh` + header + `cache` (offline copy, rev-reconciled) |
  | local-data-ref | `userData/inline-projects/<id>.json` | `dataFile` + header + `project` (cache) |
  | folder-data-ref | `userData/inline-projects/<id>.json` | `cwd` + `dataFile` + header + `project` (cache, stored WITHOUT `cwd`) |

  **The folder-data-ref (issue #1145)** is a folder project whose canvas is kept in app data
  (`Project.storeInAppData`) so that nothing is written into the folder — for client repos and
  folders the user does not own. It is a local-data ref with a working directory: the file and the
  cache hold the project without `cwd` (node cwds stay absolute), so the inline load and write paths
  serve it unchanged and the entry adds the folder back. Three rules keep the promise:
  `folderFileCwd(e)`, not `e.cwd`, decides every read or write of `<cwd>/.nodeterm/project.json`
  (watcher, content authority, the phone writers, settings); a missing data file falls back to the
  cache and then to a grey placeholder, **never** to the folder branch (that would adopt a stale or
  a teammate's canvas); and the cache's missing `cwd` is the downgrade contract — an older build
  opens it as a plain inline canvas instead of writing a fresh file into the folder. Its side files
  follow it: settings.json and the board log under `userData/project-files/<id>/.nodeterm/`
  (`appDataProjectRoot`; settings still load as `'shared'`; removed with the project when it is
  deleted, kept when it moves back into its folder), whiteboards in the same root
  (`whiteboardLocationForProject`; the folder's boards, drawn before the move, are read after it and
  never written, and a move back copies the app-data boards over the folder's older files —
  `carryWhiteboards` in `prepareFolderStorage`; not the shared `userData/whiteboards`, which is
  keyed by node id, and two folders holding one committed canvas share node ids), canvas images to
  the existing `userData/canvas-images` fallback (`sideFilesFolderForProject`). `localCwdForProject` still answers
  the folder, because it means where terminals run and what a relay seat is jailed to. Moving
  between the two is the tab menu's "Store canvas in app data / in folder"
  (`lib/projectStorageMove.ts`): into app data = save, then `releaseFolderFiles` (refused until the
  data file holds the canvas; files git tracks are kept unless the user confirms); into the folder =
  `prepareFolderStorage` (refuses an occupied folder, like "Set folder…"), then save, then
  `projectStorage` (where the store has the canvas now). New folder projects follow
  `settings.newProjectStorage`; a folder that already has a project.json is adopted as it is, in its
  folder. Rules the moves rest on:
  - **The data file goes only when THIS save wrote the folder file** (`sweepRemovedDataFiles`'
    `folderFilesWritten`), never because `lastWritten` remembers one: a file can leave the folder
    behind the store's back (`git rm`, a branch checkout) while the record stays, an unchanged
    canvas then skipped the write as "unchanged", and the sweep deleted the only copy. For the same
    reason the record of a folder file is dropped when its project moves into app data (kept file
    or not) and when an entry takes a folder over from a data file ("Set folder…", a move back).
  - **A move into the folder whose folder write fails stays in app data, index included**: the
    folder leg swallows a failed write, so the save keeps that entry a folder-data-ref for that save
    (`appDataCanvas`, the one builder of its cache). The menu reads `projectStorage` after the save,
    puts the flag back and says the move failed; it never reads a landed save as a landed move.
  - The rev continues across a move (the sweep keeps it for an id that is still live).

  **Known limits:** an older build that opens a folder-data-ref while a folder `project.json` is
  still there (a tracked file the user kept) keys its watcher, its phone writer and `readLocalRef`
  on the entry's `cwd`, so until it next saves its index it can adopt that file as the project
  (after which the entry is a plain folder ref there and the data file is orphaned). Images and a
  board log stay on the side they were written on when a project moves, in either direction; so do
  a folder's whiteboard files after a move into app data (read, never removed). A board edited in
  app data replaces the folder's file on the move back, including a teammate's newer version of a
  tracked board pulled in the meantime (git still has it).
  Handoff files from Transfer still write `<node cwd>/.nodeterm/`. The iOS app does not know the
  kind: over direct SSH it reads the entry's `project` cache, which has no `cwd`, so it shows a
  project without a folder (it never reads or writes the folder file, and its board and label
  writers refuse with no write path; the relay verbs are handled here), and its repo scan finds no
  `project.json` in that folder, so it can offer the folder as a new project and write one there.
  SSH projects and Server `team bootstrap` cannot use the kind.

  In all three the file carries CONTENT and the entry carries the machine-local half — project
  `id`, `viewport`, `defaultAccountId`, `breadcrumbs`, `closedSessions`, `localApprovalId`,
  `localExec`, `localSettings` (the #510 rule). The renderer contract is untouched: `workspace.load()/save()` still
  speak an assembled v2-shaped `Workspace`; all fan-out lives in `core/workspace-store.ts` +
  pure `core/workspace-files.ts`. v2 files migrate on first save (backup `workspace.v2.bak`,
  one-time renderer note). Outside edits (git pull/sync) are detected by
  `core/workspace-watcher.ts` → silent reload, or a Reload/Keep-mine conflict bar when dirty; they
  ride `workspace:external-change`, and so do the phone's `appendRemoteNode` and the SSH
  reconcile, which really are "another device". The exception is a project a hosted Server Edition
  shares with its team: the canvas authority adopts that outside edit and publishes it as
  `canvas:mut` ops, with no `workspace:external-change`, then sends the persisted project on
  `workspace:server-change` so its non-content fields (name, permission default, capability flags…)
  reach the tabs too (see **Hosted team relay**).
  **A write this core made ITSELF rides `workspace:server-change` instead** — today that is Server
  Edition headless canvas control (`server/canvas-control.ts`) — and the renderer three-way merges
  it against the store baseline (`renderer/lib/serverChange.ts`: incoming nodes adopted silently,
  ropes/bridges merged by id with server-added installed, server-removed dropped, local unsaved
  edits kept, dangling edges pruned), never a bar and never a reload. It used to share the
  outside-edit channel and that was a data-loss path, not a cosmetic one: `decideExternalChange`
  compares the project shell, `ropes` included, so the one `ctrl-…` rope an `open-agent` appends
  read as a conflict whenever the canvas was dirty — which it is throughout a spawn burst (the
  paired `canvas:mut` marks it, spawns land 60–140 ms apart inside the 800 ms autosave debounce,
  and **the bar itself suspends autosave**, so once raised it stayed raised). Answering "Keep my
  version" then wrote the browser's edge state over the file, dropping the ropes the server had
  just persisted and resurrecting cards it had removed.
  Unreadable refs render as greyed **unavailable** tabs (never dropped); corrupt project files
  are set aside as `project.json.corrupt-<ts>`. "Open folder…" adopts an existing
  `.nodeterm/project.json` — the probe MINTS the project id (node ids — tmux names — kept), and
  re-opening the folder is answered by the cwd lookup, not a second adoption.
  **A cwd-less canvas is a supported, first-class project, not a degraded one** — "New project" on
  the welcome screen creates exactly that, and it survives a restart intact. It is the correct
  fallback layer and `localStorage` is not: `userData` is backed up with the app's data,
  atomic-written, and one store for all three shells, while localStorage is renderer-origin state
  the Server Edition would shard per browser profile.
  **What it used to lack was a SECOND copy, and that is what `local-data-ref` fixes.** A folder
  project's canvas also lives in `<cwd>/.nodeterm/project.json`, so a corrupt or clobbered index
  costs it nothing; an inline canvas existed ONLY inside the index — one file, last-writer-wins, so
  a second instance sharing that `userData` erased canvases that existed nowhere else, and a corrupt
  index left them only inside the `workspace.json.corrupt-<ts>` sideline with no UI path back.
  Each now has its own atomically written file, and the entry's `project` field is kept beside it as
  a **cache** — the dual-write that (a) lets a build older than this one still read the canvas out
  of the index (the downgrade contract, ONE release; the iOS SSH-browse path cats `workspace.json`
  directly and depends on it too) and (b) answers when the data file is missing or corrupt.
  The file wins whenever it reads. Rules that make this safe, all in `WorkspaceStore.writeDataFile`:
  an unchanged candidate is not written at all; **a lower `rev` may not overwrite a higher one** (a
  second instance wrote it after we looked — its canvas stands, the next load here adopts it, and
  there is deliberately NO merge: the guarantee is "two instances cannot erase each other", not
  "two instances stay in sync"); an empty candidate never overwrites a populated file this store has
  not read. A corrupt data file is set aside as `.corrupt-<ts>` like any other project file, and the
  sweep that deletes a removed project's file only ever touches ids THIS store had loaded — a file
  belonging to another instance is never deleted, at the price of some litter after a re-key.
  `userData/inline-projects` is deliberately NOT watched (`workspace-watcher` covers folder refs
  only): nothing external edits it — no git pull, no teammate — and the rev rule is the whole
  concurrency story. The corrupt-index note still matters and must stay honest; it used to promise
  "No project data was lost — each project's canvas is still in its own folder", which was true for
  refs and false for exactly the projects that had just vanished.
  **Binding a folder to an existing project is a WRITE, so probe before you bind.** "Set folder…"
  (tab ⌄) promotes an inline canvas to a ref, and the next autosave writes that folder's
  `project.json` — over whatever was already there. It used to bind unconditionally, so pointing a
  scratch project at a repo whose canvas a teammate had committed replaced it (rev 40 → rev 1, their
  nodes gone, no sideline copy, nothing on screen). The two entrances to "attach a folder" now agree:
  `openOrAdoptFolder` probes and ADOPTS, and `setProjectFolder` runs the pure
  `renderer/lib/setProjectFolder.ts` — an occupied OR unreadable `project.json` refuses the bind with
  its reason (a failed read is never evidence of absence, #385), and a folder another project already
  owns routes to that project, REOPENING it when it is closed rather than switching to a hidden tab.
  The store's own "never blind-write" guard does not cover this: it only refuses an EMPTY candidate
  over a populated file, and this candidate has nodes.
  **Features that need a folder degrade explicitly, never silently.** Explorer, Source Control and
  Project Settings already say so in words; the add menus now do too — "New file…" and "New
  worktree…" stay in the list DISABLED with `NEW_FILE_NO_CWD_HINT` / `WORKTREE_NO_CWD_HINT`
  (`lib/addMenuSpec`) instead of vanishing, and `openWorktreeDialog` refuses a cwd-less project at
  the same choke point it refuses an SSH one (the palette has no disabled state). The worktree
  dialog's "This project is not a git repository." was the wrong cause for a project that has no
  folder to be a repository at all.
  **An `unavailable` placeholder used to be a DEAD END** (issue #385): a save deliberately emits a
  header-only ref for it and never a file, so a `project.json` the user deleted was never
  recreated, every later load re-minted the placeholder, and nothing cleared the flag for a LOCAL
  project (`reopenProject` clears only `closed`; the sole `setProjectUnavailable(id,false)` caller
  is the relay reconnect). The tab went inert (`tabClickAction` → `'ignore'`) while the sessions
  sidebar — which has no concept of `unavailable` — still switched to it. An explicit "Open
  folder…" now breaks the loop, but only on EVIDENCE: `WorkspaceStore.projectFileState` reports
  `present | absent | unreadable` and **only a definite ENOENT counts as absence**, because
  clearing the flag lets the next save write the placeholder's empty canvas over whatever is
  there. Absent ⇒ clear; present ⇒ re-probe and rehydrate under the EXISTING entry id (a corrupt
  file stats fine, so a null probe keeps the placeholder); unreadable ⇒ change nothing. The
  decision is the pure `unavailableRecovery` (`renderer/lib/projectOpen.ts`), and it refuses to
  judge a REMOTE project from a local stat.
  **The shared file carries content, not identity**: no project `id`, no `viewport`, no
  `defaultAccountId` — those are machine-local and ride the index entry (`IndexEntryV3`), beside
  `localApprovalId`/`localExec`. Two folders holding the same committed canvas (worktree, branch
  checkout) are two independent projects, and the committed file is byte-identical on every
  machine. The file still carries a machine-INDEPENDENT legacy `id` (`legacyFileId`, derived from
  the canvas name) for one release, because a pre-change build sidelines an id-less file to
  `.corrupt-<ts>` inside the user's repo; it is ignored on read. Residual: node ids are still
  shared, so two worktrees still attach the same tmux sessions.
  **SSH mirror safety** (the ".nodeterm reset itself" bug — 12 fresh project ids and 45 orphaned
  tmux sessions in one field report): remote writes are atomic (`cat > f.tmp && mv`, `sshWriteArgs`);
  a mirror is never blind-written before the entry has read-compared the server file once
  (`WorkspaceStore.reconcileSsh` — the single decider; a checked read's `error` ≠ `absent`, and on
  error it decides NOTHING); cross-lineage conflicts (re-added folder, second machine, git checkout:
  the server file carries a different project id) are settled by content, not rev alone — an empty
  side never beats a populated one, adoption re-keys the file to the local project id (node ids =
  tmux session names are kept so terminals reattach), and a push outbids the losing lineage's rev;
  a throttled trailing write that drops after its optimistic ack re-owes the mirror
  (`markUnmirrored`); pending mirrors are flushed before the ControlMasters die at quit; and the
  SSH dialog **dedupes by endpoint+remoteCwd** (`openSshProject`, same contract as
  `openFolderProject`) instead of minting a fresh empty project for a folder that already has one.
  **The reconciler also recognizes its own writes** (the SSH twin of the watcher's `isSelfWrite`):
  the 15 s poll and the connect-time refresh read the very file the mirror writes, so
  `recentMirrorHashes` remembers the last few payloads handed to `remoteIO.write` and a read that
  returns those exact bytes decides "nothing new" — never an adopt/broadcast (which raised the
  Reload/Keep-mine conflict bar over the store's own autosave), and never a rescue of an OLDER own
  write still sitting under the 5 s throttle (which resurrected just-deleted nodes). Exact bytes
  only, so a phone append or another machine's save still reads as external. And
  `refreshSshProject` runs ON `saveChain`: off the chain a poll snapshotting the pre-save entry
  could complete its slow ssh read after the save's mirror landed and "adopt" the store's own
  write on rev alone.
  **A write ACK is not evidence about the server's CONTENT — only a read is** (2026-09-06 field
  report: 16 terminals deleted on an SSH project came straight back, announced as sessions
  registered from a phone the reporter does not own). `clearedNodes` is the tombstone set that
  tells the mirror's re-read "we deleted this, do not rescue it back", and it used to be dropped
  the moment `remoteIO.write` returned true. That ack is **optimistic for the 5 s throttle's
  trailing write** (`makeRemoteWorkspaceIO` returns true and schedules the run) — so when the
  connection died inside the window, `markUnmirrored` re-owed the mirror (`unmirrored.add`) while
  the tombstones were already gone, and the retry's re-read found every just-deleted node still on
  the server with nothing left to filter with: `rescueRemoteNodes` merged all 16 back into the
  cache, bumped the rev and broadcast them as an external change. The asymmetry was in one place —
  `unmirrored` was restored, `clearedNodes` was not. A tombstone is now retired ONLY by
  `confirmClearedDeletions`: a read that no longer lists the id (taken from reads the store already
  makes — the mirror's own re-read and `reconcileSsh` — so it costs no round-trip), or an adopt,
  which overrules our deletions outright. **Both** read sites must call it; wiring one leaves the
  other's tombstones alive for the whole run. The cost is that GC lags a landed write by one read,
  which only prolongs the suppression of a rescue we do not want; the benefit is that the rule no
  longer depends on a dropped write being REPORTED. Symmetrically restoring the set inside
  `markUnmirrored` was the smaller diff and was rejected: it needs the same shadow state anyway,
  and it only closes the one failure path that happens to report back. The set is runtime-only,
  bounded by the ids deleted this run, and pruned for projects that leave the index.
  **Neither surface may name a device for an adopted node** (`adoptedClause`,
  `renderer/lib/externalChange.ts`): nothing at that layer knows the source — a stale own mirror
  and a phone append are indistinguishable there — so the copy names the project FILE and offers
  the possibilities without asserting one.
- **Live terminal sessions** (tmux): terminals continue where they left off across node
  remounts *and* full app restarts, including running processes. See below.

**Autosave does no unchanged work** (`WorkspaceStore.save`): the parse of each `lastWritten` value is cached per raw string, and `workspace.json` is not rewritten when its bytes equal the store's last write AND the file still has the size+mtime+inode that write left — so another instance's rewrite is still answered (the inode catches a same-size rewrite on a coarse-mtime filesystem: every writer publishes by rename), a store's first save and a v2 migration always write, and every other index writer of ours clears the record.

`settings.json` is a separate store (`core/settings-store.ts`, `state/settings.ts`).

## Projects (tabs)

Each project is one canvas/page; terminals and notes belong to a project. The `projects`
zustand store (`renderer/state/projects.ts`) holds project metadata + the *serialized* nodes
of all projects. **React Flow remains the single live source of truth for the *active*
project's nodes only.** The contract:

- The active-project effect in `Canvas.tsx` (keyed on `activeProjectId`) loads that project's
  serialized nodes into React Flow. `loadingRef` suppresses dirty-marking during this load.
  A real switch applies the project's saved viewport; an **in-place reload**
  (`reloadActiveProject` — external file change / SSH reconcile) sets `preserveViewportRef` so
  the load **keeps the user's current camera** — the incoming file's viewport is wherever
  another machine last saved, and restoring it mid-work teleported the camera (most visibly
  right after a cross-project sidebar focus, when the connect-time SSH reconcile landed a
  second after fitView centered the node).
- **Project order = array order**, and it is ONE order shared by the tab bar and the sessions
  sidebar (the sidebar no longer hoists the active project to the top). Both surfaces reorder
  via drag-drop through `reorderProject(draggedId, beforeId|null)` (null = to the end; tab
  strip empty area and sidebar body are the end-drop zones), persisted like any node reorder.
  Sidebar disclosure is **persisted**, for group frames as well as projects:
  `settings.sidebarCollapsedItems` maps `project:<id>` / `project:<id>:group:<groupId>` → collapsed
  (`isGroupCollapsed`), and `settings.sidebarAutoCollapse` (default on) now only supplies the
  DEFAULT for a project row nobody has toggled (on = active expanded / others collapsed, off =
  everything expanded). **This deliberately replaced the old "a project switch resets every manual
  toggle" effect** (2026-08, with the nested sidebar tree): a tree the user shaped by hand should
  still be that shape after a restart, and one transient rule for projects plus a sticky one for
  frames would have been two contracts in one list. `projectHeadClickAction` is unchanged — an
  inactive project row switches, the active one toggles its own (now persisted) collapse — and
  every write **prunes** keys that no longer address a live project/frame (`pruneCollapsedItems` /
  `liveCollapseKeys`), because settings.json is forever and a canvas churns through group ids.
- The bottom-left **canvas lock** freezes the CAMERA only (pan/zoom): nodes stay draggable,
  resizable and connectable while locked — the point is "stop the map sliding", not "freeze
  the work". It is **transient by default and opt-in to remember**: a lock that survives a
  restart reads as "the app is frozen" to whoever opens the app next, and the lit button is a
  small thing to spot, so `settings.rememberCanvasLock` (Behavior, default OFF) is what turns it
  into a preference. The bit itself lives in localStorage (`nodeterm.canvasLocked`,
  `renderer/lib/canvasLock.ts`) beside the view mode and the explorer pin, never in settings.json
  and never in the git-shared `project.json`: the SETTING says whether to remember, the lock is
  one person's view state. Note the two tiers differ per surface: on Desktop both are
  machine-local, but in the **Server Edition** the setting rides that server's settings.json
  (shared by every browser hitting it) while the bit is per browser PROFILE, so two profiles can
  legitimately disagree about the lock. Desktop + Server Edition; **Mobile: N/A** (no canvas).
  **The lock covers middle-drag on NODES too, and ⌘/Ctrl+middle-drag gets past it** (issue
  #1130, `renderer/lib/modifierPan.ts`). React Flow's zoom filter accepts a middle-button
  `mousedown` on a node / edge / selection before it reads `panOnDrag`, so turning `panOnDrag` off
  never stopped a middle-drag that started on a node header or a terminal's hover guard (the xterm
  itself was only safe by accident, via the #84 middle-click guard). While locked,
  `installLockedMiddleGuard` stops a middle `mousedown` in the BUBBLE phase on
  `.react-flow__viewport` — after the node (tmux, the middle-click paste setting) has seen it, before
  React Flow's listener on an ancestor. `installModifierPan` is the deliberate way past the lock:
  ⌘+middle-drag (Ctrl off-mac) pans anywhere, locked or not, by cancelling the pointerdown in the
  capture phase on the flow wrapper (so no `mousedown` reaches d3, d3-drag or xterm). The
  `canvas.toggleLock` command ships UNBOUND (⌘⇧L is the sessions sidebar's) and, like every canvas
  command, does not fire while a terminal has the keyboard.
  It is one GLOBAL bit rather than per-project
  because `<Canvas />` is mounted once and is not keyed by project, so the lock always carried
  across project switches within a session. Restore is gated on settings HYDRATION (Canvas mounts
  first, so a `useState` initializer would read the default and the opt-in would silently never
  work) and latched to the first run, so switching the setting on mid-session never reaches into
  storage and locks a canvas somebody is working on.
- Before any project switch / add / delete, `commitActiveToStore()` serializes the live
  React Flow nodes back into the store, so nothing is lost. Then disk is written. The commit is
  guarded by the epoch tag `nodesProjectIdRef` (`canCommitCanvas`), and **that tag must live in
  React STATE beside the nodes** (`canvas/nodesEpoch.ts`), never in a ref alone: the load effect's
  `setNodes(flow)` is a DefaultLane update, every zustand write after it is a SyncLane re-render
  that skips it, and the render-time `nodesRef` mirror then paired the PREVIOUS project's nodes
  with the NEW project's tag. A commit in that window wrote an SSH project's 7 nodes over a local
  project's 18 in its `.nodeterm/project.json` (2026-09-26). `nodesEpoch.test.tsx` reproduces the
  interleaving with real React (no `act`, which would flush both lanes together and hide it).
  **The refs are the LATEST pair, not the last rendered one**: the tag ref is written only by
  `installEpoch`, and a render copies its `nodes` into `nodesRef` only when that state CHANGED and
  the render belongs to the installed epoch. An unconditional mirror rewound both refs to the
  outgoing project in that window, and a peer's `canvas:mut` for the incoming (active) project was
  applied to the outgoing nodes and queued after the load — the canvas ended on A's nodes plus the
  op, tagged B, and the next commit wrote them into B. So the receive path routes by
  `liveCanvasHolds` (tag AND active id; otherwise the store) and queues a FUNCTIONAL update
  (`rebaseOnLatest`). Consequence for readers: code pairing the tag with the RENDERED `nodes`
  (a render-time publish, an effect keyed on `nodes`) reads `renderedProjectId`, never the ref.
- **The node subtree's session follows the project whose nodes React Flow's STORE holds**
  (`useFlowStoreOwner`, `canvas/flowStoreOwner.ts`), never `activeProjectId`. xyflow copies the
  `nodes` prop into its store in a PASSIVE effect and `ReactFlowProvider` sits above the keyed
  `SessionProvider`, so a key that flipped with the active id remounted the OUTGOING project's
  nodes under the INCOMING session for a commit: a team tab's terminals were created on this
  desktop's own core, and a local terminal on the relay host. Each array handed to
  `<ReactFlow nodes>` is recorded against `renderedProjectId` and the store's array is looked up
  (unknown ⇒ the last known owner); the same id feeds `OwningProjectContext`. A local → local
  switch keeps the key `'local'` (no remount). A session-changing remount now lands one commit
  AFTER the load applied the project's camera and builds a fresh pan/zoom, so `<ReactFlow>` gets
  `defaultViewport={viewportRef.current}`, or the switch resets the camera to the origin. For the
  same reason the load's settle timer must not frame or read the incoming nodes itself: the
  pending focus / "Open recent" resume / `nodeterm://` link it finishes run through
  `useFlowLanding` (`canvas/flowLanding.ts`) once the owner IS that project — React may run the
  store copy's passive effect after a due timer, which then framed the pan/zoom the remount
  destroys and read the outgoing copy of a shared node id. The rule holds for a local → local
  switch too (no remount, but the owner still flips). A caller that would create and frame AT ONCE
  (`resumeWhenLanded`, `runLinkOpen`) must also ask `flowLanding.holds(projectId)`, never the epoch
  tag alone: after "Open folder & resume" or a link that opens a new folder, the switch is the
  folder open's last synchronous step, so the `.then` runs after the load effect installed the tag
  and before the store copy — every time, not by chance. Otherwise it leaves the work in
  `pendingResumeRef` / `pendingLinkRef` for the landing. A throw inside a landing is logged, never
  rethrown: it runs in a passive effect and `<Canvas />` has no error boundary.
  `flowStoreOwner.test.tsx` replays the switches through real React Flow, the timer firing inside
  that window and the folder-open continuation included.
- **A remote project's node never starts on this core, whatever it is mounted under** (bug F: a
  team tab's terminals were created as LOCAL tmux sessions here). The node itself cannot say so: a
  project shared from SSH with a team is ADOPTED by the host (`localizeAdoptedNode` drops
  `sshRemoteTmux`/`ssh`/`sshFs`), so its nodes reach the tab as plain terminals. Do NOT re-stamp
  `sshRemoteTmux` onto them — the host's core would then refuse its own sessions (`requireRemote`
  with no master of its own: `held-elsewhere` for a live one, a refused spawn otherwise). Three
  layers besides the keying above:
  (1) `sessionForProject` resolves a REMOTE project (`remote` in the store; once the store no longer
  holds it, bound while remote in this run) with no live binding to the OFFLINE relay session
  (`OFFLINE_RELAY_SESSION_ID`, `session/offline-relay-session.ts`: `source 'relay'`, `status
  'offline'`), never the local one.
  Its core-bound calls (pty, fs, git, workspace, …) reject, so no terminal can be created here; it
  is not a wall around this machine, since its api spreads `...local` like a live relay tab's (the
  local namespaces — contextLink, transcripts, handoff, media — still act here, and its `boardLog`
  read answers `unsupported`). "Is this project remote?" is ONE predicate, `isRemoteProjectId`
  (session.ts), shared by this resolution and the spawn refusal in (3). Lifecycle code asking "which
  session is bound to this tab?" (dispose it, reconnect it) asks `boundSessionForProject`, which
  never answers the sentinel.
  (2) A surface that mounts a project's node OUTSIDE Canvas's node subtree runs under that project's
  session. Both kanban boards render under App's LOCAL provider, so each mounts its card modal
  through `ProjectSessionScope` (`session/owning-project.ts`: `sessionForProject(<card's project>)`,
  keyed by session id, plus `OwningProjectContext`). Before it, opening a team tab's terminal card
  created the host's node id on this desktop every time. The terminal, the comments, the metadata
  strip and the pull-request panel now act on the card's project (`useOwningProjectId() ??
  activeProjectId`): the terminal runs under the card project's session, the comments panel reads
  and writes that project's board log, the metadata strip's member pool reads it, and the
  pull-request panel reads that project's pull requests, SSH flag and auto-move target. On the Omni
  board a lane is not the active project: pairing the lane's api with the active id blanked a relay
  lane's comments and saved new ones nowhere, and on a local lane filed them into the ACTIVE
  project's board log. A relay card's file links are switched off (`cardFileLinkRoute`) and its ⌘M
  chat is refused (`stub.chat`, `E_UNSUPPORTED`). **Known exceptions (pre-existing, follow-up):** the
  icon picker (`NodeIconPicker.chooseImage` resolves the ACTIVE project, so a team lane's card
  opened while a local project is active copies the picked image into the local project's
  `.nodeterm/images/`), and dictation and file-drop uploads in a relay card, which act on this
  machine. The session is resolved at render, so a reconnect while a modal is open takes effect at
  the board's next render.
  (3) TerminalNode and ModalTerminal ask `spawnBelongsElsewhere(isRemoteProjectId(owner),
  session.source)` (`owner` from `OwningProjectContext`; the predicate is the one (1) uses, so a tab
  the store deleted still counts) before any SSH resolve or create: a remote project under a
  non-relay session starts nothing and writes a gray "belongs to a remote project that is not
  connected here" line. ModalTerminal mirrors TerminalNode's `dialsSsh` (a relay card's SSH-project
  node is joined by the HOST with `requireRemote`; this machine dials, refuses and reports nothing
  for it), and a non-dialing node's `ownerProjectId` is the owning project, else the active one.
  `components/kanban/cardModalSession.test.tsx` renders both boards with real sessions and a probe
  in place of CardModal, asserting which session and owning project each modal mount gets, plus
  source pins for the two terminals; `components/kanban/boardLogPanelSession.test.tsx` and
  `cardOwnerProject.test.tsx` render the real comments panel, metadata strip and pull-request panel
  under a lane's `ProjectSessionScope`; `session/offline-relay-session.test.ts` replays the switches.
- Switching away unmounts the old project's `TerminalNode`s → their tmux clients detach but
  the sessions keep running; switching back reattaches. tmux session names are per-node-id
  (globally unique), so projects never collide.
- The tab caret menu's **Close project** (`closeProject`) is **non-destructive**: it sets
  `project.closed = true` (hidden from the tab bar, kept on disk with all nodes) and leaves the
  tmux sessions running, so closing just detaches like a project switch. Closed projects are
  reopenable from the **"Recently closed"** list on `WelcomeScreen` (`reopenProject` → restores
  nodes, which reattach warm or cold-restore). `hasProjects` counts only **open** projects, so
  closing the last open one shows the welcome screen. **Permanent** deletion (`deleteProject`:
  `transport.destroy(nodeId)` per terminal + drop agent status + SSH teardown) now only happens
  via the `×` on a "Recently closed" entry. **Closing now SAYS what it parks** (issue #442 —
  "close" read like cleanup while meaning "hide, and keep running"): a project with terminal
  nodes gets a confirm naming the count, with an opt-in **"end its sessions too"** checkbox
  (default OFF — parking stays the rule; checked flips the confirm to danger). The pure half is
  `renderer/lib/projectCloseSessions.ts`: **one definition of N** — the project's terminal-kind
  nodes, exactly the set the action addresses (`transport.destroy` is idempotent on a dead
  session), never a liveness-verified count that could disagree with the action; the END happens
  at confirm time against the re-resolved node set (agents spawn nodes on their own). A relay tab
  or a 0-terminal project closes silently (byte-identical old path). `endProjectSessions` mirrors
  `deleteProject`'s teardown EXCEPT it keeps agent status (the persisted sessionId is what lets a
  reopen cold-restore `--resume`) and never disconnects SSH masters (close never managed the
  connection). The `×` also confirms now, via `deleteConfirmCopy` — a relay tab gets "removes
  only this machine's view; reconnecting brings it back" with no danger styling (deleting the
  view is what turns the next connect into a first-connect re-adopt), local/SSH get the session
  count + "the folder (incl. .nodeterm/project.json) is not deleted". And "Recently closed" rows
  show a **live-session badge** (`closedSessionCounts` over ONE on-demand local
  `sessionMemory.read` per welcome-screen appearance — never a timer; `ok:false` ⇒ no badge,
  never "0"; an SSH project's host-side sessions are deliberately not claimed by the local
  count). Server Edition: all renderer-side; the ws-bridge `sessionMemory` is real, so badges
  describe the server machine; the `sshProject` legs only run for `project.ssh`, which that
  shell never has.
- **Closing a NODE keeps a pointer to its transcript** (issue #531). The per-project
  `closedSessions` ledger records the agent session id as `ClosedSessionEntry.sessionId`, captured
  at delete time from the live `agentStatus` entry — which that same delete drops, so this is the
  last instant it exists anywhere — falling back to the minted `node.agentSessionId`. It is a
  POINTER, never a copy: the `.jsonl` the agent CLI owns stays the only text, and a second store of
  transcript text would age, drift and need its own retention policy. The "Recently closed" row
  spends it on the **existing ⌘M reader** (`ChatPanel` in `readOnly` mode, hosted by
  `ClosedTranscriptDialog`), so resolution, the `{found}` vs empty distinction and Retry cannot
  drift from the live-node path. Two rules: it rides `IndexEntryV3.closedSessions` and is therefore
  **machine-local** — a session id is a `$HOME`-anchored fact about one person's machine, and
  `projectToFile` must never emit it — and it is **re-checked as a string** in
  `sanitizeLoadedClosedSessions`, because workspace.json is hand-editable and the value goes
  straight to a resolver. `closedTranscriptTarget` (pure) owns the refusals and NAMES each: a
  REMOTE session is refused (its transcript is on the host; locating it over the ControlMaster is
  separate work and must not hold the local fix hostage) and a pre-#531 entry says its id was never
  recorded. Only the "this was never an agent" refusal may render as nothing — for the others a
  vanished control would leave the user believing that closing destroyed the record, which is the
  belief this exists to correct.
- A project's `cwd` (folder picker, `dialog:select-folder`) is passed to terminal/Claude
  node factories so new terminals open there. **Folder ↔ project is deduped:** "Open folder…"
  reuses the existing project with that `cwd` (and its nodes) instead of creating a duplicate.

## Durable orchestration state (queue, station reports, hand-over holds, request ledger)

Four facts a canvas-control orchestration leans on used to live only in process memory, so an app
(or Server Edition) restart erased them while the work they described kept going: a `send` answered
`queued` vanished while its sender believed it would be delivered; every station report vanished, so
each `--after-success` dependent read BLOCKED and needed ▶ / `run`; and the `--request-id` ledger
emptied, so a retry after a restart re-ran an open that had already happened; and the plain-`--after`
hand-over hold (#1052) was forgotten, so a dependent fired on the first `done` after a restart. All
four are now
mirrored to `<userData>/orchestration-state/<kind>.json` through ONE storage module,
`core/durable-state.ts` (`DurableFactFile` + a per-fact `DurableFactSpec`), so a new fact is one more
spec, never a fourth copy of the read / sanitize / write / flush code.

- **Machine-local only** — userData, never `.nodeterm/project.json`: a queued body, a station verdict
  and a control reply are one machine's run state, and a clone must not inherit them. Written 0600
  (a queued message's body is the user's text). **Relay tabs and the phone: N/A** — the facts belong
  to the core that executes the calls; a relay tab talks to the host's core, whose files these are.
- **The file is hostile input.** Envelope `{kind, version, savedAt, records}`; an unknown kind or
  version starts empty (warned), a record the fact's sanitizer refuses is DROPPED (never repaired),
  lists are capped, and a file that is not JSON / too large (16 MB) / not an envelope is set aside as
  `<file>.corrupt` (one copy) and the fact starts EMPTY with a warning. **Loading never throws** — a
  bad orchestration file must not take the boot with it.
- **Writes** are a unique `wx` temp then `renameAtomicSync` (the fs-atomic guard applies), coalesced
  over 50 ms, one in flight, latest snapshot wins; `flushAllDurableFactsSync()` runs on the desktop's
  second `before-quit` pass, `hookServer.stop()` flushes the ledger, and the Server Edition's
  canvas-control `stop()` disposes its three files (queue, reports, holds). A **crash** inside the
  50 ms window loses that window. **A sync flush is never overwritten by an older async write**
  (review of #1054, reproduced: `save([1])`, `flush()`, `save([2])`, `flushSync()` left `[1]` on
  disk): `flushSync` bumps a generation, and the async path checks it and renames in ONE synchronous
  step, dropping its temp when stale.
- **Every owner budgets its bytes under the 16 MB load limit**, because a file past it is set aside
  WHOLE (reproduced in review: 80 queued 250K-char bodies wrote 20 MB and 0 of 80 came back). The
  queue writes full entries up to 8 MB of JSON and the rest REDUCED (no body, short fields only —
  `bodyOmitted`, which restore turns into an expiry the sender hears about); the ledger writes
  replies up to 8 MB and the rest as UNKNOWN rows (still refused, never re-run).
- **Only the instance that owns the hook endpoint owns the facts.** The ledger is loaded by
  `hookServer.start()`, which fails for a second instance; the queue, reports and holds follow the
  same rule (`standDown()` when `startForApp()` returned a warning — desktop `main/index.ts`, Server
  Edition `ownsDurableState`), so a second instance on the same userData neither expires messages
  the live one holds nor overwrites its files.
- **The desktop queue restore waits for the workspace INDEX** (`restoreDeliveryQueue(…, {ready:
  workspaceStore.load({sideline:false})})`): an entry that lapsed during the downtime is expired
  there, and its sender leg resolves the sender's project and board log through the index, which
  nothing else has loaded at that point of boot (review of #1054: the expiry otherwise reached only
  the in-memory trace ring). The Server Edition already awaited the load before canvas control.
- **Measured** (this Linux dev host, the ledger at its 4096-row cap with realistic open replies):
  377 bytes a row, a 1.5 MB file, 11.5 ms per full write, 16.6 ms to load at boot; a 20-row ledger
  writes in 0.41 ms. The queue is bounded far lower (16 per target), the reports at 1000.
- **Boot order is load-bearing** (desktop `main/index.ts` right after `initAgentStatusMirror()`;
  Server Edition inside `initServerCanvasControl`, which runs after the mirror): station reports
  first — their session check reads the restored mirror — then the hand-over holds, then the
  delivery queue, whose restore
  replays a `queued` hand-over per waiting message (so "work pending" is REBUILT from the queue, not
  stored twice) and settles, without landing, every message that lapsed while the app was down (which
  withdraws the station's report exactly like an in-run expiry).

What a restart MEANS, per fact — decided beside each fact, stated in its header:

- **Queued message** (`core/agents/delivery-queue.ts`, `QUEUE_FACT`):
  - **The TTL keeps running while the app is down** (deadline = `enqueuedAt + ttlMs`, wall clock). A
    message whose deadline passed is EXPIRED at restore — traced `expired`, the sender told through
    `onExpired` — never delivered late and never dropped in silence. The rest re-arm with the time
    they have LEFT (a clock that went backwards cannot stretch one past a full TTL).
  - **Same session only.** At enqueue the target's agent + session id are recorded from the status
    mirror (`bindingOf`). A RESTORED entry flushes only when the target's current session and agent
    are the recorded ones (`restoredBindingVerdict`): a different one — respawn, `/clear`, another
    agent in the pane — ends it `targetGone` with nothing typed; an entry with no recorded session is
    refused the same way; a target that has not named a session yet WAITS (TTL running). In-run
    entries are unchanged.
  - **The whole gate chain still runs at flush.** Consequence to know: after an app restart where tmux
    survived, pane ownership is unproven (`pane-ownership.ts` records only on a fresh spawn), so the
    first flush is refused `notPermitted` and the sender is TOLD — still strictly better than the
    silent loss it replaces. After a machine reboot the cold-restored pane is a fresh spawn, so a
    message for a session that resumed under its old id delivers. The Server Edition's creator
    ledger is process-local too, so a restored message there is refused `caller-not-owner`.
  - **Never replayed into a pane**: a board comment (only the local user, typing in THIS app, may
    trigger one — a message read back off disk must not speak as a person) and an app-composed
    station notice; both, and a body over 256 KB (written without it), are expired at restore so
    their row / sender still hears the end. Not flushed at boot: the first flush waits for the
    target's next `done`.
  - Threat model, stated: the file is as trustworthy as the per-node token files beside it — a
    same-user process can write either. A forged `send` entry still runs every gate at flush.
- **Station report** (`core/station-outcome-store.ts`, `OUTCOME_FACT`): stored with the station's
  session + agent (`sessionOf`). At load a report whose recorded session or agent differs from what
  the restored mirror now says for that node is dropped; afterwards a `SessionStart` naming a
  different session or agent withdraws it — in-run too, since a report is about a task in one
  conversation (a child's session event, `subagentType`, never counts). An unknown side keeps it. The
  withdrawal runs in `emitAgentStatus` BEFORE the renderer hears the event, so no dependent can fire
  on the stale report in between.
- **Hand-over hold** (`core/station-handover.ts`, `HANDOVER_FACT`, the plain-`--after` fact from
  #1052): the HOLDING stations are stored (`handedAt`, the current turn's start and state, the
  background flag); `queued` is rebuilt from the queue's replay. Times are wall clock, so a turn that
  began before the restart but after the hand-over still ends the hold. Hook events are lost while
  the app is down, so a turn that ended during the downtime is not seen and the hold lasts until the
  next turn end (holding direction; ▶ / `run`). Not bound to a session: a respawned station still
  owes the work it was handed. Loaded after the reports and before the queue.
- **Request ledger** (`core/control-request-ledger.ts`, `CONTROL_REQUEST_FACT`, owned by the hook
  server's route): settled rows replay; a row in flight at shutdown (or a crash) comes back UNKNOWN —
  refused, never re-run, and nothing can settle it any more because its late answer died with the
  old process; a reply over 64 KB is written as UNKNOWN rather than dropped (a missing row would let
  the retry run).
- **Delivery is at most once across a crash:** a flush writes the entry OFF disk before its
  attempt (claim before effect), so a crash mid-delivery loses that one message rather than typing
  it twice after the next boot. Lapsed entries at restore are never inserted into the live lists
  (so no flush can deliver one while the expiries are reported) and take no capacity slot.
