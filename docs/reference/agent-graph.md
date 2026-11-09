# Agent graph view

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Agent graph view and the ship process

A third per-project view beside the canvas and the board (`ProjectView` = `'graph'`): sessions as a
graph, with what passes between them and how work moved through the machine's ship process. It
observes and writes nothing to the canvas. User-facing format and limits: `docs/ship-graph.md`.

- **Where things are.** Stream and history: `core/agent-graph/` (`event-log.ts`, `handlers.ts`). Machine
  discovery: `core/ship-config/` (`discover.ts`, `sanitize.ts`, `handlers.ts`). Wire shapes:
  `shared/agent-graph.ts`, `shared/ship-config.ts`. The picture: `renderer/lib/agentGraphModel.ts`
  (pure: every counting rule), `renderer/lib/agentGraphLayout.ts` (pure: the only file that knows
  dagre), `renderer/components/graph/`. `Canvas.tsx` holds only the mount, the view flag and the
  palette row, so a merge from upstream stays cheap.
- **`isKanbanOpen` means "the canvas is covered", not "the board is up".** Its ~20 callers in
  `Canvas.tsx` all ask whether a canvas gesture would act on something nobody can see, so the graph
  answers true. The flag `kanbanOpen` is a different thing and stays board-only, so a gesture reading
  it directly has to add `graphOpen`: the image paste guard did (`canvasCoveredByView`), and an image
  pasted over the graph landed on the hidden canvas until it did. Code that means the board itself asks
  `isBoardView` (`toggleBoardView`, `openIssueOnBoard`, the palette's label). "Go to node" still asks for a card
  (`requestedCardNodeId`), and the graph consumes that request by opening the terminal in its modal;
  without that, every notification click and notch Go would read as dead over this view.
  `TerminalNode`'s board render pause and `boardCoversCanvas` read the view directly and test
  `!== 'canvas'`, so terminals under the graph stop drawing as they do under the board.
- **Its own `ReactFlowProvider`.** The canvas's store has an owner (`flowStoreOwner.ts`), read to decide
  which project a mounting node belongs to. Sharing it would feed that decision boxes from no project.
  It also mounts under `ProjectSessionScope`: Canvas's context is the LOCAL session, so a team tab's
  graph would otherwise ask this machine's core about the host's nodes.
- **Layout is keyed on structure, not content** (`agentGraphStructureKey`). Status and counts change a
  box, never its place; re-laying out on each hook event would be unreadable. A reject or re-entry is
  fed to dagre forwards and its route reversed afterwards. Left to dagre's cycle breaking (`greedy`
  measured it), the reviewer landed to the LEFT of what it reviews.
- **Re-entry means moving BACKWARDS against the order the `next` edges declare**, not "ran again" and
  not first-seen order. With "ran again", one rejection paints every forward edge of the second pass;
  with first-seen order, review, impl, docs, review paints the declared docs -> review. It is reachability
  along `next` edges (`splitNextCycle` drops an edge closing a cycle, with a warning), so a stage the file
  says nothing about is never behind anything. A real reset or a new user prompt (`turn-start`) starts a
  new run, so predecessors never cross one; `SessionStart` with `compact` or `resume` is not a reset, which
  is why the normalizer carries `sessionSource`. Inside a turn a declared move is taken as declared, and
  an undeclared last-to-first move is a new run. `docs/ship-graph.md` states this for users.
- **What these rules rest on is recorded.** `__fixtures__/claude/session-boundary-hook-payloads.json`
  holds live captures (2.1.317), and `test/acceptance/agent-graph-real-hooks.test.ts` drives them through
  the real path: `/clear` is `SessionEnd(clear)` then `SessionStart(clear)` under a NEW session id;
  `compact` and `resume` keep it; a slash command fires `UserPromptSubmit`, and an injected hand-back or
  `<task-notification>` is not a turn; SendMessage fires a second `SubagentStart` under the same agent id;
  a child's `SubagentStop` fires twice around its hand-back; side agents stop with no type. Not captured:
  a subagent open through `SessionStart(compact)` itself (it ended between `PreCompact` and that).
