# Subagents, loops and branching

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Subagents, loops and branching

- **Subagent visualization** (agents in `SUBAGENT_CAPABLE`) — `subagent-start`/`subagent-end`
  normalized events drive a transient `state/agentNodes.ts` store. For Claude they come from
  **Claude's own `SubagentStart`/`SubagentStop` hooks** whenever a session sends them (2026-09,
  see **Claude's native subagent hooks** below); the older reconstruction — `PreToolUse`/
  `PostToolUse` on tool `Agent`/`Task` correlated by `tool_use_id`, whose PostToolUse on an async
  launch is only an ack (`status:'async_launched'`), with the real end sniffed from the
  `<task-notification>` queued into the parent transcript (context tails → synthetic
  `subagent-end` in both shells) — is kept as the FALLBACK and as the source of the task label.
  Neither the notification's `UserPromptSubmit` nor the `[Subagent hand-back]` one is a `newTurn`,
  so neither clears the fan-out. Canvas renders each subagent
  as an **ephemeral** `SubagentNode` (display-only card: type + task + working/done) connected by
  an **edge** to its parent agent node. These ephemeral nodes/edges live outside the React Flow
  `nodes` state (merged only at the `<ReactFlow>` prop), so they're never persisted
  (`flowToNodeStates`) nor in undo/dirty. **Two different clears, and the difference is
  load-bearing (issue #547):** the removal paths (node delete, project delete, the cross-project
  close, the orphan-session kill, `SessionEnd`) call `clearForParent`, which drops everything —
  a node that is gone has no work left to represent. A **new turn** calls
  `clearFinishedForParent`, which drops only `state === 'done'`. "The previous fan-out is stale by
  definition" is true of a finished card and false of a working one: Claude launches subagents
  **async**, so *"waiting for N background agents to finish"* is exactly the state in which the
  next prompt gets typed, and nothing rehydrates `byId` afterwards (`start()` fires only from a
  live launch event; a running subagent emits no second one) — the card was gone for the rest of
  the run while the agent kept working. The expensive half is not the missing card: Eco's
  hibernation guard derives `liveSubagents` from this same store, so the wipe let a parent with
  live background agents read as idle and get its CLI `/exit`ed. Keeping an unfinished card then
  **owes a decay** — `useAgentNodes.sweepStaleWorking`, on the same 60 s tick and the same
  `WORKING_STALE_MS` as `agentStatus`'s (imported, never re-chosen: `shared/agents/stale.ts` exists
  because three surfaces each invented their own timeout) — or a subagent whose end never arrives
  pins its card, and its parent, forever. It marks the card **done** rather than deleting it, so a
  late `finish()` is the no-op it already was and the next turn boundary takes it.
  **A third removal path is opt-in:** `settings.autoHideFinishedSubagentCards` (default OFF, and
  off reproduces the two paths above exactly) mirrors into the store as `autoHideFinished`, and
  with it on a card is dropped the moment its subagent REPORTS done, with no turn boundary. Only a
  DONE card is ever dropped, so #547's rule (a new turn keeps the cards of subagents still running)
  and Eco's `liveSubagents` are untouched. **The decay is deliberately NOT one of the paths it
  gates**: `sweepStaleWorking` fires precisely because the end never ARRIVED, which is the opposite
  of what the setting promises, and it is the one case where a visible card carries the most
  information — drop it and a fan-out whose subagents died silently leaves nothing on the canvas
  saying one was ever launched. It costs Eco nothing either way, since an absent card and a `done`
  card are the same answer to `liveSubagents`. Renderer only: Desktop and Server Edition identical,
  Mobile N/A.
  (Subagents share the parent's process — no PTY.) Each card shows
  duration/tokens/tool-uses and **expands** (click) to a **live transcript**:
  `core/subagent-tail.ts` tails the subagent's own transcript file
  (`<…>/<sessionId>/subagents/agent-<id>.jsonl` — for a native card at the path DERIVED from the
  parent's transcript and the `agent_id`, `claudeSubagentTranscriptPath`; for a tool-path card
  matched by `tool_use_id` via the sibling `.meta.json`), read-only, formats each line (assistant
  text + tool calls + results), and streams chunks over `agent:subagent-activity` into the store.
  **Claude's native subagent hooks** (2026-09; `CLAUDE_HOOK_EVENTS` subscribes `SubagentStart` +
  `SubagentStop` for every installer — local, managed account dirs, SSH host). MEASURED on Claude
  Code **2.1.284** in a throwaway `CLAUDE_CONFIG_DIR` (nine scenarios, print mode and the
  interactive TUI; fixture `src/shared/agents/__fixtures__/claude/subagent-hook-payloads.json`,
  pinned by `normalize.claude.subagent-capture.test.ts`); the published npm bundles date them:
  `SubagentStop` gained `agent_id` + `agent_transcript_path` in **2.0.42**, `SubagentStart` first
  ships in **2.0.43**. Facts a refactor must not lose:
  **(1)** both events carry the PARENT's `session_id` and `transcript_path` (unlike grok, whose
  stop carries the child's), and `agent_id` (`a` + 16 hex, validated as a token by
  `isClaudeAgentId` because it becomes a card key and a file name) is the one id they share. The
  start names the child ONLY by `agent_id` + `agent_type` — no `tool_use_id`, no task text; the
  stop adds `last_assistant_message` + `agent_transcript_path`. **(2)** `SubagentStop` is the end
  of the child's TURN and arrives before the `<task-notification>`, sync or async — but a
  background child that stops while its OWN child still runs is **resumed under the same
  `agent_id`** (a second start, then a second stop): a native stop does not always mean
  "finished". **(3)** Claude fires `SubagentStop` for **internal side-agents** (prompt
  suggestions — after nearly every interactive turn) with `agent_type: ""` and **no start**. **(4)**
  a **killed** child (interrupt) fires **no** stop. **(5)** nested children fire both events
  through the same subscription and connect flat to the owning node; the tool path never saw them
  (their `PreToolUse` carries `agent_id` and is filtered), so native hooks are the first time a
  nested subagent gets a card at all. **(6)** `Stop` (and `SubagentStop`) carry
  `background_tasks` — every running BACKGROUND task of the session (async subagents incl.
  nested ones, background shells), never a foreground subagent; on `SubagentStop` the finishing
  child still lists itself, so only the parent `Stop`'s copy is read (`liveBackgroundTaskIds`,
  closed set of finished statuses, anything else counts as running). Absent through 2.1.112,
  present by 2.1.266 (not bisected — feature-detected per payload). **(7)** in interactive auto
  mode every `PreToolUse(Agent)` of a message fires FIRST, then the children start within 5 ms of
  each other (the permission classifier sits between; 20 ms gap in print mode, up to ~5 s
  interactive), each followed ~1 ms later by its async ack whose `tool_response.agentId` names the
  exact child. **(8)** the child's `SubagentHandback` tool injects `<agent-message from="…">
  [Subagent hand-back] …` into the parent before the task-notification — not a genuine turn
  (`isInjectedSubagentPrompt`, matched on the whole marker).
  **How the two paths coexist** — ONE core module, `core/claude-subagent-lifecycle.ts`, fed every
  normalized event (and the task-notification end) by BOTH shells before any consumer; events it
  does not act on come back as the same object. Latch per node+session on the first native
  start: before it a tool call draws its card immediately (an old CLI, or a session whose hook
  snapshot predates the upgrade, is byte-for-byte the old stream — pinned over the fixtures with
  the native events stripped); after it a tool call is only a pending LABEL and the card appears
  at the child's own `SubagentStart` (so a denied tool call draws nothing). The session's first
  child is drawn from its tool call and then REPLACED by its native card (`supersedes` — the
  renderer store, the host replay and the notch HUD move the card; nothing can know at the tool
  call that a native start is coming). Native cards are keyed by `agent_id`, so start/stop/resume
  follow the CLI exactly; only the label is paired, first-in-first-out by type, corrected exactly
  by the ack (also when the ack overtakes its start — and a call an ack already named is never
  handed to another child), and for a SYNC child by its end (`tool_response.agentId`), which
  takes its call out of the queue and relabels a still-running sibling that guessed it. Every
  turn-end `Stop`/`StopFailure` (never the `idle` rescue — an Agent call may be waiting on a
  permission prompt) clears the queue of calls whose child never started, with or WITHOUT an
  inventory: 2.0.43 had native hooks long before `background_tasks`, and a denied call's label
  must not go to the next child. A native stop for an id that never started is dropped
  (side-agents); a later start of a known id re-opens its card; the parent `Stop` inventory, when
  present, ends a native card it no longer lists (the killed child); a tool card whose child
  never started is ended at the turn end; a replaced tool card also gets a plain end AFTER the
  replacing start (for a consumer too old for `supersedes`); tool-path ends are re-keyed onto the
  native card (idempotent, and they bring the sync stats the native stop lacks — a late
  stats-bearing `finish()` fills them on a done card). Tails: the native start begins the child's tail in the RAW listener, which must run
  BEFORE the `ignoreQuestionHook` child-event gate (it ignores every `agent_id`-tagged payload);
  the lifecycle's `onRelease` ends it (local + remote); a resumed child continues from its
  remembered offset (`subagent-tail` / `remote-subagent-tail`) instead of re-streaming; a remote
  child is tailed at its derived host path with no `.meta.json` ssh polling. **Eco**: because a
  native stop can be a pause (fact 2), the parent `Stop`'s non-empty inventory stamps
  `backgroundTaskAt` (Canvas), the guard Eco and the bulk restart already read — a strictly safer
  rule than before (it also covers a background shell a subagent launched). Both shells pinned by
  `hook-verified-parity.test.ts`; the Server Edition also behaviorally over the fixture
  (`server/agent-status.test.ts`). Cost: one extra managed-hook process + POST per interactive turn
  (the side-agent stop). Residuals, stated: a SYNC child has no ack, so while it runs a reordered
  same-type burst can show a sibling's LABEL (never lifecycle) until the first of them ends; a
  killed child with no later parent `Stop` inventory still waits for the decay. **Device checklist** (not runnable
  here): (a) macOS + Windows canvas, interactive: cards at start, right labels, live activity,
  done at stop, nested card, resumed card re-opens; (b) SSH node: native tail over the
  ControlMaster at the derived path; (c) a session started BEFORE the upgrade (old hook snapshot —
  whether Claude reloads hooks mid-session is unmeasured): no double and no missing cards; (d) Eco
  with a background subagent paused on its own background shell: not hibernated, bulk restart
  skips it; (e) a managed-account node gets native cards (installer writes the account dir); (f)
  Windows: the derived path keeps the reported separator; (g) a pre-2.0.43 CLI tolerates the two
  new keys in settings.json (same class as `StopFailure`, which already shipped); (h) the
  hand-back turn (a background child reporting back wakes the parent for a turn, then the
  `<task-notification>` wakes it again) may chime "finished" twice — #708's quiet rule is per
  turn.
  **Codex** (2026-08-24, `spawn_agent` collaboration — issue #401) joined via its **native
  `SubagentStart`/`SubagentStop` hooks**, measured on codex-cli 0.146.0, keyed by `agent_id` (NOT
  `tool_use_id` — nothing correlates the spawn tool call with the Start it launches; agent_id is
  stable across the child's life, parallel + nested spawns included, and nested children fire
  through the same subscription so every card connects flat to the owning terminal node). Facts a
  refactor must not lose: **(1)** every agent_id-tagged codex event carries the PARENT's
  `session_id` with the CHILD's rollout as `transcript_path` — both raw listeners skip the
  context-meter track for them (else the parent's meter re-points at the child) and `normalizeCodex`
  returns null for child tool events (else a child Bash event flips a finished parent back to
  RUNNING after an async spawn); pinned by `hook-verified-parity.test.ts`. **(2)** the spawn task
  text is **encrypted end-to-end** (`tool_input.message` and the NEW_TASK payload are Fernet blobs)
  — there is no `taskLabel`; the readable `Task name:` header reaches the card via the activity
  stream instead. **(3)** the live tail is `subagentTail.trackFile` (the path is handed to us —
  no meta-dir matching) with the **stateful, per-entry** `createCodexSubagentFormatter`
  (`core/codex-subagent-format.ts`): a spawn child is a FORK of the parent thread, so its rollout
  opens with a replay of the parent's context, suppressed until the
  `inter_agent_communication_metadata` / NEW_TASK gate — per entry, because two concurrent
  subagents sharing one closure would gate each other. **(4)** codex's `SubagentStop` IS the real
  end (no async-launch-ack trap, no task-notification sniffing), carrying
  `last_assistant_message` as the card's result. Remote (SSH) codex nodes get cards but no live
  activity yet (the child rollout is on the host; claude's `remote-subagent-tail` has no codex
  counterpart — follow-up).
  **Grok** (2026-09) joined via its own native `SubagentStart`/`SubagentStop`, measured on
  grok 1.0.13 by launching two `explore` children in parallel. Keyed by `subagentId` occupying
  the same `toolUseId` slot the store already uses (claude by `agent_id` natively, else
  `tool_use_id`; codex by `agent_id`; grok has no tool call behind a subagent). Facts a refactor must not
  lose: **(1)** the start's `sessionId` is the PARENT's and the stop's is the CHILD's own
  (equal to `subagentId`) — keying on it files start and stop under different cards and the
  started one never closes. **(2)** the child's transcript is DERIVED from `subagentId` as
  `chat_history.jsonl` (`core/grok-subagent-format.ts`); the start's `transcriptPath` is the
  PARENT's, and even the stop names `updates.jsonl`, which parses to nothing. **(3)** a
  `session_end` bearing `subagentType` returns early in both raw listeners — without that a
  child finishing tears down the PARENT's session state. **(4)** `description` arrives only
  on the start. The four captured payloads live in
  `src/shared/agents/__fixtures__/grok/hook-payloads.json`, pinned by
  `normalize.grok.capture.test.ts`. Remote (SSH) grok nodes get cards from the hook but no
  live tail yet (the child dir is on the host; same gap as codex).
- **/loop, /schedule & /cron node** (agents in `RECURRING_CAPABLE`) — detected from the **tools**
  the agent invokes (robust; users often phrase it in natural language so the prompt rarely starts
  with the slash): `PreToolUse` for `Skill` (skill ∈ loop/schedule/cron), `CronCreate` (→ cron,
  label = cron expr · prompt), or `ScheduleWakeup` (→ loop) — plus a `UserPromptSubmit`
  `/loop|/schedule|/cron` prompt-prefix fallback, all surfaced as `recurring` normalized events.
  Sets `agentStatus.loop` ({count, prompt, items, kind}); for in-session `loop` each turn-done
  bumps the count + appends `lastMessage` (schedule/cron run in the background, so they aren't
  counted). Lifetime by kind: `loop` dies with its session; `cron`/`schedule` **outlive turns,
  sessions and app restarts** (`loop` is persisted in the agentStatus localStorage) and are
  cleared by a `CronDelete` `recurring`-end event or the card's own × (dismisses the card only).
  `clearForParent` (new turn) leaves the loop card's dragged position alone. Renders an ephemeral
  **LoopNode** labelled by kind, connected by an edge to the parent, plus a small header badge.
- **Branch conversation** — node action (`IconBranch`, Claude-only via `BRANCH_CAPABLE`): sends `/branch` into the
  existing terminal via `pty.sendText` (tmux `send-keys`) and opens a new Claude node that
  resumes the parked original with `claude --settings … -r <ORIGINAL_ID>`. The original id is
  the session id already known from hooks; `lib/claudeBranch.ts` is the fallback that parses
  `pty.capture` output when the id isn't known. The source node stays on the new branch.

## Subagent reload replay (#680)

`core/subagent-replay.ts` retains at most 512 running starts for the existing WORKING_STALE_MS,
with original host timestamps. The shared mirror event path feeds it (including synthetic async
ends); session boundaries and clearNode discard it. Both shells expose the same read, and desktop
preload / browser / relay subscribe before requesting it. Only lifecycle events wait behind the
snapshot (bounded to 512 events / 3 seconds); live permission alerts are not delayed or replayed.
No disk restore, transcript backlog, completed-card replay, or authorization evidence is provided.
A host restart or a missed original start is still outside this recovery.
