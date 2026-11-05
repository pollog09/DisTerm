# Canvas control: verbs, routing and confirms

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Canvas control: verbs, routing and confirms

- **Canvas control (manage-nodeterm-canvas)** — agents in `CANVAS_CONTROL_CAPABLE`
  (claude/codex/gemini/copilot/opencode/grok) can create/organize/control canvas nodes from inside their
  session: a POSIX **sh+curl** shim (`nodeterm.sh`, `CONTROL_SHIM_SCRIPT` in
  `core/canvas-control-core.ts` — the Electron-as-Node CLI is retired) POSTs
  **form-urlencoded** (`nodeId` + `arg.<flag>` fields; `curl --data-urlencode` is the only
  escaping sh can be trusted with — `parseControlBody` reads both this and the JSON dialect) to
  the hook server's `/control/<verb>` routes; `Accept: text/plain` makes the server render the
  reply (sh has no JSON parser). Env-gated on `NODETERM_CANVAS_CONTROL` (set by
  `buildPtyEnv`/`remoteHookEnvArgs` per `canControlCanvas`). Discovery (since #744): EVERY
  consented agent gets `skills/manage-nodeterm-canvas/SKILL.md` in its OWN skills dir — claude's
  config dir (+ each local managed/linked account dir), `$CODEX_HOME/skills`, `~/.gemini/skills`,
  `$GROK_HOME/skills`, `$COPILOT_HOME/skills`, opencode's `<config>/skills`; on an SSH host claude's
  dir and `~/.agents/skills` (read by codex, gemini, opencode, grok — measured — and copilot,
  documented). The marker blocks (`<!-- nodeterm:manage-canvas:start/end -->`) in AGENTS.md /
  GEMINI.md / copilot-instructions.md are no longer written and an older build's copy is STRIPPED;
  see **Agent-integration consent** under Agent support.
  **Server creator ownership (2026-08 incident hardening):** enabled Server control accepts only
  verified node identity. `HeadlessNodeFactory` records which source node opened each new node in a
  process-local ledger; link/group/rename/color/sticky-update, message delivery, and close validate
  the whole target set as current-run creations before writing or killing anything. Queued messages
  revalidate creator ownership before flush. The ledger is intentionally empty after restart —
  project JSON, titles, hook history and tmux names are not creator proof — so
  boot neither attaches/creates backends nor sends persisted queued commands. A live backend with a
  durable arm remains untouched until an explicit owner action or browser view. `open-terminal` and
  `open-agent` are verified-only at the Server handler boundary. A plain terminal keeps generic
  node hook wiring but receives neither `NODETERM_AGENT_ID` nor `NODETERM_CANVAS_CONTROL`; missing
  identity never defaults to Claude.
  **Windows hosts**: a PowerShell/cmd-run agent cannot type `sh "<shim>"`, so a win32 core also
  writes `nodeterm.cmd` / `context.cmd` beside the shims (`syncWindowsShLauncher` — finds Git for
  Windows' `sh.exe`, passes `%*` through, fails LOUDLY without it) and the skills, the connect-time
  note and the verify prompts say `& "<shim>.cmd"` for every agent outside
  `POSIX_TOOL_SHELL_ON_WINDOWS` (claude only — its Bash tool is Git Bash). The dialect is
  `shimDialectFor(agent, <the shim-owning core's platform>)` (`shared/agents/shim-invocation.ts`;
  `context-link:info` now reports that platform); every builder defaults to POSIX, so SSH-host
  skills and macOS/Linux bodies are byte-identical.
  **SSH projects** (docs/ssh-agent-skills.md): the SAME shim + skill + blocks are put on the
  remote host and KEPT current by the agent-tools check (`RemoteHooks.refreshAgentTools`: on every
  connect and tunnel repair, rewriting only what differs from this build, managed-account skill
  dirs included — see "An SSH host's agent tools are CHECKED" under Agent support; an account's
  skill is also written when the account is added), gated on the VERIFIED reverse hook tunnel — the shim
  carries no machine-specific paths and POSTs through the tunnel's unix socket, so remote agents
  control the desktop's canvas. The shim is generated source no compiler checks:
  `canvas-control-shim.test.ts` runs it for real (/bin/sh against a real hook server, port AND
  unix-socket transports) — keep it that way.
  **NO VERB MAY ACTIVATE A PROJECT TAB** (`src/shared/control-off-screen.ts`). Routing is by
  SOURCE — the request names the agent's own node, and the dispatch must find the canvas that owns
  it — so for years "that canvas is not on screen" was answered by `travelToProject`. The user was
  typing in project B; a background agent in project A issued a `close`; the tab switched and A's
  saved viewport was applied. Their focus, camera and typing context were taken by a call they did
  not make. Two carve-outs (the cold open for `open-*`, then the display verbs) were each written
  as if it were the last, because nothing walked the whole table — twenty-one verbs still
  travelled. Every verb now has a decided disposition and NONE of them is travel:
  `STORE_ANSWERED_VERBS` (no canvas at either end), `COLD_OPENABLE_VERBS` (a session node, armed
  and inert until shown), `OFF_CANVAS_VERBS` (a display node, complete when written),
  `STORED_NODE_VERBS` (`write`/`close`/`rename`/`color`/`link`/`board`/`assign` — each reaches a
  pane, a store writer or the board file — plus the five layout verbs
  `group`/`ungroup`/`move`/`arrange`/`align`), and `OFF_SCREEN_REFUSALS` (the six that genuinely
  need live React Flow, each with its own reason in the refusal the agent reads). A refusal an
  agent can act on is strictly better than hijacking someone's screen. **The layout verbs off
  screen lay out from PERSISTED sizes** (nothing there was measured; a node is born at a persisted
  default size and a user resize is persisted too, so the gap is at most the overlap a live canvas
  can already show) and write back through `commitCtlNodes` → `geometryMutations`
  (`renderer/lib/storedGeometry.ts`): only the geometry that changed (`position`/`size`/`parentId`/
  `group`) is patched onto the STORED node, a created frame is added whole, only a frame is ever
  removed, and the batch lands in one `applyOwnNodeMutations` re-sorted parents-first. Never write
  the hydrated array back whole: that round-trips every node through the serializers. They were
  refusals until 2026-09-30; an orchestrator that could open a team off screen but never frame it
  was the report that moved them. Load-bearing details:
  (1) **`ctlNodes()` is the one name for "the node array this call acts on"** — on screen it is
  `nodesRef.current` verbatim, off canvas it is the owning project's serialized nodes hydrated by
  `nodeStatesToFlow`. A verb body that resolves `--node` against the live array while answering
  for another project does not throw and does not travel; it silently renames, closes or reports
  on whatever the human happens to be looking at. `control-stored-node.source.test.ts` pins that
  no stored-node case mentions `nodesRef.current`. (2) **`board`/`assign` read `ctlProject`, not
  `activeProjectId`** — a second bug that was hiding behind the first, invisible while the travel
  made the two projects the same. (3) **`closeStoredNodes` is the ONE cross-project teardown**,
  shared with the sessions sidebar's `closeSession`; it is `deleteNodes` minus the closed-session
  ledger and ⇧⌘T history, which `deleteNodes` files against the ACTIVE project. `close` still ends
  the session off canvas because `transport.destroy` resolves a REMOTE node's host from the
  persisted index with no live client (`core/remote-end.ts`). (4) **There is no
  `travelToProjectRef` and there must not be one again**; `travelToProject` survives only for the
  facepile, the user's own navigation. (5) **The regression guard is
  `test/acceptance/control-verb-disposition.test.ts`**, cross-layer on purpose: it walks MAIN's
  `VERBS_FOR_TEST` against the RENDERER's disposition, which is the only way "every verb" is a
  checked claim rather than a list kept by hand. That is what nobody had, and why two carve-outs
  could ship without anyone noticing the other twenty verbs.
  **Keep the agent-facing text in sync with behaviour, in the SAME PR.** The verb help agents
  actually read is generated by `buildCanvasSkillBody` (the SKILL.md, rewritten into every config
  dir by `installCanvasSkillInto` on launch) and `buildCanvasControlInstructions` (the
  codex/gemini/copilot/opencode marker block — NOT INSTALLED since #744, its parity tests are what
  keep it; every agent now reads the skill) — both in `canvas-control-core.ts`. When you add or
  rename a verb, change a flag, or change what an outcome MEANS (e.g. PR 7 turned a busy target's
  `targetBusy` refusal into a deliver-on-idle queue), update those two functions in the same change,
  or the docs describe a product that no longer exists and an orchestrating agent acts on the stale
  contract. Derive from the code, never re-type: the retry guidance renders from `RETRYABLE`
  (`messagingGuidanceLines`) so a new outcome kind lands in the text the day it is added, and the
  off-screen paragraph renders from the verb table itself (`offScreenGuidanceLines`, which is why
  that table lives in `src/shared` — core cannot import the renderer) — prefer that shape over
  prose you have to remember to edit. `canvas-control-core.test.ts` walks both
  generated bodies and must red on the stale claim (it pins the queue wording and the RETRYABLE
  split); a doc line with no such test is a plan, not a fact — see the drift that shipped as #269.
  **Flag syntax**: `--flag value`, `--flag=value`, or a valueless flag anywhere on the line. The
  shim used to consume the next token after any `--flag` *unconditionally*, so `--read --node b1`
  became `arg.read=--node` with `b1` silently dropped and the server answering about the wrong
  flag; it now peeks. The trade: a value that itself starts with `--` must use the `=` form
  (`--cmd=--version`), which was previously unexpressible in either direction. Two parsers are in
  play and both are tested — the sh loop (`control-shim-parse.test.ts`, real `sh` + a fake `curl`
  that records argv) and `parseControlBody` reading what it built (`canvas-control-shim.test.ts`).
  **A new verb must still not DEPEND on the fix.** The shim is rewritten locally at every app boot,
  and an SSH host's copy is checked on every connect and brought to this build's bytes, so an app
  update reaches the host on the first connect after the relaunch. A host can still run an older
  loop for a while: while its tunnel is down (nothing is installed through a dead tunnel), when the
  file is unreadable (never written over), or while a second desktop on an older build shares the
  host account (it rewrites its own copy on its connects; ours returns within the hour). Nothing
  on the wire says which loop is running. Give every flag a value and both loops agree.
  **A retried call must not open a second node (`--request-id`, `core/control-request-ledger.ts`).**
  The reply to an open can be lost while the open went through — the agent's own tool call is
  killed (~2 min for a Bash tool call while a slow host holds the POST), the ssh tunnel drops
  mid-reply, or the shim's endpoint walk re-posts after a transport that failed AFTER the request
  was read — and the agent's natural retry used to open a second agent, team or worktree. The
  verbs that create something (`REQUEST_ID_VERBS`) take `--request-id <id>`, and the shim also
  sends its own `requestId` form field, generated once per RUN (`od` of `/dev/urandom`, else
  pid+time), on every POST of that run, so its own re-post is covered for an agent that never read
  the docs. Rules a refactor must not undo: (1) **the ledger lives in the hook server's `/control/`
  route** (core), the one place desktop main's forwarder and the Server Edition's
  `createServerEditionControlHandler` both sit behind — putting it in either shell's handler
  leaves the other without it; (2) rows are keyed **(verified caller node, id)** only — an
  unverified caller gets no dedupe rather than a shared bucket, and an explicit id from one is
  answered with `REQUEST_ID_UNVERIFIED_NOTE`; (3) the row is **claimed before the handler runs**,
  synchronously after the lookup, so two concurrent POSTs cannot both run; (4) a fingerprint (verb
  + args minus the id, key order ignored) makes the same id with a different call a
  `request-id-conflict`; (5) a settled row stores the WHOLE reply and a replay returns it (text:
  a `replayed:` first line; JSON: `replayed: true`) — a refusal included, so an id never runs
  twice; (6) a handler that cannot say whether its effect happened answers `indeterminate: true`
  (desktop main's 120 s wait, now `src/main/control-forward.ts`: the renderer is not cancelled, and
  an `open-worktree` whose `git worktree add` outlives the wait still completes) or throws, and the
  row becomes UNKNOWN — refused, never re-run; the forwarder hands a late renderer answer back via
  the handler's `onLateAnswer`, and settlement only moves up (unknown → answer, never the reverse).
  **A late answer is finished exactly like an on-time one**: everything main does with a renderer
  answer (the `open-browser` ownership claim, `browser-open-claim.ts`; the `open-project` grant) is
  ONE `finishAnswer` step the forwarder runs on whichever answer arrives — replaying a late
  "opened browser b1" without the claim told the agent it had a browser it could never drive. And
  **an indeterminate reply names its id**: the route adds a `request id: <id>` line saying to pass
  it back as `--request-id <id>`, and the in-flight/unknown refusals spell the flag with its value —
  the shim's per-run id is otherwise never seen, so "retry with the same --request-id" sent agents
  to re-run the bare command, get a fresh id and open a second one. That reply is not enough on
  its own: an agent's tool call is typically killed at 120 s — the SAME instant the app gives up —
  so the shim also prints the per-run id to stderr BEFORE posting an open it carries no caller id
  for (`requestIdAnnounceLine`, skipped for a caller's own `--request-id` and for `--dry-run`), and
  both agent bodies say to pass an OWN unique id up front for slow opens (open-worktree,
  spawn-team, verify) with a tool timeout above 120 s. A `finishAnswer` step that throws never
  escapes into the IPC listener: on time it resolves indeterminate, late it hands nothing back (the
  row stays unknown);
  (7) an explicit id on a verb outside the set is REFUSED (`request-id-unsupported`), like
  `--dry-run` — an agent believing its `write` is protected when it is not is the failure the flag
  exists to end — while a malformed or out-of-set per-run id is silently ignored; (8) a dry run
  neither claims nor replays. The ledger is **durable** (24 h, 256 per caller, 4096 in total,
  in-flight rows never evicted), mirrored to `<userData>/orchestration-state/control-requests.json`
  and loaded by `hookServer.start()` in both shells: a retry after an app restart replays the reply,
  a row IN FLIGHT when the process ended comes back UNKNOWN (refused, never re-run), and unknown
  stays unknown — see **Durable orchestration state**. (It used to be process memory, on the theory
  that a restart between the effect and the retry was too rare to pay for; measured, the cost is
  small — below.) The timeout sentence is verb- and claim-aware (`controlTimeoutError`): only a
  confirm-gated verb, whose dialog dismisses itself at the same deadline, is still called "safe to
  retry"; a call with no ledger row (no id, or an unverified caller) is told to check the canvas for
  its effect before retrying, never pointed at a flag it has no value for. Ids suggested to agents
  must be UNIQUE (a uuid — `$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)`, since slim
  Linux lacks `uuidgen` and macOS lacks `/proc` — or a readable name with a random part): rows are per node for 24 h, so a
  later conversation in the same node reusing a readable id for the same call would be answered
  with the earlier reply. An SSH
  host gets the new shim at its first connect after the update (the agent-tools check,
  `RemoteHooks.refreshAgentTools`); until then — or while its tunnel is down — its runs carry no
  per-run id (an explicit `--request-id` still works through the old loop). Agent-facing text
  is rendered from `REQUEST_ID_VERBS` / `REQUEST_ID_RETRYABLE` / `REQUEST_ID_OUTCOME_GLOSS`
  (`requestIdDocLines`). Tests: the ledger alone, the route (both dialects, in flight, conflict,
  late answer, throw), the Server Edition handler behind it, and the real shim under `/bin/sh`
  through a proxy that forwards the request and drops the reply — the re-post case, red before.
  Deliberately NOT in the set: reads (a replay would serve a stale snapshot, and `browser
  --cookies` would sit in memory for a day), the idempotent-by-nature verbs, and the
  human-confirmed / rate-limited ones (`write`, `send`, `settings`, `report-issue`) — widening it
  to those is a separate decision.
  **WHICH CANVAS ANSWERS, and why an open never moves the camera** (`renderer/lib/controlRouting.ts`
  + `renderer/lib/coldOpen.ts`). React Flow holds only the ACTIVE project's nodes, but every other
  open project's tmux sessions keep running, so a control call routinely arrives from a node the
  live canvas has never heard of. `routeControlSource` resolves the OWNING project
  (`active | switch | reopen | blocked | unknown`) — before that, every agent outside the project
  the app happened to come up on was rejected as *"source node is not a control-capable agent"*,
  which is a capability sentence for a routing failure. **That fix must not regress.** What it
  originally did with the answer was TRAVEL there (`travelToProjectRef`), and that was a screen
  hijack: the user looks at project B, an agent in project A runs `open-claude`, the tab switches
  and A's saved viewport is applied, so the camera appears to jump and zoom on a background agent's
  say-so. THREE membership lists now decide, and their differences are the whole design:
  - `STORE_ANSWERED_VERBS` (`needsLiveCanvas` false) = **no canvas is needed at either end** —
    `list` reads names, `send`/`reply` deliver into a tmux PANE, `sticky` rewrites a note,
    `open-project` acts on the projects store.
  - `COLD_OPENABLE_VERBS` (`canColdOpen` — `open-terminal`/`open-claude`/`open-agent`) = **a canvas
    IS needed, but the serialized one will do.** `needsLiveCanvas` stays TRUE for them; they take
    the `--project` cold-open path (issue #338 §2.2) applied to their own project: the composed
    launch MOVES into `pendingLaunch` (`armForColdOpen` — `initialCommand` is never serialized), the
    node is upserted through `applyNodeMutation`, edges go through `appendCanvasLinks` (the edge
    counterpart, so the opener's rope and the fan-in bridge are not lost), `writeDisk` persists, and
    the reply is the ONE shared `coldOpenMessage` sentence with `queued: true`.
  - `OFF_CANVAS_VERBS` (`answersOffCanvas` — `show-image`/`show-video`/`show-web`/`open-browser`)
    = **a canvas is needed, the serialized one will do, and there is nothing to defer.** The node
    these make has no session behind it: a page, a video, an image, a browser node is inert
    wherever it sits, so writing it into the owning project's serialized nodes IS the whole effect
    and it is complete when `writeDisk` returns. That is why it is a third set and not four more
    entries in the second one — a cold open reports `queued: true`, and a caller told its
    screenshot is queued waits for something that already happened. It gets
    `offCanvasReplyClause` and `offCanvas: true` instead. **This was the half the cold-open fix
    left open, and it is the half an agent meets most often**: a skill that renders its report as
    HTML reaches for `show-web` every time it finishes, and every one of those calls used to yank
    the user out of the project they were typing in. The verb bodies are untouched; three things
    they read from the canvas are staged — the colour index (`nodeCount`), the placement source
    (the stored node, hydrated through `nodeStatesToFlow` so its shape cannot drift from a live
    one's) and the append, where `applyNodeMutation` + `appendCanvasLinks` + `writeDisk` replace
    `setNodes` + `connect` + `markDirty`. The opener's edge is a **rope** and only a rope: a
    display node has nothing to read, so a bridge there would grant a context link the live path
    never draws. **`ctlProject` resolves from the SOURCE's project**, not the active one — off
    canvas it decides the ssh flag, the browser session key and the media allowlist route; on
    every other path the travel has already made the two the same project. None of the four takes
    `--group`, which is why this set owes no worktree question; a verb joining it that does would,
    because `cwdForNewNodeIn` subtracts `staleGroupIds`, which is epoch-scoped to the ACTIVE
    project.
  Everything else keeps travelling **on purpose**: `write`/`close`/`group`/`move`/`arrange`/
  `align`/`verify`/`spawn-team`/`open-worktree` read live canvas state the serialized copy does not
  carry (measured node sizes, worktree staleness, the React Flow edge arrays). **`browser` is the
  pair worth stating beside `open-browser`**: it NAVIGATES a mounted `<webview>` guest, which
  exists only while its project is on screen, so it travels; `open-browser` merely places the node
  and its guest is created when that project is next shown, exactly as a cold-opened terminal's PTY
  is. Route `active` is byte-identical to before.
  **The human is told, once, in the other voice.** The reply goes to the agent; without a strip the
  person sees nothing at all, and the whole point of not travelling is that the choice to go and
  look stays theirs — a choice they can only make if they are told there is something to look at.
  `offCanvasNoticeText` names the project and the button is `travelToNode` (which reopens a closed
  project first and resolves off the SERIALIZED nodes the write has already made). It is **sticky**:
  every other info strip reports something the user just did and is watching, this one reports work
  that landed while they were busy elsewhere, and once it fades nothing anywhere says it happened. Route **`reopen` (a CLOSED project) cold-writes
  too and does NOT reopen the tab** — closing is the user's explicit "park this, keep it running", so
  restoring the tab *and* activating it is the loudest form of the hijack; the reply names the closure
  so a caller does not report a session as started. **Exception (#925):** `--run-now` (and `run`)
  restores a closed project's tab WITHOUT activating it (`unhideProject`) and starts the node
  headless. A session that is running must be findable somewhere more durable than a notice, and
  not activating it keeps the half of this rule that matters. Two cases keep the tab closed: an SSH
  project, because its nodes are refused before any claim (`remote-unsupported`), so nothing starts;
  and the welcome screen (no project active), because un-closing one there would render a canvas
  with no active project. On the welcome screen the session still starts; the project just stays in
  Recently closed.
  On the cold path `--group`/`--after` ARE resolved
  (unlike with `--project`, where the ids would live in another project) against the serialized
  nodes, defaults come from the OWNING project (`projectPermissionMode(owner, …)`, its account,
  its `ssh`), and `--after`'s dep ropes are left to `missingDepRopes` at that project's next load.
  **The destructive confirm, and who may waive it** (`@shared/control-confirm`, 2026-09). The
  dialog `write` / `close` / `open-project` raise is the ONLY place a human stands between a
  canvas-control agent and the workspace — per-node identity is not enforced until
  `NODE_IDENTITY_STRICT_AFTER`, so a `legacy` caller still reaches the dispatch — and it used to
  ask EVERY time with no way to say "yes, all of them". Closing 14 finished stations was 14
  dialogs, and the 15th request was refused with `a confirmation is already pending`. Three things
  changed, and the last one was the actual bug:
  - **`close --node a,b,c` is ONE dialog** (`lib/closeTargets.ts`, pure). The grammar is not new —
    the Server Edition's headless `close` has read a comma list since it shipped, including its
    "validate the whole list before killing anything" rule; the DESKTOP dispatch read the flag as
    one id, so a comma list called `deleteNodes(['a,b,c'])` (a no-op) and answered `closed a,b,c`.
    A destructive verb reporting success for work it did not do is worse than either doing or
    refusing it. The single-id form is bit-identical, **deliberately including its lack of an
    existence check**; the bulk form refuses the WHOLE list on an unknown id and names it, because
    with 14 ids the user cannot audit the list themselves. Capped at `CLOSE_BULK_MAX` (50) and the
    dialog spells out at most 12 names then counts the rest — a name the user cannot see is not
    consent.
  - **"Don't ask again" is bounded by SCOPE, not by permanence** (2026-09, revised 2026-10). The
    dialog offers three RADIOS, visible from the start (`waiveChoices`): **"ask me again next
    time"** (pre-selected, and not a waiver — an untouched dialog grants nothing), **"don't ask
    again for agents in <project name>"**, persisted in `settings.controlConfirmWaivers.projects` as
    `{ [projectId]: verbs }`, or **"don't ask again in any project until nodeterm quits"** — the
    transient `state/controlConfirm.ts`, memory only (not `settings.json`, not `localStorage`), per
    VERB in every project, so quitting restores the gate. It used to be a checkbox whose two reaches
    appeared only once ticked, defaulting to the app-run one: the per-project answer was invisible
    until the user had already said yes, and the 2026-10 report read it as missing. The labels say
    what each reach covers because the two are different shapes — "until nodeterm quits" must not
    sit under a project name, since the app-run waiver has no project bound. The machine-WIDE
    `always` is still reachable only from Settings → Agents, where the option says "permanently":
    a dialog that appeared under the user's hands must not switch a destructive gate off
    *everywhere* on one stray click. The per-project scope is what makes the offer honest — an
    app-run waiver is not what a user who ticks "don't ask again" means, and with only that and a
    machine-wide switch the real choices were "be asked forever" or "turn it off everywhere".
    Load-bearing details: (1) the waiver is keyed on the project the call **acts on**
    (`ctlProject`), not the active one — canvas control answers a background agent in its own
    project without moving the user's tab (@shared/control-off-screen), so reading the project on
    screen would grant, or honour, a waiver in the wrong repo; the same argument applies to the
    permission MODE the bypass lock weighs, which is why `controlConfirmDecision` takes a project
    id and resolves both from it. (2) It is **machine-local** — never `.nodeterm/project.json`,
    which is git-shared; the whole trap `bypassMode` needs two locks for. (3) It is **pruned** on
    every write (`pruneControlConfirmWaivers`, the rule `pruneCollapsedItems` states for
    `sidebarCollapsedItems`) against EVERY project including CLOSED ones — a closed project is
    parked, not gone — because settings.json is forever and a stale entry is a live security
    waiver keyed to an id nothing can name. The id being granted survives that prune because the
    merge happens after it, not by an exemption inside it; a safeguard no test can turn red is a
    comment, not a mechanism. (4) Precedence is narrowest-first among the persisted grants
    (session → project → always → bypass), so the notice names the waiver the user most likely
    wants back. (5) A waiver granted by a CANCEL must not exist at all (the grant hangs off
    `onConfirm`, pinned by `control-destructive.test.ts` and
    `control-confirm-scope.source.test.ts`), and a per-project grant that cannot be made (no
    project owns the call) falls back to the app-run waiver rather than silently to nothing.
    Waiving is not silence: every waived application raises the info strip through `waivedNotice`,
    which names the waiver that let it through — and, for the project scope, the PROJECT, since
    "this project" would point at whatever the user happens to be looking at — and every
    per-project waiver is listed with a Revoke in Settings → Agents. **The per-project scope can
    also be set UP FRONT**, before any agent has asked: each project tab's ⌄ menu has an "Agents
    may, without asking" group with one toggle per `CONFIRM_WAIVABLE_VERBS` member (labels in
    `WAIVABLE_VERB_ACTIONS`). It writes the same `projects` map — the dialog grant, the toggle and
    the Settings revoke all go through ONE pure merge, `withProjectWaiver` (prune, set, sanitize) —
    so it is no new mechanism and nothing it does reaches `project.json`. **A row shows the
    EFFECTIVE answer, not the map entry**: `projectWaiverState` asks `decideControlConfirm` itself,
    with and without this project's grant, so an app-run, machine-wide or global-Bypass waiver shows
    as in effect, names itself (`otherWaiverHint`) and points at Settings → Agents — a row that read
    only the `projects` map promised "agents here ask you first" while the gate still skipped the
    dialog. Surfaces: Desktop only. It is hidden in the browser Server Edition
    (`isBrowserRuntime()`), whose headless control is gated by creator ownership and never by these
    waivers, and on a relay tab, whose confirms belong to that machine; mobile N/A.
  - **`bypassPermissions` needs TWO locks, and this is the trap to understand before touching it.**
    The permission mode is persisted to `.nodeterm/project.json`, which is **git-shared** — so
    keying the waiver on the mode alone would let a repository the user CLONED silently disable
    their destructive-action gate. It therefore requires a machine-local opt-in
    (`controlConfirmWaivers.bypassMode`, default off) **and** a mode that came from the user's own
    GLOBAL setting: `resolvePermissionModeWithSource` answers `project | global | default`, and
    only `global` can waive. `default` is its own answer rather than folded into `global` because
    nobody chose it, and reading an unset setting as a deliberate choice is reading consent into
    silence. The claude version gate is deliberately NOT applied here (it exists to degrade `auto`
    for an old CLI; a security decision must not hang on a `claude --version` probe).
  - **`settings` can never be waived**, by table (`CONFIRM_WAIVABLE_VERBS`) rather than by a line
    somebody forgot at a call site: a settings change can GRANT a capability, and a CLI that could
    waive its own consent would make the consent decorative.
  - **`open-project` IS waivable (2026-10)** — it was excluded on the claim that it "cannot produce
    the dialog storm — `recordAttachConsent` already dedupes it per (caller, project)". That
    dedupe is keyed on the caller's NODE id, in memory, for one app run: every new orchestrator,
    every station a team spawns and every restart asked again about the same two projects, with no
    box to stop it (the field report: "an orchestrator in another project opens a node, a dialog
    each time"). Waiving it changes only whether the human is asked — main still requires a
    verified, local caller, an absolute existing `--cwd` and the grant cap, still records the
    grant from the reply, and the registration still never focuses a tab. Its waiver is keyed on
    the CALLER's project like `write`/`close` (the open-project block resolves that project
    itself, under the same `ctlProject` name, because it runs before the dispatch computes one);
    the waived and confirmed legs register through ONE `opFinish(opAdopt)`.
  **An agent-requested dialog knows its own request's lifetime** (`ConfirmState.expiresAt` /
  `onExpire`, `CONTROL_REQUEST_TIMEOUT_MS` now shared with main). Main abandons a control request
  after 120 s and tells the renderer NOTHING, so the dialog stayed on screen asking about work
  nobody was waiting for — and, worse, kept `confirmBusy()` true, which refused every later
  `write`/`close` with `a confirmation is already pending — try again` for the rest of the app run.
  **That is the "the same dialog keeps coming back" report**, and it is a single-canvas loop: the
  reply says retryable, the agent retries, every retry is refused by the orphan, and the moment the
  user finally answers it a queued retry raises a fresh dialog for the same node. The deadline is
  measured from the RENDERER's receipt, so it always fires a hair AFTER main gave up, never before
  (the other direction would abandon a dialog whose answer main would still accept); it replies
  `expired` rather than `denied by user` (nobody denied anything, and a reply main has already
  timed out is simply dropped); and the notice is a fading info strip, because raising an alert
  would keep `confirmBusy()` true — i.e. reproduce the bug with better wording.
  **`close-worktree --mode remove`'s dialog expires too** (2026-09-11), through the SAME
  `renderer/lib/useExpiringDialog.ts` the confirm uses — the rule was extracted rather than copied,
  because a second effect beside the first is how one gains a fix the other silently lacks. Three
  differences to keep in mind, all deliberate: it carries **no `onExpire`** (the verb replies
  "removal confirmation shown to the user — they decide" the instant the dialog opens, so nobody is
  waiting on an answer and an `onExpire` would be a reply to a call that finished minutes ago); its
  clear must also release **`removePendingRef`**, the guard covering the async `git.status` gap
  before `removeTarget` exists, which `confirmBusy()` reads directly — dropping the state while
  leaving that ref latched closes the dialog and keeps refusing every later destructive verb, i.e.
  the bug minus the only thing on screen that explained it; and the deadline is set **only when
  `requestedBy` is present**, because a removal the USER opened from the group menu must never
  vanish under them. It reuses `confirmExpiresAt` rather than inventing a second timeout: the fact
  is the same class ("an agent asked and the human is not at the machine"), and this is the most
  dangerous dialog to leave lying around — the one carrying a pre-ticked delete-from-disk choice on
  a worktree the human never asked about.
  **MEASURED, and the answer is no: two canvases cannot raise two dialogs for one request.** The
  suspicion was worth checking because the same project can be open on a desktop and in a Server
  Edition browser at once. Desktop main forwards each request to `getMainWindow()` — one
  BrowserWindow, so at most one dialog exists per request; the Server Edition raises none at all
  (its control is HEADLESS — `HeadlessNodeFactory.close` is gated by verified identity plus
  process-local creator ownership, and the browser bridge's `onAgentControl` is `noopUnsub`); and
  the shim's endpoint failover cannot duplicate a request either, because the control POST carries
  **no `--max-time`**, so a POST waiting on a human eventually gets an HTTP answer and
  `nt_reached()` is true — failover fires only on a dead transport (`000`/empty). If a future change
  gives that curl a timeout, this paragraph stops being true: a confirm-gated verb would then fail
  over mid-wait and a second instance WOULD open a second dialog for the same logical request.
  (The walk's liveness probe IS bounded, and does not break this: it runs only against a FALLBACK
  candidate, only after the primary failed — a dead transport, or a 421 wrong-owner answer, which
  the server gives before dispatch, so no dialog exists — and before any POST to that candidate.)
  **Grouping verbs** (`group` / `ungroup` / `move` / `arrange` / `align`): `group` wraps **sibling**
  objects — nodes or frames — into a new frame in their shared container (a mixed-container set, or
  an ancestor plus its descendant, is refused with that reason); `ungroup --group <id>` dissolves a
  frame, promoting its direct children into the frame's own parent (nodes kept); `move
  --nodes <id,id> [--group <id>]` reparents nodes OR whole frame subtrees INTO a frame (or
  `top`/`none`/omit → out to top level) via `reparentNode` — the ONE way to move a node between
  frames, which `group` won't do; a cycle (a frame into itself or its own descendant) is refused.
  `arrange`/`align` now run in ONE coordinate space: all top-level, OR all children of one frame
  (`commonParentId` decides; a mixed set is refused, not silently subset-arranged — the old
  behavior). When the ids are a frame's children, that frame AND every ancestor frame are re-fitted
  to hug the tidied layout (`fitAncestorChain` — fitting only the one frame left a nested frame
  wider than its parent) — the fix for "grouping keeps scattered positions so the frame is too
  wide". `arrange` fills its slots in the order the ids are LISTED (`arrangeNodes` used to place in
  array order, which discarded every caller's sort). `move` also re-fits the source + destination
  frames. All pure + tested in `state/workspace.test.ts` + `workspace.layout.test.ts`.
  **`arrange --group <frameId> [--layout grid|row|column|lineage] [--cols N]`** names the FRAME
  instead of listing its children: the frame's direct children are laid out and the frame chain is
  re-fitted — `arrangeGroupChildren`, the SAME transform the frame's menu rows run (see
  **Arrange inside a group** under Canvas interaction). The flag gate is the pure
  `arrangeArgsRefusal` (`@shared/arrange-verb`), called in THREE places: `parseControlRequest`
  (Server Edition), desktop main's control handler (which never runs `parseControlRequest` — the
  `--issue` trap; with the gate only in the parser, all three refusals were missing on the desktop
  and the request ran as a grid), and Canvas's `case 'arrange'` as the belt: `--nodes` and
  `--group` together are refused rather than resolved silently, an unknown `--layout` on the
  `--group` form is refused by name, and `--layout lineage` on the `--nodes` form is refused
  instead of being delivered as a grid (any OTHER unknown word there still falls back to `grid`,
  as it always has). What only the canvas knows — no such frame, an empty frame, no lineage among
  the children — is `groupArrangeRefusal`, replied as `arrange: <reason>`; a frame already in
  place answers `ok` with `changed: false` and writes nothing. The agent-facing text for the form
  is `arrangeGroupGuidanceLines`, rendered into BOTH generated bodies from the same layout list the
  gate checks. **Server Edition: refused by name** — `arrange` is not in `SERVER_V1_VERBS` in either
  form (headless control keeps no measured node sizes), so `--group` gets the same permanent
  `control-unsupported-on-this-edition` reply and is never dropped on the way to an `ok`
  (`control-unsupported.test.ts` pins it). Off screen it works like the `--nodes` form: the
  stored nodes are laid out and written back through `commitCtlNodes`, and the lineage ropes are
  the OWNING project's (`offCanvas.project.ropes`, re-marked with `markLegacyWaitRopes` exactly as a
  load would — a project that has not been opened since waits were marked still holds unmarked
  ones), never the live canvas's. The rope **id** rides along on both paths: it is the only thing
  that tells a wait from an opener, and stripping it (as the first revision did) makes every wait
  read as an opener. **`arrange --group top [--layout tidy|lineage]`** (2026-10, issue #1114 — an
  orchestrator asked for a programmatic Tidy) names the canvas's TOP LEVEL with the same words
  `move` reads (`top`/`none`/`ungrouped`, `isTopLevelGroupArg`) and runs the user's own **Tidy
  canvas** (`tidyCanvas`, default) or its bands (`arrangeByLineage`) — the same transforms as the
  pane menu, nothing re-implemented. `grid`/`row`/`column` are refused there by name: `--nodes`
  already says them, and a top-level grid that ignores lineage is what Tidy no longer is. Same
  Server Edition refusal, same off-screen path.
  **Geometry verbs (issue #1288, 2026-10): `arrange --gap`, `resize`, `place`, `list --geometry`** —
  so an agent can rebuild an exact layout (the report: 8 sessions in two tight columns on a
  vertical monitor, rebuilt every time a session is replaced) instead of a human dragging. Every
  packing always took `opts.gap`; the verb simply never handed it the flag. The shape gate is ONE
  pure module, `@shared/geometry-verbs` (`geometryArgsRefusal`; `--gap` lives with the rest of
  `arrange` in `arrangeArgsRefusal`), called in the same THREE places as the arrange gate — desktop
  main before the forward, `parseControlRequest`, and Canvas's belt (once, BEFORE the routing, so
  the live AND the stored `list` read a well-formed call). Every flag takes a value (the SSH
  shim-loop rule) and the new verbs refuse an unknown flag by name (#539). The rules a refactor
  must keep: **(1) `--gap`** is a whole number 0–`ARRANGE_GAP_MAX` (400, ten times the default 40)
  for all three forms; above it the call is REFUSED, never clamped. Snapping cannot undo it:
  `arrangeNodes` never snaps positions, and with snapping on the `--group` form snaps only the
  frame's PADDING and the frame fit (which keeps root positions). Frame padding is not the gap.
  **(2) `resize`** (`resizeNodes`) CLAMPS each named axis to the kind's resizer minimum
  (`NODE_MIN_SIZES`) and `NODE_SIZE_MAX` (the default-size setting's ceiling) and reports what it
  applied; it applies exactly (no grid snap); a group frame refuses the WHOLE call (a frame is
  sized by what it holds); a **collapsed** node keeps drawing header-only — the width applies now,
  the height becomes `expandedHeight` (what the expand gives back and what `flowToNodeStates`
  persists); a **maximized** node is restored first (left holding `premaxRect`, the next panel-pin
  refit would put it back over the viewport); `measured` is dropped in the same tick (the
  serializer prefers it); the ancestor frames re-fit. Terminal cols/rows follow through the node's
  own ResizeObserver — there is no second path to tmux. **(3) `place`** (`placeNodes`) is a NEW
  verb, NOT `--x` on `move`: `move` without `--group` means "to the top level", so `move --nodes a
  --x 10` would pull a framed node out of its frame and ignore the `--x` — `move` now REFUSES
  `--x/--y/--dx/--dy/--width/--height` by name, naming `place`/`resize`. Coordinates are ROOT space
  (what `list` reports); a framed node keeps its parent (the root delta is applied to its relative
  position, then `fitAncestorChain`, which keeps root positions, so it lands exactly). Several ids
  with `--x/--y` move as ONE block (bounding-box top-left lands on the point — not stacked: every
  node on one point is not a layout); `--dx/--dy` shift each; the two forms are refused together; a
  listed descendant of a listed frame is carried, not moved twice; |coord| ≤ `PLACE_COORD_MAX`
  (100 000, a typo bound, refused not clamped). **(4) `list`**: the JSON rows ALWAYS carry `x`,
  `y` (root, whole px), `width`, `height`, `parent` (+ `collapsed`/`expandedHeight`); the text form
  only behind `--geometry on`. The live canvas reports React Flow's MEASURED size
  (`liveNodeGeometry`), persisted only before the first measure; an off-screen project reports the
  persisted size (`storedNodeGeometry`). **(5) Off screen** `resize`/`place` are stored-node verbs
  like `arrange` (`commitCtlNodes` → `geometryMutations`), which is also the shared-canvas path; for
  that, `premaxRect` joined the stored geometry fields — before, an off-screen `arrange` restored a
  maximized node in memory and left its restore rect on disk. **Surfaces:** desktop only for the
  verbs. The Server Edition never reaches the renderer dispatch (its bridge's `onAgentControl` is a
  noop and `createServerEditionControlHandler` serves no layout verb, `list` included), so all four
  take the named permanent `control-unsupported-on-this-edition` refusal. Relay tabs: an agent's
  call is answered by the HOST desktop's canvas, and the guest sees the result through canvas sync.
  Mobile N/A. Follow-up: `--width/--height` on the open verbs (today they ignore an unknown flag).
  Pure rules in `state/workspace.geometry.test.ts`; wiring pins in `canvas/geometry-verbs.source.test.ts`.
  **Fan-in (`link`, 2026-07):** a spawned fan-out was previously write-only — nodes an agent
  opened were joined to it by a **rope** (`project.ropes`, explicitly *"Display-only — never
  context links"*), so an orchestrator could not read back what its own team produced and the
  skill told it to have the USER relay results. Now `open-claude`/`open-agent`/`spawn-team` also
  draw a real **context bridge** (`project.bridges`) to each agent session they open, and the
  `link --to <id,id> [--from <id>]` verb links nodes the agent did not open (or two other nodes).
  The rope stays — the two edges mean different things (lineage vs readable context) and a
  non-context-capable target still gets only the rope. Deliberately **silent**: the manual
  `onConnect` path pushes a discovery note into both endpoints, but doing that per team member
  would inject a prompt into every session an agent just spawned — the exact intrusion that push
  was reverted for. Links are pull-based, so nothing is lost. The refusal matrix is the pure
  `planBridges` (`renderer/lib/noteLink.ts`, unit-tested); Canvas only wraps it in setState.
  A missing endpoint is only absent from the calling project: report that scope and the
  unsupported cross-project boundary, without probing other projects or exposing their metadata.
  Callers that create and link nodes **in the same tick** must pass their own `lookup` — `setNodes`
  is async, so resolving fresh nodes off `nodesRef` would skip every one as "no such node".
  **Issue-bound opens (`--issue`, 2026-09-28):** `open-agent`/`open-claude --issue <owner/repo#N |
  #N>` binds the new session to a GitHub issue exactly like the board's **Start with agent**. The
  SHAPE is refused by ONE gate, `issueFlagRefusal` (`canvas-control-core.ts`), which desktop MAIN
  runs in its control handler (desktop main does not run `parseControlRequest` at all — do not move
  the gate there alone) and the Server Edition runs inside `parseControlRequest`; any other verb
  carrying `--issue` is refused, not ignored. `#N` is resolved by each shell against the project the
  node OPENS IN (the `--project` target, the cold-open owner, or `ctlProject`) — the repository its
  kanban board syncs with, i.e. the GitHub host controller's answer (configured, else detected) —
  and a project with no GitHub board refuses `#N` and names the full form (`lib/issueFlag.ts`,
  `HeadlessNodeFactoryDeps.issueRepository`). **On the desktop it is resolved ONCE, at the top of
  the control handler (`issuePre`), before any open path snapshots the projects store**: the lookup
  is a host round trip (`git remote`, `gh auth`), and an await inside a path let a tab switch in that
  window write the node into the wrong project. A full `owner/repo#N` asks nobody. The same
  placement puts resolution before every path's dry-run branch. **But not before the gates**:
  `resolveIssueFlagForCall` first runs the renderer's authorization belt — the same
  `resolveProjectTarget` call and source-capability rule the paths apply — and answers a caller
  they would refuse with the path's own refusal, asking nobody (the lookup otherwise ran for a
  refused caller, and its refusal said whether that project had a GitHub board). Main's
  `gateProjectTarget` runs before the renderer as ever; the Server Edition already resolved after
  its identity, source and target gates, now pinned by a test.
  **The open PROMPT is decided in the same place, once, for every open path** (`openPrompt`, via
  `launchPromptFor` in `lib/promptSpill.ts`): the issue reference line composed through
  `issueLaunchPrompt`, then spilled to a file when it is over the typed-line budget (#706), judged
  "local" by the project the node opens in (an SSH project's pane cannot read a file written here),
  which comes from the SAME authorization belt (`issueFlagScope`, exported for this): a caller the
  paths refuse gets no project and no spill. The live open was the only path that spilled; the `--project` and cold opens typed the prompt
  inline, so the docs' "a long `--prompt` is safe on a local project" was false exactly where the
  ~490-byte issue line made it likeliest to bite, and the `--project` path silently DROPPED
  `--prompt-file` (the session started with no brief) and `--model`. A new open path types
  `openPrompt`, never its own prompt — `control-prompt-spill.source.test.ts` pins each path.
  **A spilled prompt is read at LAUNCH, which for a cold open can be weeks away**, so it is not a
  paste: `saveUpload` puts a `LAUNCH_PROMPT_FILE_PREFIX` name under `<userData>/launch-prompts`
  (`@shared/launch-prompt`), owner-only, swept after `LAUNCH_PROMPT_TTL_MS` (30 days) by the next
  spill — under `uploads` the 7-day sweep of the next paste deleted it and `"$(cat '<path>')"`
  started the agent with nothing. And because a cold open can wait longer than ANY TTL, the held
  launch records the file (`pendingLaunch.promptFile`, via `withLaunchBrief` on every arming path)
  and the delivery loop checks it right before typing (`launchBriefPresent`: local projects only,
  a failed check answers "present"); a definite "gone" persists `manualOnly`, raises the
  `brief-missing` delivery state (tooltip names the path, `list` says HELD) and waits for ▶ / `run`,
  which still run it on purpose. The one residue: a refused open may leave a spill file behind
  (the spill is decided before the paths, to keep awaits out of them), swept with the rest.
  `--prompt` replaces the default task after the reference line; `--prompt-file` stays the whole brief. Both
  generated agent bodies render the contract from `issueBindingDocLines` (the example first prompt
  is rendered from `issueLaunchPrompt` itself): move your OWN card with `assign` (In Progress on
  start, In Review on delivery), never close the issue, never Done, `Closes #N` in a PR, and **post
  to GitHub only when the user asked in that session — otherwise end with a proposed comment**.
  nodeterm has no automatic post-to-issue path and must not grow one. `list` marks a bound row
  `issue owner/repo#N`. Server Edition: `open-agent --issue` works under its verified-only,
  creator-owned rules and writes the run history; `assign` is unsupported there (the skill says so).
  **The board's GitHub lane for agents (`issues`, `prs`, 2026-09-30, read-only).** An orchestrator could
  start work on an issue (`--issue`) and wait on a PR (`--after-pr`) but not SEE the lane: `board` lists
  session cards only (measured: 21 session cards, zero issue/PR cards), so agents fell back to
  `gh issue list` / `gh pr checks`, which spend the account's budget outside the coordinator and cannot
  say which column an issue sits in, which session is bound to it, whether dispatch queued it, or what CI
  snapshot the board already holds. `issues [--state open|closed|all] [--label L] [--column <id|title|
  ungrouped>] [--limit N]` and `prs [--state open|merged|closed|all] [--limit N]` (default open, 30 rows,
  max 100, newest-updated first; both take `--project`) answer that. ONE module, `core/github/control-
  read.ts`, called by desktop main (after the `--project` grant gate, before any forward) and by the
  Server Edition's control handler (own project only — it keeps no grant ledger). Rules a refactor must
  not undo:
  - **Zero GitHub requests.** The read is `GitHubIssueService.controlSnapshot`: the issue cache plus the
    pull tracker's memory, through `projectContextForCache` — no credential resolve, no heartbeat, no
    poll (`service.pulls.test.ts` counts the client's calls and the credential chain, before and after a
    fetch). No snapshot yet, an unapproved repository and a board with no GitHub connection are each a
    NAMED refusal (`issues-no-snapshot`, `-not-approved`, `-no-github-board`), never "0 issues". An
    agent's read deliberately does NOT start a fetch: a repository's first fetch is a full paged harvest,
    and spending that is the person's call (opening the board), not a background agent's.
  - **An unapproved column mapping is not a fact.** The label → column mapping arrives through the
    git-shared project file; while this machine has not approved its digest (`mappingApproved` false)
    the board is read-only with "approve the column labels", and `issues` likewise shows NO `column:`,
    says so in its header, and refuses `--column` (`issues-mapping-not-approved`).
  - **One workspace load per call.** The host's cache context carries the `Project` it resolved
    (`GitHubIssueProjectContext.project`, in-process only) and `controlSnapshot` returns it; a second
    `githubProject` load per call re-fired the store's persist hooks for an agent polling `prs`.
  - **A harvested merge/close wins over an open status read**, which may be stale; the status read
    stays authoritative about draft vs open.
  - **The board's semantics, imported.** CI is `GitHubPullStatus.ci` (`pullStatusFrom`: a null rollup
    is "no checks", never passed; only the CURRENT head counts), merge `ready` only from CLEAN, a failed
    status read says STALE (`pullStatusFreshness`), merged/closed PRs carry no CI. PR ↔ session card is
    `pullsForCard` — MOVED to `@shared/pull-card-links` (the renderer's `lib/pullLinks.ts` re-exports it)
    with the nearest-bound-branch walk (`nearestBoundBranch`, which `worktreeBranchOf` now calls), so
    the card and the verb cannot link differently: worktree branch (never a fork, never on an SSH
    project) or the issue the session was started on, tombstones honoured. Bound sessions are terminal
    nodes whose `issueRef` names this repository, with the mirror's live state (`queued` for a held
    launch, `unknown` otherwise).
  - **Untrusted text.** Titles, labels, logins, branch names — and node ids and column ids, which come from
    the git-shared project file whose load checks only that they are strings — pass `untrustedLine` (one line, `\p{Cf}`
    bidi/zero-width stripped, capped); the reply's first line is `UNTRUSTED_TEXT_NOTE`; issue bodies and
    comments are never included (the agent reads them with `gh`, as the `--issue` prompt says).
  - **Dispatch state is the renderer's**, so the renderer REPORTS it: `boardDispatch.report` (display
    only, replaced whole on change, `@shared/board-dispatch-report`) into `core/board-dispatch-report.ts`,
    kept per sender and read only for senders still in `clientIds()` (a closed tab leaves no stale
    "queued"), owner clients only, the channel host-only (a relay tab's stub is inert). Desktop and
    Server Edition both register it.
  - Verified-only (`requiresVerified`, refusal `GitHub lane read refused.`, and desktop main checks
    `verified` again as a second guard, like open-project) — the project is resolved
    from the caller's node, so a forgeable caller could read any project's lane; `STORE_ANSWERED_VERBS`
    (a read needs no canvas, and polling `prs` must never travel the user's view); not a request-id
    verb. Both agent bodies render `githubReadDocLines` from the module's constants, including the loop
    (`issues` → `open-agent --issue #N` → `prs` / `--after-pr`) and "GitHub writes stay with the person".
    Relay peers cannot call these (their control belongs to the host). **Mobile: N/A** — the phone issues no
    control verbs.