- **A `next` and a `reject` to the same agent are not told apart, and no run is counted for it**
  (`placeRuns`). Picking `next` always stated a passed review as fact, and a declared reject could never
  light up. Both edges read "maybe" in the warning colour, never the reject one, the run is a `maybeRuns`
  on each stage, and later runs are placed from every position it could have been until only one route
  is left. A pipeline with no such pair never reaches this case and is unaffected.
- **A run's first end stands, and a re-start is a new pass.** The tool path can report a child's end
  again after its native stop, and a rejection can resume the same `agent_id`; rewriting `endedAt` in
  either case moves the run past whatever started in between, which erased the forward edge and invented
  a false `spawned` one. The acceptance test goes through `ClaudeSubagentLifecycle`, as production does.
- **Streamed output counts as life** (`SubagentReplay.touch` to `AgentGraphLog.recordActivity`), coalesced
  and replaced per subagent, or a healthy run past 20 minutes reads "no recent signal" beside a canvas
  card that knows better.
- **`now` is only sampled on a rebuild**, and a killed subagent sends nothing, so while a run is open one
  timer waits for `nextStaleAt`. With none open there is no timer.
- **Config polling is on leases, and re-routes each tick** (`holdShipConfigLease`,
  `registerShipConfigHandlers`). A crashed renderer or a dropped relay peer sends no unsubscribe, and an
  SSH project's route changes when its master connects. Both shapes leaked real work before.
- **Arrival is a finite pulse, and needs no gate.** `pulseKey` remounts the element. Only an event newer
  than `max(mountedAt, shown2d.since)` pulses or sends a dot (`pulseOf`), so opening the view does not
  flash the past. `shown2d.since` is when 2D was last drawn again after 3D. Coming back from 3D remounts
  every box and line, and a remounted dot or pulse cannot tell an event it already played from a new one.
  The floor is set during render, not in an effect, because the boxes mount in that same render and must
  not see the old floor. The boxes and lines do fade in again on that return; their events do not replay.
