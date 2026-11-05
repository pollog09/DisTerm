# Canvas control: waits, headless start, settings and notices

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Canvas control: waits, headless start, settings and notices

  **Dependency edges (`--after`, 2026-07):** `open-terminal`/`open-claude`/`open-agent` accept
  `--after <id,id>`, which opens the node **armed** — `data.pendingLaunch` ({after, command},
  `PendingLaunch` in shared/types) holds the launch the factory built, and Canvas fires it once
  every dep reports `done`. This is what makes the canvas a DAG instead of a fan-out.
  **`pendingLaunch` is a MACHINE-LOCAL exec field, like `shell`** (@shared/node-exec): its `command`
  is typed into a shell once the wait is over, and `after: []` or a vanished dep counts as over, so
  a value that arrives from outside would run a command nobody here armed. It is persisted in
  workspace.json's `IndexEntryV3.localExec` (every ref kind: folder, SSH, local-data), NEVER in
  `.nodeterm/project.json` or an SSH mirror (`stripSharedNodeExec`), and a file that carries one is
  ignored on read — the one-time legacy hoist deliberately does not adopt it either (provenance
  cannot be told apart, so an armed node written by an older build loses its held launch on
  upgrade). On `canvas:mut` a peer's value is stripped and OUR value carried across its upserts
  (`carryLocalNodeExec`); the reflector forwards one only between OWNER clients
  (`CorePlatform.isOwnerClient`: the app window, a cookie-authenticated Server Edition tab — never a
  relay peer), stamped `origin: 'core'`, which a client cannot supply and a relay tab ignores. That
  owner→owner leg is load-bearing: it is how two Server Edition tabs converge on a launch's
  attempted/cleared state, and how a headless delivery's clear reaches the browser. **It is NOT the
  exactly-once guarantee** — it lands only after a publish → reflector → apply hop, and two tabs on
  one project both claimed a fresh node's launch inside that window and both typed it (#1173). The
  claim therefore asks the CORE first: `commitLaunchAttempt`'s `claim` → `workspace.claimLaunch`
  (`workspace:claim-launch`, `core/launch-claim-ledger.ts`, registered by `WorkspaceStore` in both
  shells, host-only). Keyed (node id, command) → the claiming CLIENT: the first claimant owns it, a
  later AUTOMATIC claim from another client answers `elsewhere` and types nothing and marks
  nothing (the writer's outcome `elsewhere` is not a failure; the canvas loop keeps it in flight),
  the owner asking again is still the owner, and a manual Run now is never refused. In memory and
  bounded (4096): a process restart forgets it, and the persisted `attempted` mark is the barrier
  then. Desktop has one renderer, so its single claimer always wins. Our OWN writes
  into a background project go through `applyOwnNodeMutation` (unstripped — a cold open keeps its
  launch, a patch to `undefined` clears it); `applyNodeMutation` is the peer path (the one reducer,
  `applyCanvasOp`). On a Server Edition that governs a shared project, the canvas authority hears
  every op WITHOUT its launch and a save's exec carry is what writes it (see **Shared canvas
  authority**). Load-bearing
  details: (1) **an unknown agent state is NOT "satisfied"** — right after a fan-out no upstream has
  emitted a hook event yet, and reading "no news" as "finished" would fire every dependent
  instantly; a **deleted** dep IS satisfied (it can never report); and a dep that is `done` with a
  live **`lastTurnError`** is NOT (issue #521, below). (2) Only `hasHooks` agents may be
  waited on — a plain terminal never reports done, so `resolveAfter` **refuses** it rather than
  letting `launchesToFire` (which cannot tell "never will" from "not yet") hang the node forever.
  (3) **Control opens always retain the command in `pendingLaunch` until delivery lands**
  (#827/#811). Even a visible node with no deps has not mounted its PTY when the open reply is
  sent. `queueControlLaunch` moves the command out of `initialCommand`; the PTY-ready gate below
  makes this safe. The open reply says `queued`, and project serialization retains the brief.
  (4) Desktop automatic and manual launch delivery share `terminal/launch-command.ts`, which
  uses `deliverCommand`: echo verification, bounded Ctrl-U repair, platform kill-line and overlong
  line refusal. The PTY-lifetime writer coalesces concurrent requests and remembers submission
  across parked views. Relay queued/restored delivery, including Run now, is refused until a scoped durable
  claim API exists: a relay workspace load can be project-scoped, while save replaces the host
  index. Never use that load/save pair for a launch. A new relay UI initialCommand may instead
  use the verified writer once on a fresh PTY without creating pendingLaunch or writing workspace
  data. Its transient claim is consumed before settle and survives view remounts; relay snapshots
  omit that initial command rather than converting it to durable intent. A parked-project deferral before any input
  retains never-attempted intent and can proceed on activation without a retry timer.
  New intent has `attempted:false`; the writer awaits a workspace save of
  `attempted:true, manualOnly:true` before input, then rechecks the shell after that save. That
  save is **`localOnly`** (`WorkspaceStore.save`): durable in this machine's index, with no SSH
  read/reconcile/mirror — a changed entry is marked `unmirrored` and the next ordinary save pushes
  it. Awaiting the mirror put two SSH round trips in front of every new agent on an SSH project.
  A node's own first-open delivery (live `initialCommand`, no deps, no failure record) shows NO
  QUEUED chip: its `pendingLaunch` is only the write-ahead record, and it carries `manualOnly`
  from the claim until Enter lands, which painted "⚠ QUEUED" on every freshly opened agent. A warm
  attach may automatically deliver never-attempted intent, preserving long-running `--after`
  graphs through project switches/park expiry. Attempted/legacy-unknown intent stays manual: its
  clearing autosave may have been lost after Enter. Explicit Run now rechecks the foreground shell and
  clears any incomplete line; a refused/throwing/cancelled launch stays held, `manualOnly`.
  The Server Edition's immediate open and its `run`, and the desktop's headless start (`--run-now` /
  `run`, below), deliver through the SAME echo-verified writer (`@shared/command-delivery`, moved
  out of the renderer for this), via the headless launcher `core/headless-launch.ts` (#925): a tmux
  paste is not immune to zsh's rc-time tty flush (#556) or the canonical-line cap (#706). The
  Server Edition's deferred `--after` release (`refreshArmed`) still pastes with `sendText`.
  (5) UI `initialCommand` stays until submission; serialization converts unsubmitted UI intent
  into a never-attempted `pendingLaunch`, including a project switch during shell settle. A live
  initialCommand alias on remount cannot reset an attempted marker. Server saves
  `attempted:true, manualOnly:true` BEFORE sending and only clears the command after acknowledgment. Failed
  independent/dependent launches are never retried by unrelated hooks. Boot remains inert.
  Server deferred delivery is deliberately one-shot: a transient probe/send failure needs Run now.
  Desktop keeps the attached echo-verification transport even for offscreen held nodes; a large
  long-waiting fan-out therefore keeps those xterm instances in memory until delivery/recovery.
  (6) Canvas subscribes to `armedDepSig`, NOT `useAgentStatus(s => s.byId)` —
  the same discipline as `loopSig`; the full map re-renders the canvas on every hook event.
  Pure logic + refusal matrix in `renderer/lib/pendingLaunch.ts` (unit-tested);
  the dep→node edge is a **rope** (`ctrl-after-<dep>-<node>` — `waitRopeId`, marked so it can
  never be mistaken for the opener's `ctrl-<source>-<node>` once the canvas prunes that one; ropes
  saved before the mark are re-marked by append order at load, `markLegacyWaitRopes` — persisted in
  `project.ropes` like the opener's) whose LOOK is derived: dashed + ⏳ while the node's `pendingLaunch.after` still lists the
  dep, solid once it has launched (`lib/edgeModel.ts` `ropeVisual`, over the ONE `ropeInfoOf` lookup
  the render and BOTH delete paths ask — two builders would be two answers, and the label the user
  reads would stop describing what the delete does). The fan-in bridge `--after` also writes hides
  under that rope (`hiddenLinkIds`), so ONE edge per pair holds on the canvas. Deleting a WAITING
  rope drops that dep from `after` (`dropAfterDep`) and takes **nothing else** — the covered bridge
  survives, because "stop waiting for it" is not "stop being able to read its work"; an emptied
  list fires. Only the `open-*`/`verify` verbs write the rope, so `missingDepRopes` heals an armed
  node that has none at **project load**: `pendingLaunch` is persisted (machine-locally) and the rope is not, so a node
  armed by any other path — or by a build older than this one — would otherwise hold a launch with
  no arrow saying what for. All edges route through the single `floating` edge type
  (`canvas/FloatingEdge.tsx`, a bezier between the MIDPOINTS of the two nodes' facing sides — one
  anchor per side, so a hub's arrows converge instead of fanning along its border; context and note
  links are restricted to the left/right sides, where the bridge handles sit; an unmeasured node
  draws nothing rather than a path to the origin) — no family sets a handle side;
  and a node whose eye is closed (`hideFanout`) hides every edge touching it as well as its cards
  (2026-09-02 edge model, spec in docs/superpowers/specs).
  **(7) Delivery waits for the node's PTY, and never fails silently** (issue #569 item 1, 2026-09).
  A satisfied dependency says nothing about whether there is a terminal to type into, and the
  original loop conflated the two: a flat 5 × 400 ms budget started when the CANVAS held the node
  and was spent on loading the canvas, mounting it and spawning tmux — so on a cold project switch
  the launch was abandoned before its session existed, in a `console.warn`, and the node read
  QUEUED forever with only the manual ▶ left. `TerminalNode` therefore publishes a **session-ready**
  signal (`isSessionReady` / `subscribeSessionReady`, module-level like `offscreenNodes`): true for
  an ADOPTED park (already typeable, and its create continuation ran on a previous mount) and, for
  a fresh spawn, at the SAME `whenShellSettled` moment `writeWhenShellReady` delivers an
  `initialCommand` — both write a CLI command line, and a line delivered across zsh's rc-file tty
  flush comes out mangled. A **park keeps the writer and transport**; a real teardown removes
  the writer. The loop WAITS instead of burning attempts before readiness. Once attempted,
  only the verified writer's bounded echo repair runs; further recovery is explicit.
  Because a wait with no end is the failure mode this replaces, both give-up states are **visible**
  in the transient `state/launchDelivery.ts` and rendered by the QUEUED badge's amber ⚠ + tooltip
  (`launchTooltip`, pure): `stalled` = gate open, no terminal yet, **still held** (raised by a
  `LAUNCH_STALL_MS` timer with a fire-time re-ask; the launch still fires whenever the session
  finally comes up) and `failed` = submission is unconfirmed, so automatic retry is stopped.
  A persisted `manualOnly` record carries that warning after reload too. Neither is ever inferred from silence, and
  the tooltip names no cause it did not measure (the node's own overlay owns the diagnosis).
  The open verbs' replies carry the same fact for callers OUTSIDE the app: `result.queued` +
  `result.queuedIds` on `open-terminal`/`open-claude`/`open-agent`, always true for the
  `--project` cold-open branch — an orchestrator was previously told "opened" either way and
  routed work to a session that did not exist. Agent-facing copy is generated in
  `canvas-control-core.ts` and pinned in its test, per the sync rule above.
  `queued:false` is NOT proof of a running CLI: Server's `deliveredIds` acknowledges terminal
  delivery only. Its initial commands are persisted before attach/send and retained on failure;
  only acknowledged sends clear them. Boot ownership remains fail-closed. Desktop `list` (live
  and stored projects) names QUEUED / STARTING / LAUNCH FAILED / DROPPED / AGENT STATUS UNCONFIRMED, and every other agent row its state (WORKING / IDLE / NEEDS YOU: an unlabelled idle row and a row waiting on a person used to read the same)
  rather than treating absence of a hook as success. Server v1 still explicitly refuses `list`.
  **(8) An armed node must not cold-start its own agent** (found while fixing (7)). The mount-time
  cold-restore relaunch (`fresh && agentId && canResume(...)`) carries a second, independent
  refusal beside the `paused` one (`shouldColdResume`): `!data.pendingLaunch`. A first open is
  `fresh` by definition, so every `--after` / `verify` node
  was launching a bare CLI on mount — the session the hold exists to prevent — and the held launch
  then arrived as TEXT typed into it rather than as the command it is. The delivery race used to
  mask it; gating delivery on the shell settling would have made it deterministic.
  **(9) An ERRORED upstream does not release its dependents** (issue #521, 2026-09).
  `--after` fires on idle, and a station whose turn dies on an API/model error reaches idle
  **immediately** — so a malformed-prompt station looked healthy from every surface an
  orchestrator can read, and the whole chain armed behind it launched on what it had not
  produced. The signal was already there and was being thrown away: claude and grok both fire
  **`StopFailure`** instead of `Stop` on an errored turn (already in `CLAUDE_HOOK_EVENTS` /
  `GROK_HOOK_EVENTS` — without the subscription the badge sticks on RUNNING), and both
  normalizers collapsed it to a plain `done`. It now carries **`errored`** on
  `NormalizedAgentEvent`, which `agentStatus` keeps as **`lastTurnError: {at}`**.
  Three things about the shape, each deliberate: (a) it is an **annotation, not a fifth
  `AgentState`** — an errored station IS idle, the two facts coexist, and a fifth state would
  ripple through both raw listeners, the parity test and the mobile mirror for a fact that is
  not a state; (b) it is set in `src/shared`'s normalizers, so **both shells change by
  construction** — there is nothing to keep in parity; (c) it is **TRANSIENT** like `state`,
  because after a relaunch nothing armed can fire anyway and a restored verdict would describe
  another app run's turn. It is **cleared by the next genuine new turn** — not by any
  intermediate transition, which says nothing about whether that turn produced something — so
  the refusal ends by itself when the station answers successfully. Firing with a WARNING was
  considered and dropped: a dependent that has launched cannot un-launch. Surfaces: a
  **TURN FAILED** chip on the node (red, no pulse — a verdict on a turn that is over, not
  something being waited for), the QUEUED tooltip naming the errored upstream instead of
  promising a wait, and a **`LAST TURN ERRORED` marker on the `list` rows** — on the ROW
  because a seven-station fan-out should cost one call to learn this, not seven. **No error
  TEXT is claimed**: whether the hook payload carries the failure message has not been
  measured, and `last_assistant_message` is the previous assistant turn rather than the error,
  so reporting it as "the error" would be a confident wrong fact. Reading the text, and the
  *failed-to-start* watchdog (a station that never emits ANY hook event — the opposite failure,
  which hangs dependents honestly rather than firing them wrongly), stay open.
  **(10) A `done` from BEFORE new work was handed over does not release anything**
  (`core/station-handover.ts`, `@shared/station-handover`, 2026-09-30). A station is reused: an
  orchestrator hands it task B (`send` → `queued` because it is busy, or delivered to an idle pane
  it has not started on yet, or a `write` / `run`) and then opens D `--after <station>`. Until the
  station STARTS B its state is still task A's `done`, so D fired at once — on A's output, and a
  launched dependent cannot un-launch. #1042 closed the same hole for `--after-success` (reports);
  this is the plain-turn half. Rules a refactor must not undo:
  - **The fact is core's, per station, fed by the SAME hand-over moments #1042 uses**: the
    messaging layer's `onHandover` (`queued` = held from that instant; `landed` at the time the
    delivery attempt STARTED; a queued entry that `settled` without landing holds too, from the
    settle — the orchestrator armed D believing the task was handed; the turn running at the expiry
    does not end it, only a turn started after it does, and nothing starts one unless the station is
    given work again, so ▶ / `run` are the usual way out), and each shell's control answer
    (`noteControlAnswer`, on success only, never the caller naming itself) for `write` — stamped with
    the renderer's `typedAt`, when it STARTED TYPING after the human's confirm, never the request
    time: a turn that began while the dialog was open (a background child's task-notification) must
    not answer text not yet typed — and for `run` (starts the named node's held launch; no confirm,
    stamped at request arrival). A `write` into a station that was BLOCKED or WAITING at request time
    (read from the tracker's short state history) is NOT a hand-over: it answers the prompt and the
    same turn continues, so no new turn would ever start to end it. Board comments, station notices
    and a person typing are not hand-overs (the #1042 set).
  - **It ends with a turn that STARTED at or after the newest hand-over and has ENDED, with nothing
    still queued.** The tracker stamps turn starts itself (first working/waiting/blocked after an
    idle state, or any genuine `newTurn` — after an Esc interrupt core may never see the idle the
    renderer infers — on its own clock) for EVERY station, because a delivered prompt can start — and
    even finish — its turn before the delivery's `landed` event is emitted; a hand-over that finds
    its answering turn already over clears at once. Timestamps never cross a process: the renderer
    only reads a membership list, so the Server Edition browser's clock never enters it. A turn
    already running when the work landed does not end it (the typed text is answered by a LATER
    turn); if a CLI folds typed input into the running turn instead, the hold lasts until its next
    turn — the holding direction, with ▶ / `run` as the way out. The idle-prompt rescue (`idle: true`)
    counts only for a station still `working` (the reduceEntry rule): it also fires under an open
    permission prompt, and taking it as idle there let the approval's `working` stamp a fake turn
    start inside the same turn (review of #1052, reproduced).
  - **The tracker is fed every agent event BEFORE the messaging queue** (desktop `emitAgentStatus`,
    the Server Edition's `onAgentEvent`): the queue flushes new work on the very `done` the tracker
    must stamp, and the server's `refreshArmed` reads the tracker on that same event. Pinned at
    source level by `main/station-handover-wiring.test.ts`.
  - **The renderer reads it through a derived primitive signature** (`armedHandoverSig`, only the
    armed nodes' deps — the `armedDepSig` rule), and `launchesToFire` / `depSatisfied` take it as a
    trailing argument: a handed-over station is never a satisfied dep, a DELETED one still is.
    `successDepFacts.turnDone` applies it too, so a success wait never releases where plain
    `--after` would hold. The Server Edition's factory asks `handedOver` in `refreshArmed` AND in the
    creation shortcut (`mustWait`): "already satisfied at creation" must mean satisfied under this
    rule, or the node is launched immediately by the shortcut.
  - **Background SUBAGENTS hold the same way; background SHELLS do not** (same module, same list;
    `background: true` on the record). MEASURED live 2026-09-30: an agent's turn ended while its
    work went on in the background, and the node armed `--after` it fired before anything was
    pushed. Claude's `Stop` carries `background_tasks` (see **Claude's native subagent hooks**, fact
    6); `liveBackgroundSubagentIds` keeps only `type: 'subagent'` entries
    (`NormalizedAgentEvent.backgroundSubagentIds`). A `done` listing a live subagent holds the
    station; only a later `done` whose inventory is PRESENT with no subagent left releases it, or
    `SessionEnd`. Why only subagents: a child ENDS, and its task-notification wakes the parent into
    another turn, so that later `Stop` reliably comes; a background shell (a dev server, a watcher,
    `tail -f`) may never end and does not reliably wake the station — holding on shells held a
    dependent FOREVER ("S starts the dev server, T `--after` S runs e2e" never fired; review of
    #1052). Unknown `type`s are treated like shells. An ABSENT inventory is unknown and changes
    NOTHING (a CLI too old to send it keeps today's behaviour exactly; the idle rescue and
    `StopFailure` carry none). The agent bodies tell a station to wait for a background shell's
    result itself before ending its turn when a dependent needs it.
  - **Eviction prefers stations with nothing held** (the bound is 2000 tracked stations; the oldest
    with nothing held goes first) — dropping a held one would release its dependents. Only when
    every tracked station holds is the oldest held one dropped.
  - **The Server Edition re-runs `refreshArmed` on every tracker change**, not only on
    working/done events: a hold can end on an event the factory is not otherwise run for (a
    `SessionEnd` clearing a subagent hold).
  - Surfaces: `list` says `waiting for <station> to finish the work handed to it` (or `…the tasks
    still running in its background`); the QUEUED tooltip
    names it; both agent bodies render `afterHandoverDocLines` ("hand it the next task FIRST, then
    open the dependent"). DURABLE across a restart (`HANDOVER_FACT`, see **Durable orchestration
    state**): the holding stations are stored, `queued` is rebuilt from the durable queue.
    Relay tabs take the inert stub; the list channel is HOST_ONLY
    (unscoped: every project's stations). Mobile: N/A (the phone never sees `pendingLaunch`).
    Tests: `core/station-handover.test.ts`, `test/acceptance/after-handover.test.ts` (the REAL
    queue → tracker → the renderer's real `launchesToFire`, red on the old code) and the server
    factory's own cases.
  **Pull request waits (`--after-pr`, 2026-09-29).** `open-terminal --cmd …` / `open-claude` /
  `open-agent` take `--after-pr <N:checks|N:merged>[,…]` (N may be `#N` or `owner/repo#N`) and
  `--pr-deadline <90m|12h|3d>`: the held launch ALSO waits for pull requests of the project's
  board repository, ANDed with `after` and the setup gate. The grammar, the persisted shape
  (`pendingLaunch.afterPr = {repository, waits, deadlineAt}`) and main's shape gate are ONE module,
  `@shared/pr-wait`; when a wait is met is `renderer/lib/prWait.ts`. Rules a refactor must not undo:
  - **No new poller, no new request path.** The status is #1008's `GitHubPullBoard` from the host's
    memory. Canvas holds the board's own refcounted host subscription (`watchPulls`) while any live
    node holds a PR wait, so #1008's conditional heartbeat (free while nothing changes) keeps it
    fresh; a `checks` wait also asks the host's bounded chase (`usePullChase`, visible window only)
    because a finished check run does not move the heartbeat. Past the chase cap (12 reads, about
    48 minutes) a still-running CI is noticed on the next repository change — the deadline and ▶
    are the answer, never a timer of our own.
  - **#1008's semantics, not new ones.** `checks` = `ci === 'passed'`, which `pullStatusFrom`
    reports only for a SUCCESS rollup at the CURRENT head; a null rollup ("no checks") never passes;
    a STALE board never passes `checks` (a push since the last read carries other checks) but may
    pass `merged` (irreversible). A board whose repository differs from the hold's is `blocked`,
    which holds rather than fires — that is also what makes a mid-switch board harmless.
  - **`checks` needs a read that STARTED after arming.** The host remembers "passed at head A"
    across a closed board, so pushing B and arming at once would otherwise fire on A. The hold
    stores `armedAt` on the HOST clock (`pullStatus().now`), the tracker publishes `readStartedAt`,
    and `checks` is `unknown` until `readStartedAt >= armedAt`. Two host changes carry it: a
    FOREGROUND read now notifies even when nothing changed (else an already-green PR's fresh read
    would never reach the renderer), and Canvas asks for one (`startFreshReadAsks`: at once, then at
    most 3 more, 35 s apart — the 30 s refresh floor or a read already in flight can swallow one).
  - **"No such PR" needs a snapshot refreshed after the question** (`lookupPullRequests`). A board's
    snapshot can be a minute old and `subscribe` starts no refresh when a board already holds it,
    so `gh pr create` then `open-* --after-pr` used to be told "does not exist — do not retry". A
    miss now asks for one refresh and looks again; absence is proven only when the snapshot's
    `lastSuccessfulRefreshAt` is at or after the host time read before that refresh. Columns come
    from the first page's `counts`, so a PR filed under a deleted column is still found, and a
    truncated harvest says so instead of "retry in a minute" forever. The spilled-prompt TTL
    (30 days) outlives the longest `--pr-deadline` (14 days), pinned by a test.
  - **Unknown is never satisfied, in both directions.** `launchesToFire` treats a caller that passes
    no PR context as CLOSED for a PR hold (the opposite of the setup gate, whose absent probe is
    open for a restart reason that does not apply here), and a malformed persisted hold becomes
    `INVALID_PR_WAIT_HOLD` — present, expired, never satisfied — never `undefined`, because dropping
    it would start the node on its `--after` deps alone. `normalizePendingLaunch`
    (`@shared/pending-launch-shape`) now runs at BOTH serializer seams for the whole held launch: an
    `after` that is not a list used to throw inside the canvas's dep-signature selector; an
    unreadable gate turns the hold `manualOnly` instead of opening it.
  - **Deadline, and the escape.** Default 24h, 1m–14d, refused (not clamped) outside it. Past it the
    node never starts on its own: the badge reads ⚠ EXPIRED (TerminalNode sets its own timer — no
    store changes at a deadline), `list` says EXPIRED, and ▶ / `run` start it anyway (`planRunVerb`
    treats a PR hold like `--after`: the mount does not fire it). Exactly-once is unchanged:
    `launchInFlight` plus clearing `pendingLaunch` on submit.
  - **Refused at arm time, each with its reason** (`resolvePrWaitFor`, resolved ONCE next to
    `issuePre`, against the project the node OPENS in — and only for a caller `issueFlagScope`
    authorizes, since the lookup tells its caller whether a project's board exists): a relay tab; a board not connected to GitHub
    (a cwd-less project says why); no repository or sync not approved on this machine; a full
    `owner/repo#N` in another repository; a number the harvested PR list lacks — only from a WHOLE,
    refreshed snapshot (`lookupPullRequests`), anything less is the retryable
    `after-pr-unconfirmed`; a closed-unmerged PR; `:checks` on a merged PR. A `:merged` wait on an
    already-merged PR is met now and not stored. An SSH project is NOT refused on its own account:
    its board's status is read by this machine's GitHub client like any other.
  - Main (`afterPrFlagRefusal` in its handler) and the Server Edition (`parseControlRequest`) share
    the shape gate: `--run-now` with `--after-pr`, `--pr-deadline` alone, and `open-terminal` without
    `--cmd` (nothing to hold) are refused. The Server Edition then refuses the well-formed flag by
    name (its open allowlist) — it keeps no PR watch, and a silent drop would start the node at once.
  - A node in a project that is not on screen is judged when that project is next viewed (the watch
    follows the live canvas), the same contract as a cold-opened `--after` node. **Downgrade:** a
    build older than this one keeps `afterPr` in the file but ignores it, releasing the node on
    `after` alone. **Kanban / mobile:** the card does not show QUEUED for any held launch (a
    pre-existing gap, not new here); the phone never sees `pendingLaunch`.
  **Success waits (`--after-success`) and `report-outcome`** (2026-09-29). `--after` releases a
  node when every station's TURN ends; a turn ending is not the task succeeding (a station can give
  up, answer its own question or produce something broken, and end its turn cleanly), and #521 only
  catches a turn that ERRORED. So a station says how its task went —
  `report-outcome --outcome succeeded|failed [--note <line>]` — and `open-terminal --cmd` /
  `open-claude` / `open-agent --after-success <id,id> [--success-deadline <90m|12h|3d>]` waits for
  a reported success. Grammar, the persisted shape and the pure evaluation are ONE module,
  `@shared/station-outcome`, used by desktop main's shape gate, the Server Edition's parser AND
  headless factory, and the renderer's launch loop, so the two shells cannot disagree about when a
  dependent starts. `report-outcome --notify-opener` (#1356) also sends the opener one app-written
  notice through `deliverStationNotice`, to the recipient the failure monitor uses (each shell passes
  the same `opener` pair to both); a shell that passes none refuses the flag. It speaks only when
  the outcome the opener last HEARD changes (`StationOutcomeStore.openerHeard` — process-local,
  dropped with the report), never when the previous RECORD had the same outcome: a report made
  without the flag, or whose notice was not sent, told the opener nothing, and a flagged repeat of
  it must still wake the orchestrator. Rules a refactor must not undo:
  - **A success wait is `--after` plus the report.** Every `--after-success` id is FOLDED INTO
    `pendingLaunch.after` (renderer: once, right after `prWaitPre`; server: before `resolveAfter`),
    so the existing rules apply unchanged — the station must exist and report status, the wait rope
    is drawn and deleting it is the escape (`dropAfterDep` now drops the success half too), the
    `--run-now` / `--project` refusals, #521's errored-turn hold. The hold
    (`pendingLaunch.afterSuccess = {deps, deadlineAt}`) adds only "and it reported success". It is
    also the downgrade story: a build that ignores the field still waits for the turn.
  - **One grammar; the ambiguous form is refused by name.** `--after a1:ok` (any `:` in `--after` —
    node ids never contain one) is refused pointing at `--after-success`, not answered "no such
    node"; an id in both flags is refused ("name each station once").
  - **The matrix** (`evaluateSuccessDep`): `failed` BLOCKS (never fires; `list` BLOCKED BY FAILURE,
    badge ⚠ BLOCKED, tooltip names the station and its note); `succeeded` is met once the station's
    turn is over without an error; no report = waiting (no news is never success); a DELETED station
    counts only if it reported success before it went — the one place this differs from `--after`,
    where a deletion is satisfied, because closing a station is how an orchestrator abandons a failed
    attempt. Only a canvas-control agent can run `report-outcome`, so waiting on anything else is
    refused (`successDepRefusal`, checked where `--after` is checked). Deadline: the `--pr-deadline`
    grammar and bounds (`parseWaitDeadlineArg`, one parser for both), EXPIRED badge, `list` EXPIRED,
    ▶ / `run` start it (`planRunVerb` treats the hold like `--after`).
  - **The report is core's, and never read from a git-shared file.** `core/station-outcome-store.ts`
    holds it in MAIN (desktop) / the server process: a renderer reload does not lose it, and since
    the durable-state change an app restart does not either — it is mirrored to the machine-local
    `<userData>/orchestration-state/station-outcomes.json`, BOUND to the session that made it (see
    **Durable orchestration state**). The board-log line (`station-reported`, on the station's own
    card, NEVER_COLLAPSE) is display only — `project.json` and the board log are git-shared, and a
    success anyone can commit would release every dependent. `report-outcome` is verified-only
    (`requiresVerified`) and a node reports only about ITSELF: `--node` naming another node is
    refused (`report-outcome-not-self`), not ignored. The note is display text (`sanitizeOutcomeNote`:
    `oneLine` + format chars stripped, 200 code points) and is never typed into a pane.
  - **When a report ends — the "new task" rule, decided by when work REACHES THE PANE, never by
    when a control answer comes back.** A later report supersedes. Otherwise, "hand a station its next
    task, then open a dependent `--after-success` on it" releases the dependent on the PREVIOUS task's
    success. The first version withdrew the report on the `send`'s ANSWER, which for a busy station is
    `queued` (ok: true) long before the message lands — so the station's report for the task it was
    still on counted, its turn ended, D fired, and the queue flushed the new task on the same idle edge
    (review of #1034). Now:
    - `send` / `reply`: the messaging layer emits `AgentMessagingDeps.onHandover` — `queued` (the
      queue's own `onQueued`, synchronous at the push), `landed` (bytes reached the pane: `delivered`,
      `stalled`, `deliveredToReplacedTarget`, on a first attempt or a flush, `at` = when that attempt
      STARTED), `settled` (one per `queued`: flushed, refused on flush, or expired). The store
      (`StationOutcomeStore.onHandover`) marks a queued station WORK PENDING — its reports publish with
      `workPending` and do not count — withdraws reports older than a landing's start (so a report
      about the new work survives a stalled or late answer), and on a settle that never landed
      withdraws the report too (holding, not the old success; the orchestrator was told it expired).
      Only `send` / `reply` count: a board comment is a person steering and a station notice is the app.
    - `write` / `run`: their answer IS the landing (typed after the confirm; a held launch delivered),
      so `clearOutcomesAfterControl` withdraws reports older than the answer, from each shell's
      control handler (desktop `finishAnswer`, which runs on a late answer too).
    - A new TURN clears nothing (a turn is not a task: a station may report mid-turn, and a person
      typing "thanks" starts a turn), nor does typing in the pane. Closing a station keeps its report
      (the deleted-station rule reads it). Every rule errs toward holding, which the deadline and ▶ end.
    `main/station-outcome-handover.test.ts` replays the review's scenario through the REAL queue and
    fails on the answer-time rule.
  - **Both shells**: desktop main answers the verb before the forward; the Server Edition answers it
    through the same `handleReportOutcome` (`onRecorded` re-runs `refreshArmed`) and honours
    `--after-success` in the headless factory (`successFacts`: the mirror's `done`, the fresh-spawn
    `awaitingFirstWorking` rule, and #521's errored turn from its own event stream, `lastTurnErrored`
    — so a succeeded-then-errored station holds on both editions; the server's PLAIN `--after` still
    does not apply #521, a pre-existing gap). Both wire `onHandover` into their messaging deps and run
    `clearOutcomesAfterControl` on answers.
  - **The badge's deadline tick is a memo input** (`lib/useSuccessWait.ts`): nothing in any store
    changes when a deadline passes, and a timer whose tick the memo ignores re-rendered the node with
    the cached "waiting" — the badge kept QUEUED while `list` said EXPIRED. `useSuccessWait.test.tsx`.
  - Reports survive an app restart, so a station that reported success and was then CLOSED still
    counts for its dependents afterwards; one CLOSED without a success report reads BLOCKED ("closed
    without reporting success") and only ▶ / `run` start that dependent. A station that starts a
    DIFFERENT session loses its report (below). Both agent bodies say so.
    `station-outcome:list` is in `HOST_ONLY_CHANNELS` (unscoped: every project's notes); relay tabs
    take the inert stub. Pinned at source level by `main/station-outcome-wiring.test.ts`. **Not
    done:** a reported `failed` does not raise a station-failure notice to the opener (the opener
    reads BLOCKED BY FAILURE in `list`) — a candidate trigger for `@shared/station-notice`; the kanban
    card and the phone show no outcome (the phone never sees `pendingLaunch`).
  **Headless start (`--run-now`, `run`, #925):** `open-*` with `--run-now` into a project that is
  not on screen starts the new node's held launch at once instead of "when next viewed". A node
  with nothing held (an `open-terminal` without `--cmd`) has nothing to start, and gets the plain
  cold-open reply. `run --node <id> [--project <id>]` builds nothing: it claims and starts the held
  launch of a node that already exists, the CLI twin of the QUEUED badge's Run now (like ▶, a `run`
  that starts the node overrides its `--after` wait). Into a project that IS on screen `--run-now`
  changes nothing: the mount path already starts the node.
  - **Flow.** For `--run-now` the renderer first builds the node as a cold open; `run` starts from
    the node as stored. Either way it then writes an
    `executor:'core', attempted:true, manualOnly:true` claim to disk BEFORE any spawn (never
    spawn on an unsaved claim: a failed save restores the original launch and starts nothing,
    `claim-not-saved`). Desktop main's `pty.launchHeadless` runs core `launchHeadless` on
    `desktopHeadlessRequest(req)`: `createHeadless` (client 0), then settle a fresh shell (200 ms
    quiet / 1.5 s silence cap, under an absolute `SETTLE_MAX_MS` = 5 s ceiling that output never
    extends — nothing cancels this wait, and a pane that keeps painting never goes quiet), then the
    mounted writer's trust rule (`trustsFreshShell`, `@shared/launch-trust`: a fresh session-host
    session is trusted without a probe; every other pane must pass `isLaunchShell`, and an unknown
    answer is `no-shell`, nothing typed), then the echo-verified writer (`@shared/command-delivery`),
    then `releaseHeadless`.
  - **The IPC is desktop-only and host-only.** It is registered in `src/main`, not in core
    `registerIpc`, so a Server Edition browser cannot reach it (ws-bridge declares it
    `unsupported`), and `IPC.ptyLaunchHeadless` is in `HOST_ONLY_CHANNELS`, so a relay peer that
    sends the raw request is refused host-side.
  - **Remote nodes are fenced twice.** The primary fence is the renderer's: `startHeadless`
    answers `remote-unsupported` before any claim for every node of an SSH project (`project.ssh`)
    and for a node carrying `ssh` / `sshRemoteTmux`, and leaves its launch exactly as it was. The
    project is asked, not only the node's flags: a node of an SSH project may carry neither.
    Behind it is core's belt: `headlessPtyOptions` sets `requireRemote` for an SSH-project
    (`sshRemoteTmux`) node, and `desktopHeadlessRequest` keeps it while stripping `sshRemote`.
    So if such a node ever got past the fence, core's `spawnNew` would refuse it (`spawn-failed`)
    instead of starting a LOCAL `nt-<id>` wearing its identity. `desktopHeadlessRequest` also
    strips `viewerId` (a create under a viewer id subscribes `(0, viewer)`, while
    `releaseHeadless` detaches `(0, PRIMARY)`, so client 0 would stay attached forever) and
    `clearEnv` (a one-shot recycle flag, never a launch option).
  - **Why release the client.** An invisible client would fight the viewer's window size and
    keep the session "attached" for the reaper forever.
  - **No persistent backend** (tmux or session-host): releasing a plain shell would kill it, so the
    start fails `not-persistent`. In the normal case that happens before any spawn
    (`persistentSpawnAvailable`). In the race where the backend goes away between that probe and
    the spawn (tmux switched off in between), the spawn yields a plain shell; the launcher refuses
    it the same way, before typing anything, and its release kills that shell. Either way the node
    is handed back exactly as it was, so a cold open degrades to an ordinary queued node.
  - **Outcome patch.** It lands wherever the node lives at that moment (`savePendingAnywhere`):
    the live canvas if the user switched there mid-start, otherwise the store copy plus a disk
    write. `delivered` clears the launch; `not-persistent` restores the original (above); every
    other launch failure keeps the claim and marks the node failed (amber ⚠ QUEUED, recovered by
    Run now).
  - **While starting.** `launchDelivery` holds `starting`: the badge reads STARTING, ▶ is disabled
    (a click would splice a second copy into the pane), `launchesToFire` skips the node, and
    `list` names it. Canvas's delivery sweep spares it (`deliveriesToRetire`): the node lives in
    ANOTHER project by design, so "not armed on this canvas" does not mean "delivered".
  - **Notice.** A batch that started at least one session raises ONE sticky "Go there" notice
    (`headlessStartNoticeText`). A launch failure after the claim (`spawn-failed`, `no-shell`,
    `line-too-long`, `cancelled`) shows on the badge (amber ⚠ QUEUED) and in the reply.
    `not-persistent`, `claim-not-saved` and `remote-unsupported` show only in the reply: the node
    reads as it did before the attempt.
  - **`--run-now` with `--after` is refused on both editions**, before any node is built, with the
    shared `RUN_NOW_AFTER_REFUSAL` (`@shared/control-verbs`): "start now" and "start when X is
    done" contradict each other.
  - **`run` gates.** `run` is verified-only (`requiresVerified`), reaches another project only
    through `--project` + the existing grant gate (`PROJECT_TARGETABLE_VERBS`), and is
    `stored-node` off screen. The renderer's `--project` belt is ONE pure resolver,
    `resolveProjectTarget` (`lib/projectOpen.ts`), shared with the open verbs. A project ON screen
    never starts headless (`planRunVerb`): `run` there uses the mounted writer (the ▶ path) when
    the node has one. Without one, a plain queued launch replies `queued` / `starts-when-mounted`,
    because the mount delivers it; a `manualOnly` or `--after`-armed launch is refused with
    `run-not-mounted`, because the mount fires neither, and "starts when mounted" would be a
    promise nobody keeps.
  - **Server Edition.** It accepts `--run-now` as a no-op (its opens are already immediate) and
    implements `run` under creator ownership, resolving the node through the ownership record,
    never by first id match. It neither unhides a closed project nor raises a notice, the same as
    its other immediate opens. Its immediate open delivers through the same launcher with
    `release:false`: the attached client is what keeps even a plain shell reachable there.
  **Settings (`settings`, 2026-09):** `settings [--project <id>]` lists, `settings --get <key>`
  reads, `settings --set <key> --value <v> [--project <id>]` asks to change — flags only, because the
  shim drops a positional sub-action for an unlisted verb and an SSH host can still be running an
  older shim. The pure `@shared/settings-verb` is the whole rule set, shared by the desktop dispatch, the
  Server Edition and main's `parseControlRequest`: an **allowlist** (`agentMessaging` per project;
  `snapToGrid`/`gridSize`/`defaultNodeWidth`/`defaultNodeHeight` machine-wide, bounds = the UI's) with
  a required `why` per entry, and a **forbidden set + name pattern that outranks it** (permission
  modes incl. `bypassPermissions`, `hookIdentityStrict`, `agentBrowserControl`, accounts/credentials/
  gateway/launch commands, telemetry, keybindings, confirm waivers, `capabilityAck`) — the test walks
  the table against both. Four load-bearing rules: (1) **every `--set` confirms**, and `settings` is
  in `DESTRUCTIVE_VERBS` (one dialog at a time) but NOT in `CONFIRM_WAIVABLE_VERBS` — no waiver of any
  scope, bypass included, answers for the user (`control-destructive.test.ts` pins no `waiveVerb`/no
  `controlConfirmDecision` in its block, and the write only on the confirm leg). (2) A capability read
  is the **grant** (`projectCapabilityGrantedFor`), never the file bit, and a capability write goes
  through `applySettingsChange` → the UI's own `setProjectCapability` (flag + `'kept'`), pinned by
  `settingsVerb.test.ts` comparing the two resulting projects. (3) Verified-only (`requiresVerified`)
  and `--project` is own-or-granted via `PROJECT_TARGETABLE_VERBS`/`gateProjectTarget`. (4) **Server
  Edition refuses every `--set` by name** — its headless opt-in (#537) is not consent to grant
  capabilities, and there is no dialog; `--get` answers from `capabilityProjectFor`, own project only.
  Mobile: N/A (the phone issues no control verbs).
  **Agent messaging's MACHINE DEFAULT (`settings.agentMessagingDefault`, 2026-09, ships OFF).** A
  project whose `.nodeterm/project.json` carries NO `agentMessaging` value is answered by this
  machine's settings.json; the rule is ONE function, `projectCapabilityEffective`
  (`@shared/project-capability-consent`), and `projectCapabilityGrantedFor` now REQUIRES the
  defaults argument so a consumer that forgot it fails to compile instead of reading every
  unconfigured project as off while Settings reads it as on. Four rules: (1) an explicit `true` still
  needs this machine's `'kept'` — `needsCapabilityNotice` is untouched and stays keyed on an explicit
  `true`, so a cloned file still notices and a project on only by default never does; (2) OFF is now
  WRITTEN — `setProjectCapability(…, false)` stores a literal `false` for a capability in
  `CAPABILITY_MACHINE_DEFAULTS` (browser control has none and still deletes the field), because
  absence now means "use the default"; `readProjectCapabilities` carries that `false` through the
  file; (3) an ABSENT field with a recorded `'declined'` stays off — that is how every pre-default
  build wrote "off", and a user's explicit no must not be undone by a default switched on later;
  "Use this machine's default" (`resetProjectCapabilityToDefault`) therefore clears the field AND the
  answer; (4) the default is forbidden to the `settings` verb (a grant over every project, clones
  included). **This does not trip the `project-capabilities.ts` header's trigger**: the notice is not
  dropped, and what the default answers is absence, whose value lives in machine-local settings.json.
  **Why it ships OFF:** `core/agents/pane-ownership.ts` records a pane's owner only on a FRESH spawn,
  so after an app restart or update every surviving pane is `unproven-target-owner` and refused —
  "on by default" would be false after every restart. The flip is a separate one-line change that
  waits for a cross-restart ownership proof (#659's signed record is the candidate). Settings →
  Agents shows the machine switch, and the per-project row is a three-way choice (default / on /
  off) plus "On in <project> (this machine's default)" — a two-position switch cannot draw absence.
  Downgrade: a pre-default build writes `false` back as a deleted field, which this build then reads
  as "use the default". Server Edition reads the same grant from its own settings.json; Mobile: N/A
  (the phone has no capability switch).
  **Review panel (`verify`, 2026-07):** `verify --node <id> [--lenses …] [--focus …] [--agent …]
  [--synthesis off]` opens one reviewer per LENS, each armed behind the target (`--after`) and
  bridged to it, wrapped in a `Verify: <title>` group, plus a judge armed behind the whole panel.
  It is **composition, not new machinery** — the two primitives above are the whole implementation.
  Prompt/lens logic is the pure, unit-tested `renderer/lib/verifyPanel.ts`; two wordings there are
  load-bearing and must not be "tightened away": reviewers are told **not to edit** (a panel is N
  agents pointed at ONE checkout — review and repair are different jobs, and only repair needs
  worktree isolation) and are explicitly **licensed to find nothing** (a reviewer under implicit
  pressure to produce findings invents them, and an invented finding costs someone else the time to
  disprove it). Unknown lens words are **kept** with a generic brief, not rejected — a table that
  only accepts what it already knows would be useless for the review nobody anticipated. Reviewers
  inherit the TARGET's `accountId` (its transcript resolves inside that account dir), not the
  caller's. The judge is armed on ids that exist only in that tick, which is why `armAfter` takes
  `extraLive` — without it the reviewers would look *deleted*, deletion counts as satisfied, and
  the judge would fire before a single review existed.
  **Station-failure notices (2026-09, `src/core/agents/station-notice.ts` + the pure
  `@shared/station-notice`):** when a station an agent OPENED stops, that agent is told ONCE,
  with its options (retry or wait / reassign / skip / stop), instead of having to poll `list`.
  Load-bearing rules:
  - **The trigger is a closed table (`STATION_TRIGGERS`), first match wins:** `dropped` (the
    renderer's DROPPED verdict, about a station core does not know to be mid-turn or asking),
    `turn-errored` (a verified `done` carrying `errored`; a verified new turn OR a clean `done`
    retires it — it describes the LAST turn), `question-unanswered` (the status mirror still holds
    the station's correlated `pendingQuestion` 15 min after the verified event that asked it,
    `STATION_QUESTION_NOTICE_MS`, AND the recipient's own verified state is `done`). An unknown
    never triggers, and only VERIFIED events move a station: a notice leads an orchestrator to
    retry, reassign or END a workflow, so a forgeable event is not evidence. 15 min because the
    human already got NEEDS YOU + a notification; an orchestrator reassigning seconds before the
    user answers doubles the work.
  - **A permission prompt is NEVER a trigger, and that is a measurement, not caution.** On the main
    thread Claude paints its dialog CONCURRENTLY with our held hook (docs/hook-reply-approvals.md),
    and an approval given in the pane fires nothing until the approved tool FINISHES — so neither
    `blocked` nor a `pendingId` can tell "unanswered" from "approved, twenty-minute build running",
    and a notice there invites the orchestrator to close a working station. A question can be told
    apart: its answer is a tool result, and the mirror's `pendingQuestion` is held across unrelated
    traffic until it arrives. The monitor reads it through `pendingQuestionOf` (required dep)
    rather than re-deriving it.
  - **Once per episode, re-armed ONLY by a successful turn** — a turn that started after the notice
    and ended `done` with no error, no interruption and not the idle-prompt rescue — and the re-arm
    clears every fact the episode was about (error, DROPPED, question), or the next sweep re-fires
    it. The condition merely clearing does not re-arm: a usage-limited station fails again on
    every retry, and re-notifying each time would be a loop that burns the orchestrator's turns
    all night. The notice says so in its own text.
  - **Core withdraws DROPPED itself, on ANY verified hook event from the node** (the CLI speaking
    from inside the pane — the renderer's own self-heal in `agentStatus.setState`). It must not
    wait for the renderer's `reportDropped(false)`: the renderer's record of what it reported and
    its transient flag both die with a reload (⌘R, a Server Edition tab closing), and a verdict
    nobody withdraws re-fired on the healthy station after its next successful turn — typed into
    the orchestrator with "reassign: close it" as an option (the independent review's blocker).
  - **The recipient is the OPENER, and a rope alone cannot name it.** An `--after` station is roped
    to every station it waited on as well as to its opener, with the same `ctrl-<src>-<dst>` id, so
    "the other end of the rope" can be a sibling that opened nothing. The open verbs therefore
    STAMP `data.openedBy` where they draw the opener's rope (`connect` for the live paths —
    addAndConnect, verify, spawn-team — plus the off-canvas and cold-open writes; pure helper
    `lib/stationOpener.ts`), and `stationRecipient` requires BOTH: `openedBy` names a canvas-capable
    agent node in the same (single) project, AND that node's OPENER rope to the station still
    exists — never a `ctrl-after-` wait rope (deleting the rope detaches the station). Never a bridge-linked node. `openedBy` is git-shared,
    so `safeOpenedBy` (`isSafeNodeId`) runs at both serializer seams, and a duplicate drops it. A
    node opened before this build has no `openedBy` and is never attributed (no guessing).
  - **Server Edition: the creator LEDGER is the recipient rule** (`stationRecipientFromOwner` over
    `factory.openerOf`) — only stations opened during the current server run, the same creator rule
    as every other verb there; a restart clears it.
  - **Two legs.** The canvas leg needs no switch: a `station-failed` board-log line on the
    RECIPIENT's card (`from` = station id, `to` = reason code, `title` = the capped one-line
    title; in `NEVER_COLLAPSE`) and a STATION FAILED chip (`components/StationFailedChip.tsx`, one
    component on the node header and the card modal; the tooltip says whether the pane leg landed,
    so "stayed on the canvas because messaging is off" is visible). The pane leg is
    `deliverStationNotice` = the messaging service's WHOLE gate chain (scope, the per-project
    `agentMessaging` switch — off by default ⇒ canvas only — runtime pane ownership, flow limits,
    idle gate + deliver-on-idle queue, receipt, trace) under an internal verb
    `STATION_NOTICE_VERB` that is deliberately NOT in `AGENT_MESSAGE_VERBS`, so neither the IPC
    guard nor the shim can ask for a notice with a body of its choosing. The pane leg is followed to
    its END so the chip never says "queued" about a message that landed or lapsed: a queued
    notice's flush or expiry comes back through `AgentMessagingDeps.onQueuedResult` (called from
    `createDeliveryQueue`, read at call time). Two outcomes get exactly ONE more attempt, each
    because it would otherwise lose the pane leg for a reason unrelated to the notice:
    `rateLimited` (the station `send`s its result, then errors seconds later — the pair budget is
    spent) retries after the limiter's wait, capped at 60 s; an expiry (the orchestrator stayed busy
    past the queue's 5-min TTL) is offered again on the orchestrator's next verified `done`. Two differences from
    `send`, both because the APP is the author: the body is `stationNoticeBody` (fixed text from
    the table; the only station-influenced string is the title, `oneLine`d, capped at 80, quoted,
    and labelled data — NO station output is ever quoted), and the Server Edition's creator check
    runs reversed (`callerOwnsTarget(recipient, station)`). The pane leg honouring the switch is
    deliberate: the app typing into an agent's session is the capability that switch grants.
  - **DROPPED is the renderer's fact** (it needs `hibernated`/`paused`), forwarded as EDGES by
    `lib/stationNoticeWiring.ts` over `stationNotice.reportDropped`; the monitor never measures a
    pane. Both request channels are in `HOST_ONLY_CHANNELS`: a relay guest never measured the
    host's panes (its tab takes the inert stub), so a raw DROPPED report from one is a spoofed
    verdict, and `station-notice:list` is unscoped — every project's failed-station ids and titles
    — which a guest bound to one project must not read. It is therefore only as available as the liveness check, which asks for WATCHED nodes:
    a station that dies off screen is noticed when it next comes into view, and a Server Edition
    with no browser tab attached reports no DROPPED at all. Widening the check to unwatched
    stations costs one pane read per finished station per 30 s (an ssh exec on SSH projects) and
    is a deliberate follow-up, not an oversight.
  - **Both shells wire it and nothing type-checks that:** desktop main feeds
    `stationNotices.onAgentEvent(enriched)` from `emitAgentStatus`; the server's canvas-control
    `onAgentEvent` feeds its own monitor; both call `registerStationNoticeIpc`. Pinned at source
    level by `main/station-notice-wiring.test.ts`, along with every stamping site. Relay tabs take
    the inert stub (a relay tab's stations are the host's). Mobile: N/A — the notice reaches the
    orchestrator's pane, which the phone's chat view already shows.