- **The one loop is the direction marks, and only motion that is true may run** (`edgeInTransit`,
  `TRANSIT_WINDOW_MS` = 15 s). Every line but a context link has three chevrons (`edgeShowsDirection`).
  They move for a delivered message for 15 s after it lands, and for a used line while the run it led to
  is live (`GraphEdge.running`, by the same staleness line as a box's activity) and for 15 s after that
  run started (`GraphEdge.movedAt`). A queued, failed or refused message never moves, nor does `opened`,
  `dependency`, `context`, a declared line nothing has used, or a `maybe`: motion would state a route hooks
  cannot confirm. A move placed by a guess is the same case, on the line into the guess and the line out
  of it: it is counted, but sets neither `running` nor `movedAt`. So motion reads `movedAt` and never
  `lastEventTs`, which any event sets and which still drives the arrival pulse, so those lines do pulse.
  `running` belongs to the MOVE, not the stage reached: a stage entered twice has two lines in
  and one in use. The transit window ends with no event to say so, so `useEdgesInTransit` arms one
  timer for it (`nextTransitChangeAt`), and none while nothing is recent; a line a run holds is left to
  `nextStaleAt` and the run's own end. The marks use CSS `offset-path`, not SMIL `animateMotion`, because
  `animation-play-state` cannot pause SMIL; a negative delay starts each from its resting stop, so a line
  does not jump when it starts moving. Three per line whatever its length (`EDGE_CHEVRONS`). An observed
  loop reads `×N` instead of "went back": the marks show the direction, and with no file the words must
  not lean towards a rejection. It stays amber and keeps its hover caveat.
- **The graph takes `--nt-anim-state` back from the covered gate.** This view marks the canvas covered
  and is a `.react-flow` itself, so `:root[data-nt-canvas='covered'] .react-flow` would pause its marks for
  good while the rule reading the variable looked right. `agent-graph.css` sets it to `running` on
  `.agent-graph .react-flow`, then an idle rule of equal specificity sets it to `paused`, and the order
  of those two is what makes the window gate win. `styles.animation-gate.test.ts` pins both and scans this
  sheet. Reduce Motion gives static chevrons. The cost is under **Idle energy**.
- **The starter never replaces or shadows anything** (`core/ship-config/template.ts`,
  `createShipTemplate`, `ship-config:create-template`; the empty state's "Set up graph engineering",
  offered by the pure `lib/shipTemplate.ts`). A project agent replaces a global one of its name and a
  project routing file replaces a global one whole, so a file written over what a machine has would quietly
  change how its other work runs. It reads the machine first and refuses on a failed read: absence is
  what decides. An agent is matched by declared name AND by exact file, because the discovery listing
  stops at 100; a skill counts for the command, since it answers to the same `/name`. Any routing file
  ends the offer and keeps `ship-graph.json` (`globalGraphExists || globalGraphBlocked` on the global side),
  usable or not and whether or not it routes anything: the project file would replace it whole. Publication
  is exclusive (`wx` locally, the one-function `nt_put` script remotely, shared with `createShipGraph`).
  Routing goes last and the write stops at the first failure, so no route ever names an agent that failed.
  A removed project folder is refused rather than recreated: it may be a worktree someone removed.
  **A project whose `.claude` is part of the machine's Claude config is refused before any write**
  (`SHIP_SHARED_CONFIG_MESSAGE`): a new SSH project's folder is `~`, and anything written there reaches
  every project on that machine. The starter and "Create example" with `project` scope share the check:
  `leadsIntoGlobalConfig` over `realPathAllowingAbsent` and `isSameOrInside` locally,
  `remoteSharedConfigCheck` over `nt_real` on a host (`test -ef` is not POSIX), read back by
  `remoteConfigRefusal`. Same-or-inside is by whole segments, so `~/.claude-2` passes while a project on or
  under `~/.claude` is refused. Dangling links are followed, because a link to a subfolder that does not
  exist yet still says where a write would go. Each caller names its subfolders: the starter
  (`TEMPLATE_SUBS`) tests `.claude`, `.claude/agents` and `.claude/commands` against the real global dir and
  its `agents` and `commands`, because a global subfolder can link out to a shared kit. Create example
  (`GRAPH_SUBS`) tests `.claude` against the global dir alone, so an unreadable global `agents` does not
  block it. A check that cannot run refuses too. The starter also fails on a global `agents` or `commands`
  it cannot read, before the first write: a remote `[ -e ]` would read it as empty. A home folder passes when
  `CLAUDE_CONFIG_DIR` points elsewhere. Scope `global` ("All projects") skips the check, as the person's
  explicit choice. The offer does not pre-judge any of this, so both buttons stay enabled and the refusal is
  the failure shown after the click. Nothing launches. The channel is classified like `shipGraphCreate`
  (Editor-only, `SCOPED_REFUSED`). Desktop and Server Edition have a real leg; Mobile: N/A. **Not
  verified:** a real SSH host (the script has run under a real `/bin/sh` only), the Server Edition in a
  browser, a relay tab, Windows, macOS, and `/ship-change` with the generated agents in a real Claude
  session. The real-path refusal on both buttons, the unreadable global folder failure and the guessed-move
  rule are covered by handler and model tests only: the panel's display of the refusal was not exercised,
  and the live Electron run was not repeated for them.
- **Status reaches the model as one string** (`statusSig`, the `teamProgressSig` discipline), never the
  whole `byId` map, which changes on every hook of every node.
- **A delivery buffer spanning every project is why narrowing exists.** `AgentGraphLog` is per process.
  The renderer keeps what touches its nodes, and a non-editor's response and live events are cut to
  events whose EVERY named node is shared (`agentGraphEventShared`): the far end of a message into
  another project is that project's activity. The ship channels are Editor-only and `SCOPED_REFUSED`:
  global agents belong to the host's user, and those peers get the observed graph.
- **Discovery runs where the agents run.** An SSH project reads the host through one `sh -s` script fed
  on stdin (not `sh -c`: the login shell may not be POSIX), with a per-call nonce on its record markers
  so a hostile agent file cannot fake a record. A disconnected SSH project answers `unsupported`, and
  the Server Edition answers the same for any SSH project: describing this machine's agents as the
  host's is the failure to avoid. Output with no end marker is a failed read, not an empty machine.
- **Symlinks are followed, and that is why this polls.** Installed agents are usually symlinks, and
  `fs.watch` on the folder never fires for an edit of a link's target. A subscribed view re-reads (5 s
  local, 20 s remote), on leases shared per project, and pushes only on a real change.
  A link in a cloned repo can point anywhere, so the target must be a regular file (a FIFO would hang
  the open), only its head is read, and only parsed frontmatter leaves: an "agent" linked to a private
  key yields a card with the link's name.
- **`ship-graph.json` is hostile display data.** Read field by field in `sanitize.ts`, so unknown keys
  and `__proto__` never reach the output; ids must be plain tokens; `trigger.command` is shown, never
  run. A malformed project file warns and falls back to the global one, and the row still offers Open,
  because Create would refuse. Create never overwrites (`wx` locally; remotely a checked temp published with `ln`, since the script
  itself crosses the ssh channel and `remote-write.guard.test.ts` forbids a bare `cat >`). That script is
  one function called on its last line, so a cut-off script runs nothing, and success is its done marker:
  exit 0 can be a shell that read nothing.

- **Skills and MCP are a log fact, not a mirror event.** `claudeToolAccess` (`shared/agents/tool-access.ts`) reads
  a hook payload, and `HookServer` hands the result to `agentGraphLog.recordAccess` AFTER the claude pane-origin
  gate and in no other path. It is not a `NormalizedAgentEvent`, so state, Eco, messaging and the renderer never
  hear of it, and `normalizeClaude` still returns null for a child's tool events. A throw there never fails the
  hook POST. Claude only: other agents' tool events are not measured, and a custom agent built on claude posts as
  `claude` already. MEASURED on 2.1.318 (`__fixtures__/claude/tool-access-hook-payloads.json`): `Skill` with
  `tool_input.skill`; `mcp__<server>__<tool>`; a child's events carry `agent_id`; a typed `/name` fires only
  `UserPromptSubmit`; `ToolSearch` is not an access.
- **Only names ever leave.** A name passes a closed alphabet (skills `[A-Za-z0-9._:-]`, MCP `[A-Za-z0-9_-]`, 64) or the
  event is dropped whole, never repaired. Tool arguments and the rest of a prompt are never carried, and `subId`
  must pass `isClaudeAgentId`. One row per key with a running count (`MAX_ACCESS_KEYS` 1024, oldest key and its
  row forgotten and counted as dropped), pushed on every call, because each push is one flow dot. A typed
  `/name` is its own row (`:typed`), and the model draws it only when the machine's skills or commands hold that
  name, so `/clear` and a stray token draw nothing.
- **MCP config: `name` and `transport` are the only fields that leave the parser** (`parseMcpServers`). `command`,
  `args`, `env`, `url` and `headers` carry tokens and appear in no `ShipConfig`, warning or log, and a parse error
  never quotes the file because it quotes the text it choked on. Sources are `$CLAUDE_CONFIG_DIR/.claude.json`
  else `~/.claude.json` (top level plus `projects[<cwd>]`) and the project's `.mcp.json`, regular files only,
  16 MB. An SSH host answers `mcpRead: false`: that file holds credentials and is not fetched, and "not read"
  is never rendered as "none". Claude names a tool's server with characters outside `[A-Za-z0-9_-]` rewritten
  to `_`, so the panel matches by `mcpNameKey`.
- **Dots are finite and per event.** `FlowDots` adds one `<circle>` per new line timestamp (`pulseOf` already refuses
  anything older than the view), at most `MAX_FLOW_DOTS` at once, removed on `animationend`. The CSS is
  `1` iteration and must not read `--nt-anim-state`. The Harness line points harness to session so the
  layout ranks the harness left, and carries `flow: 'reverse'` so its dot runs the way hooks flow. An idle graph
  runs no animation. `agent-graph.css.test.ts` pins it.
- **2D motion is finite, and the glows rest lit.** A box (`.agent-graph .react-flow__node`) and a line
  (`g.agent-graph-edge`, its label) fade in once. React Flow keeps each element by id, so a status change
  never replays it. The box grows in with `scale`, not `transform`, which React Flow owns on the wrapper.
  A session's status glow (`data-glow` from `sessionGlow`: working, needs you, idle) pulses four times
  (2.6 s working, 2 s needs you) and rests at the base `box-shadow`, which is where its keyframes start
  and end. Idle is lit and still. **Each pulsing status has its own keyframes**
  (`agent-graph-glow-working`, `agent-graph-glow-attention`), with the same frames. The box survives a
  status change, and an animation whose name is unchanged is not restarted. With one shared name, a
  session that went from working to needs you after its pulse ended never pulsed again. An idle window sets `animation: none` on the glows, so they rest lit rather than freeze mid-pulse. The
  entrance has no window gate, because it is short and runs once. Reduce Motion sets `animation: none`
  on the entrance and the glows. None of it reads `--nt-anim-state`. `agent-graph.css.test.ts` and
  `styles.animation-gate.test.ts` pin the shorthands, the rest and the gates. What a box says lives in
  `lib/agentGraphNodeText.ts`, so the 3D tooltip cannot word it differently.
- **The 3D view renders the same model** (`components/graph/AgentGraph3D.tsx`; the pure shape is in
  `lib/agentGraph3d.ts`). `toGraph3dData` returns the SAME object while `agentGraphStructureKey` is
  unchanged and no node changed kind (`sameKinds`). A kind is not structure in 2D, but in 3D it is the
  shape, so a session that turned ghost needs a new object and a new mesh. On a rebuild it keeps every
  surviving node object of the same kind. The force layout writes positions onto those objects, so new
  ones would throw the graph back to the start. A line object is kept only while each end is its id
  string or the very object now in `nodes` for that id (`endIsLive`). d3-force-3d's `forceLink` keeps an
  end that is already an object, so a line tied to a replaced node would stay pinned to an object no
  longer simulated. Content (status,
  counts, colours) is restyled in place. Colours are the 2D tokens, resolved against the live theme
  through a probe element. `parseCssColor` reads what Chromium computes, `color(srgb …)` included. They
  are re-resolved on a `data-theme`, `data-nt-glass`, `style` or `class` change on the root. The WebGL
  canvas is transparent, so the view's background is the theme's. A dashed 2D line is a fainter tube
  (`DASHED_LINK_ALPHA`), because a tube has no dash. A status glow is a still halo, never a pulse, so a
  settled graph needs no frames. A session that is only working keeps that still halo too: a turn can
  last hours. What moves is under **Live subagents in 3D** below. **The halo and aura shells never take the pointer** (`raycast = noPick`).
  three's raycaster ignores `visible`, and 3d-force-graph ranks any node hit above any line hit. A
  pickable shell, even a hidden one, would take hovers from nearby lines, whose words show only on hover,
  and clicks meant for the node behind it. The core shape and the name label stay pickable, as a click on
  a 2D box's title opens it. Particles are the 2D dots' stream: one per new `pulseOf` value on a line,
  seeded at mount so nothing replays, at most `MAX_FLOW_DOTS` in flight per line. A line in transit by
  the 2D rule (`edgeInTransit`) also sends one every `STREAM_EVERY_MS` (900 ms), under the same cap, as
  the 2D chevrons keep moving along it. None is emitted under
  Reduce Motion or while nobody can see the view, and an event missed then is not replayed later. The
  map of what was played (`seen`) is never pruned when a line goes. A line that leaves and comes back (a
  session's Harness line, through ghost and back) returns with its old `lastEventTs`, so pruning would
  replay an event already shown. It costs one number per line id until the view unmounts.
- **The 3D layout pulls every node toward the middle, harder in depth** (`graph3dLayoutForces`). The
  library's own forces are `link`, `charge` and `center`, and `center` only moves the whole graph's
  centroid. Two parts with no line between them (a ship template beside the sessions, a note on its own)
  pushed each other apart with nothing pulling back: 7.6 line lengths apart in the reported picture,
  and fitting both left every node a speck. `forceX`/`forceY` at `GRAPH3D_GRAVITY` (0.1) keep them
  about two line lengths apart and leave a line's own length alone. `forceZ` is `GRAPH3D_DEPTH_FLATTEN`
  (2.5) times stronger, because the first view looks down z: with an even pull, nodes sat behind each
  other there (closest pair at 0.05 of the room a halo and a name need, over eight start orders). At
  2.5 the closest pair keeps 0.84 of it and the graph is about a sixth as deep as it is wide, so turning
  it still shows depth; at 3 it is flat. A collision force was tried and dropped: in 3D the nodes were
  already clear of each other, and what overlapped was on screen, which only the depth pull fixes.
  `agentGraph3d.test.ts` runs the real simulation on the reported picture and pins all three. A
  translucent node colour (the 45% tint of a stage or the Harness) is drawn as it would look over the
  panel (`compositeOver`), because a solid mesh has no alpha to spend: the full tint was white in dark
  and black in light, louder than the sessions. The Harness is drawn smaller than a session (6, not
  8): it is a hub, and the sessions are what the graph is about.
- **3D nodes are planets, and each kind is its own kind of world** (`graph3dNodeLook().planet`,
  `NODE_BODY`). Once every node is round, the surface carries the kind the polyhedra used to: sessions
  are banded gas giants in their agent's colour with a thin haze, the Harness a ringed grey giant,
  stages and subagents cratered rock, skills icy moons, MCP servers icy moons with a ring, notes lumpy
  asteroids, ghosts faded rock. The map is painted once per node on a 256 by 128 canvas
  (`components/graph/planetSurface.ts`), seeded by the node's id (`graph3dSeed`), so a node is always
  the same world, with the same tilt and face at rest (`graph3dPlanetPose`). It is painted again only
  when its colour changes (a theme or accent change), never for a status change, and given back on
  unmount. Where there is no 2D canvas the world is its plain colour. A running world turns on its own
  tilted axis, under the same rule as before. Haze and rings are children of the core, so they tilt
  with it and the group keeps its order, and like the glow shells they never take the pointer. The
  library's light is mostly ambient, which draws a sphere as a flat disc, so the view sets its own:
  ambient 0.55 and one sun (3.6) up and to the left of the first view. A darker night side turned into
  black discs on the light theme's cream.
- **The current step is the 3D view's sun** (`graph3dCurrentStep`). Of the nodes with something running
  (a working session, a running box, a live subagent run), the one with the newest event is drawn as a
  star: 1.7 times its size (drawn only; the layout keeps its size), lit from within, in a corona of
  rays in its own colour, with "CURRENT STEP" under its name, which never gives way (`labelRank` -1).
  Its glow shells hide, because the corona is its glow. A tie goes to the more important kind. With
  nothing running there is no sun: the view never claims a step that is not happening. Every world also
  wears a soft glow in its colour, and three still nebula clouds sit far behind the graph. **Light lives
  outside the nodes** (one `lightLayer` in the scene) and follows them from the core's
  `onBeforeRender`: the library fits the camera to every geometry under a node
  (`getGraphBbox`), and a corona fifteen radii wide inside one pushed the whole graph into the
  distance. A node that leaves, or is rebuilt as another kind, takes its glow with it (`dropGlow`).
  Light adds up on a dark sky and vanishes on a pale one, so on a light theme glow and corona are laid
  over (normal blending) instead of added, and the nebula is hidden. Corona, glow and nebula are painted
  once, in white, and tinted by the sprite that wears them. They take no frames of their own and never
  take the pointer.
- **The 3D view can be flown** (`graph3dFlyMove`, `graph3dFlyStep`). Clicking the view focuses it;
  then W A S D (or the arrows) fly forward, back and sideways, Space and Shift rise and sink in the
  world's up, drag still turns and scroll still zooms. A step moves the camera AND the orbit target by
  the same amount, so dragging afterwards turns round what is in front, not round where the graph
  was. Speed is `FLY_RATE` (35%) of the distance to the target per second, never under
  `FLY_MIN_SPEED`: at 90% one tap of D crossed the whole system. A long frame moves no further than
  50 ms would, so a hitch never jumps. Two keys at once are no faster than one. Frames run while a key
  is held (`flying` in `graph3dLoopShouldRun`) and stop after, under the same window gate as the rest.
  Blur lets go of every key, because a key released elsewhere never sends its keyup here. Which keys,
  and why they are not registry commands: `keybindings.md`. A card of the keys sits over the lower left
  corner, shown until someone hides it (`nodeterm.agentGraphFlyHelp`, a display preference), with a
  **Keys** button to bring it back. Its last line always says where the keys go ("Click the graph, then
  fly." or "Keys go to the graph."): a card that grew a line when focus left moved its own close button
  out from under the pointer between press and release. Mobile N/A: no keyboard.
- **3D names are a fixed size on screen, drawn on top, and the weaker one gives way**
  (`graph3dShownLabels`). A name is `LABEL_PX` (22 CSS px) tall at any depth or zoom
  (`sizeAttenuation` off, scaled by `graph3dPixelScale` from the view's height and the camera's field of
  view, and resized with the view), and stands on its node's top. It is drawn over lines and nodes
  (`depthTest` off): world-sized names grew near the camera, covered their neighbours once the view was
  turned, and had lines and arrowheads running through them. Each frame the names are placed on screen
  and kept by rank (session, then Harness, then stages and subagents, skills and MCP, notes, ghosts:
  `labelRank`), then nearest first; one that would come within `LABEL_GAP_PX` of a name already kept is
  hidden. A session's name is bold (700) and every other name semibold (600), all in full ink: lighter names, or ink at 80%, washed out on the light theme's pills once scaled down to 22 px. A hidden name
  also stops taking the pointer (its `raycast` is `noPick` until it shows again), because the raycaster
  ignores `visible`. Hovering its node still shows the name in the tooltip. The pass runs from the star
  field's `onBeforeRender`, which is never culled, so it adds no frames and runs only on frames the gate
  allows; a change it makes shows on the next frame.
- **The 3D frame loop runs only while something can change and somebody can see it**
  (`graph3dLoopShouldRun`). It runs while the layout moves, a particle is in flight, something is live
  (`graph3dHasLiveMotion`, and never under Reduce Motion), the pointer is over the view, or a camera
  move was asked for. It never runs while the window is idle or hidden (`data-nt-window`,
  the CSS gate's own signal) or the terminal modal covers the view. While it runs, the gate is re-checked
  every 250 ms. 3d-force-graph's own loop is a rAF every frame forever, so without the gate a settled graph
  nobody points at would hold the window at display rate. Under Reduce Motion the layout is computed before
  the first frame (`cooldownTicks` 0), the camera jumps (`zoomToFit(0)`) and there are no particles.
  **Resuming frames reheats a layout that has not settled.** three-forcegraph's cooldown is wall-clock
  (`cooldownTime`, 4 s), and a data update restarts it even while frames are paused, but the layout only
  advances on frames. So when frames resume while the engine still counts as running, `evaluate()` calls
  `d3ReheatSimulation()` (alpha 1 and a new countdown) before `resumeAnimation()`. Without it, a structure
  change made while the view was covered or the window idle, then a pause longer than 4 s, ends the
  engine with zero ticks and leaves the new shapes piled where they started. A settled engine is never
  reheated, and Reduce Motion still settles at once.
- **Live subagents in 3D: only what is running moves, and only on frames the gate allows.** The model
  puts each live run (`isLive`, the staleness line of a box's activity) on the box it is drawn in
  (`GraphNode.live`, `attachLiveRuns`), by the rule a skill call leaves by: one certain box in `subBox`,
  else its session. It is content, so it never moves the layout. Both views word it the same way
  (`graphNodeBadges`, "2 subagents running" or "1 running now", and a `Now:` line naming the newest four).
  In 3D (`graph3dNodeMotion`) each live run is a satellite on a ring around its box, at most
  `MAX_SATELLITES` (8, the newest), and a box with a live run turns (not a session sphere) and its halo
  breathes. A session that is only working does not breathe, so an agent at work for hours with no
  subagent costs no frames. The motion is set from `Mesh.onBeforeRender` on the core, so it adds no loop
  of its own: frames run while `graph3dHasLiveMotion` says something is live and the window is watched,
  and stop with the window idle or hidden, the modal up, or the last run over. Restyling sets the pose
  at once, so a box that stopped rests at full size even with no frame after it. Satellites and the star
  field take no pointer (`noPick`), as the glow shells do. Under Reduce Motion satellites are drawn
  still, and nothing turns, breathes or streams. The star field is a fixed scatter of faint points in
  the theme's text colour, drawn only on frames something else asked for. **Not verified:** the frame
  cost of a busy graph on real WebGL; jsdom has none.
- **Unmounting the 3D view gives its WebGL context back.** It calls `_destructor` (scene, controls,
  renderer) and then `forceContextLoss`. `dispose` alone keeps the context, and Chromium evicts the oldest
  context past its cap, which can be a terminal's. The terminal budget (`terminal/webgl-budget.ts`) stays
  under the platform cap with room to spare, and this view takes one of those spare slots. Unmount also
  deletes the `window.scene` global the library sets.
- **3D never leaves a blank pane.** WebGL is probed before the chunk is fetched (`lib/webgl.ts`), and the
  probe's context is released at once. No WebGL, a lost context, or a chunk that fails to load or throws
  (`Graph3DBoundary`) shows 2D with a notice. The boundary tells the last two apart: the lazy import
  wraps its rejection as `Graph3DLoadError`, which gets `GRAPH_3D_LOAD_FAILED_NOTICE` ("could not be
  loaded"), and any other throw gets `GRAPH_3D_FAILED_NOTICE` ("stopped with an error"). The person's
  choice is kept. After no WebGL, a lost context
  or a render-time throw, a click on 3D or the next open tries again: the probe re-runs and the boundary
  remounts. **A chunk that failed to load does not retry.** `lazy()` is at module level in
  `AgentGraphView.tsx`, so React keeps the rejected promise for the renderer's life, and Chromium's module
  map keeps the failed import of that URL too. Every try shows the notice again until a restart or a window
  reload. The choice is a display preference in localStorage (`state/agentGraphDisplay.ts`,
  `nodeterm.agentGraphView`). It is one for all projects, and anything but a literal `3d` reads as 2D.
- **The 3D code loads only when 3D opens, and only its bundled chunk ships.** `AgentGraph3D` is a
  `lazy()` chunk, the only one holding `three` and `3d-force-graph`. Both are exact-pinned
  devDependencies: Vite bundles them into that chunk (about 1.6 MB, in `out/renderer`, which ships), and
  electron-builder packs only `dependencies`, so their ~58 MB `node_modules` subtree stays out of the
  installer. Their licences are in `THIRD-PARTY-NOTICES.md`, which every installer carries. `three/webgpu` is aliased to a stub
  (`three-webgpu-stub.ts`, in `electron.vite.config.ts`). three-render-objects imports the WebGPU renderer
  but never builds it here, and the stub halves the chunk (3.24 MB to 1.63 MB). `three` ships no types and
  `@types/three` is not a dependency, so `src/renderer/three-subset.d.ts` declares only what the view
  calls. A new three API must be added there first. `d3-force-3d` (the library's own layout engine, already in the chunk) is an exact-pinned devDependency too, so the view can add forces to it, and `src/renderer/d3-force-3d-subset.d.ts` declares only what the view and its tests call. `package.json` overrides 3d-force-graph's
  `float-tooltip` to 1.7.5, because 1.8.0 was days old and pulled a days-old preact. **Not verified:**
  real WebGL rendering (jsdom has none; the component tests drive a stand-in library), its frame cost, the
  Server Edition in a browser, Liquid Glass. Mobile N/A.
- **The Harness box is per machine and only for session boxes**, never a note, ghost or template. A figure the
  config cannot state for that machine (`shipDescribes`) is left off, not zero. Which box a subagent's call
  leaves (`subBox`) is certain or it is the session: a guessed, uncertain, twice-drawn or unknown run falls back.
- **Surfaces.** Desktop full. Server Edition runs the same core path (the hook route, the log and the local ship
  handler are shared); an SSH project there answers `unsupported` as before. A relay Viewer or Commenter gets the
  observed boxes for shared nodes (an access event is narrowed by `nodeId` like every other graph event) and no
  inventory, because the ship channels are Editor-only. SSH nodes report through the hook tunnel, so their boxes
  work and their inventory is partial (skills yes, MCP not read). Kanban N/A. Mobile N/A, a follow-up for the
  phone would need the log over the relay.
