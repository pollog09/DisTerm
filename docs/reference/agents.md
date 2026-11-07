# Agent support: messaging, registry and per-agent notes

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Agent support (Claude / Codex / Antigravity / Gemini / Copilot / opencode / Grok / custom)

**Message scope publication:** desktop `send`/`reply`/`notify` wait for pending active-canvas edits
to be saved when either endpoint is on that canvas (`renderer/lib/messageScopeSync.ts`). `list`
and context links can already see a newly opened node while main's `persistedCanvases()` cannot;
the scope resolver reports that absent target as `cross-project`. The publication barrier never
travels, never overrides an external-edit conflict, and does not authorize anything: main still
checks unique project membership, runtime ownership, consent, verified status and the native pane.
An unrelated active canvas is not saved for a background message. Server control already writes
its nodes through the authoritative store; the renderer barrier is a desktop concern. Mobile is
not an agent-message sender.

**A `send` to a node that has not STARTED yet is queued, not refused** (`targetNotStarted`,
`agent-messaging.ts`). A node opened into a project that is not on screen without `--run-now`
exists only as a held launch until the project is viewed, so no spawn has recorded its pane owner.
When the owner is unproven AND no session exists AND this machine holds a launch for it
(`WorkspaceStore.heldLaunch`, the machine-local `localExec` overlay), the outcome is
`targetNotStarted` and the deliver-on-idle queue holds it; the flush re-runs every gate against the
pane the spawn will have proven. A LIVE pane with no proven owner stays `unproven-target-owner` —
that refusal is the security property. Such a message waits up to 24 hours
(`NOT_STARTED_TTL_MS` = `QUEUE_PERSIST_TTL_MAX`): the start waits for a person to open the project,
and the ordinary 5-minute TTL lost the message in the field (queued 19:12, expired 19:17, project
opened 19:27). It is not carried across an app restart (no session was recorded to bind it to), and
a node deleted before it starts keeps it until the TTL. A `targetStatusStale` target — a station
started a moment ago (`--run-now`, `run`) that has not posted its first hook — is queued too, with the
ordinary TTL: a retry cannot help before that hook, and its first verified `done` flushes the queue.
Both shells wire `heldLaunch`.

**A board comment that @mentions a session is a message from a PERSON** (`@shared/board-comment`,
`deliverBoardCommentFromUi` in `core/agents/agent-messaging.ts`). The comment composer's @ picker
inserts an id-based token `@[label](node:<id>)` (the id is the authority, the label only a fallback
name); on send, each mentioned session gets its own delivery through the SAME `runDelivery` an
agent `send` takes — scope, runtime pane ownership, the per-project `agentMessaging` switch, flow
control, the pane probes, the nonce envelope, the receipt, the deliver-on-idle queue with its TTL.
What differs is only who it is from: the scope is "the target is on the comment's board"
(`resolveBoardCommentScope`); the PAIR window belongs to the board (`board:<projectId>` — one comment
per session per 10 s, whichever comment) while the FAN-OUT budget belongs to the comment itself
(`reserveFlow`'s `fanOutKey`, `board:<projectId>:<commentId>`), because a person's turn is one comment
and an earlier comment's in-flight holds or queued flush must never spend a newer one's (review
finding; both scenarios are tests); a comment mentions at most `BOARD_COMMENT_MENTION_MAX` =
`FANOUT_PER_TURN` sessions and is refused whole above it; a pair-limited board comment is QUEUED
rather than refused (`BOARD_QUEUE_ON` — an agent retries, a person could only post again; the
flush re-runs the limiter) AND re-offered on a timer when the window ends
(`DeliveryQueue.retryAfter`, armed at enqueue and at every `rateLimited` re-queue, one pending nudge
per target): the queue otherwise flushes only on the target's `done`, and a window ending emits
nothing — a session already idle, or whose `done` landed inside the window, left the comment to
expire at the TTL; and the envelope reads `from: board comment by <author>` with no node id
and `reply-to: none (…)` (`BOARD_COMMENT_REPLY_TO`; both agent-facing bodies render it from the
constants). An agent node TITLED like that is labelled `node titled "…"` in its own `from:` line, so
it cannot pass as a person. The body is the comment with each token turned into the `@<name>` its author saw
(`mentionNameForAgent`: the token's label reduced to letters, digits, spaces and `. _ - #`, capped at
40, else the node id — a node title is whatever the project file says, and it lands in another
agent's prompt), then `sanitizeChatText` (every C0/C1 control but `\n`/`\t` — the one shared rule)
and a cap. A comment's parallel mention deliveries share ONE `syncMessageScope` save (`coalesce`).
**Only the local user, typing in THIS app, can trigger it.** The log is a shared file — a git pull,
another instance, a relay peer or a team-presence guest can put a token in it — so NOTHING that
reads the log reaches a delivery: the one call site is `BoardLogPanel`'s send
(`board-comment-trigger.guard.test.ts`), the IPC (`agent:board-comment-deliver`) is a raw,
main-window-only `ipcMain` handler that no peer can dispatch into and is also `HOST_ONLY`, and the
renderer refuses a relay-bound project and a browser tab (`canDeliverBoardComments`). Around the IPC
Canvas takes the same two steps as `send`: the target's `guardConcurrentRestart` lock and
`syncMessageScope`. **No silent success**: every outcome is on the comment row — `sending…`, then
the reply's typed outcome (with the `notPermitted` reason) from this app run, else the latest
`agent-message` trace line in the log whose `from` is `board-comment:<commentId>` (the trace now
carries `reason` too, and the queue hands its trace leg the queued request, so a board comment's
`queued`/`expired` lines land on ITS board whoever owns the pane by then). Log lines are trusted
ONLY for comments this machine sent (`nodeterm.boardCommentsSent`, localStorage, bounded): the log
is shared, so a teammate's comment arrives with THEIR machine's trace lines and a forged line is one
append away — such a comment shows no status, and its lines stay ordinary feed rows. For our own:
a line dated in the future is ignored, a `queued` older than `BOARD_COMMENT_QUEUE_STALE_MS` (the
queue TTL + 1 min — a crash still never writes its end; a clean restart does, since the durable
queue expires a restored board comment at boot, see **Durable orchestration state**) says no outcome
was recorded, and a mention with no record at all says so too. A trace line is hidden as a row only
on the card whose comment row shows it; the mentioned session's own card keeps "routed a board
comment here: …". Text tables are read with `Object.hasOwn` (values come from the shared file).
The card modal's capture-phase Escape defers to the composer while its @ picker is open. Desktop: full. Server Edition and relay
tabs: display-only by design (the bridge answers `notPermitted: unsupported-edition`; the picker is
not offered) — a browser or a relay guest typing into this machine's panes is exactly the
cross-user injection this refuses. Mobile: N/A (the phone posts no board comments).

The app is a pluggable multi-agent system: Claude Code is one builtin of
several. Extra terminal-node behavior is driven per agent by a registry + capability lists, a
shared 4-state model, and a **transient** zustand store `state/agentStatus.ts`
(`{state, agentId, unread, session, sessionId, loop, hibernated}` per node id; the live `state` is
**not** persisted — only `unread`/`session`/`sessionId`/`agentId`/`loop`/`hibernated` go to
localStorage under `nodeterm.agentStatus`, migrated once from the legacy `nodeterm.claudeStatus`
key. `agentId` is durable because a hand-launched `claude` in a plain terminal is known nowhere
else, and its context links must keep classifying across restarts). That is the DEFAULT instance,
the local core's. A relay / team tab's session gets its own **keyless** store (`agentStatusForApi`):
it persists nothing, never acks a read (no `ackDone` callback), and is fed by `applyAgentEvent`
(`state/applyAgentEvent.ts`), the same reducer Canvas's listener uses — see "A relay session owns
its agent status" under Hosted team relay.

- **Agent registry + capabilities** — `src/shared/agents/config.ts` holds `AGENT_CONFIG`
  (claude/codex/gemini/copilot/opencode/grok: id, label, spawn command, color, `promptInjectionMode`, …) keyed
  by an **open** `AgentId`
  type (so custom ids fit). Capabilities are membership lists, not flags:
  `AGENT_HOOK_TARGETS`, `RESUMABLE_AGENTS`, `SUBAGENT_CAPABLE`, `RECURRING_CAPABLE`,
  `BRANCH_CAPABLE`, `CONTEXT_LINK_CAPABLE`, `USAGE_CAPABLE`, `CHAT_CAPABLE`,
  `TRANSFER_SOURCE_CAPABLE`, `RENAME_CAPABLE`, `TITLE_READ_CAPABLE`, `CANVAS_CONTROL_CAPABLE`,
  `PERMISSION_MODE_CAPABLE`, `MODEL_SWITCH_CAPABLE`, with helpers (`hasHooks`,
  `canBranch`, `canContextLink`, `canChat`, `canRename`, `canReadTitle`, `hasPermissionMode`, …).
  Branch stays **Claude-only** purely by being in only `BRANCH_CAPABLE`. The ⌘M **ChatPanel**
  transcript view (`CHAT_CAPABLE` / `canChat`) is **claude + grok + gemini + codex + copilot +
  opencode** since 2026-09: grok's `chat_history.jsonl`, gemini's session file, codex's rollout,
  copilot's `events.jsonl` and opencode's `opencode export` document each get their own reader, and
  `chat:read-transcript` routes by agent. That list had
  to be SPLIT to do it — `CHAT_CAPABLE` carried two facts that coincided while claude was its only
  member ("we can render this" and "claude's resolver can locate and parse this file"), and the
  second now lives in `CLAUDE_TRANSCRIPT_READABLE` (claude only). Merging them back is a
  cross-session read of someone else's transcript; `config.capabilities.test.ts` pins the pair.
  The other lists span more agents, and the memberships below are the ones to check before assuming
  "claude-only" (all verified against `config.ts`, 2026-09-02): the per-node **context meter** is
  `USAGE_CAPABLE = claude/codex/gemini/grok` — grok states BOTH numbers, and its own percentage, in
  `signals.json`;
  the **permission mode** is `PERMISSION_MODE_CAPABLE = claude/grok/gemini/codex`; the session-name
  sync is **split in two** — `TITLE_READ_CAPABLE = claude/codex/grok/gemini` (read) ⊇
  `RENAME_CAPABLE = claude/grok` (write), because gemini and codex name their own sessions but have
  no rename command (codex's read leg is `readCodexSessionName`);
  **Context Link** spans seven builtins
  (`CONTEXT_LINK_CAPABLE = claude/codex/gemini/opencode/grok/cursor/antigravity/copilot`; copilot
  joined with `locateCopilot` + `linesFromCopilot`, see `context-link.md`). UI gates
  on these helpers — no hardcoded `=== 'claude'`. **Custom agents** (user-defined in Settings,
  `customAgents`) inherit the declared `baseAgent` harness through `capabilityAgentId`; a custom
  agent with no base remains spawn + terminal-title + process status only. Per-agent write-ups:
  **`docs/grok-agent.md`**, **`docs/gemini-agent.md`**, **`docs/copilot-agent.md`**, **`docs/antigravity-agent.md`** (there is none for codex — its approval mapping
  and every value's reasoning live in `src/shared/agents/approval-mode.ts`);
  the distilled rules are **Adding a new agent** at the end of this section.
- **Model gateway / switcher** — `settings.modelGateway` stores one gateway root + a NON-SECRET
  credential reference: `${env:VAR}` for environment mode or
  `${secret:model-gateway-api-key}` for a literal held by `ModelGatewayCredentialService`. Desktop
  literal keys reuse the GitHub token store's safeStorage encryption / 0600 fallback; Server
  Edition uses the same generic 0600 atomic store. Legacy plaintext settings migrate only after
  the secret write succeeds. `shared/agents/model-gateway.ts` is the ONE mapping from a base
  harness to derived routes, env vars, compatible models and safely quoted model flags. Env
  expansion reuses `shared/agents/expansion.ts` and happens only in core against the host process
  environment; an unset reference fails closed instead of sending a token or partial credential.
  Discovery at `/v1/models` is the **OpenAI Models API convention**, implemented by both LiteLLM
  and Bifrost; the current `/openai/v1` + `/anthropic` launch-route derivation is Bifrost's layout,
  not the source of the discovery convention. Discovery sends the standard bearer header plus
  Bifrost's `x-bf-vk` header (needed by legacy, non-`sk-bf-` virtual keys), and runs in core
  (`agent:discover-models`) so browser CORS cannot block the Server Edition and the key never
  enters a terminal command. Support is a
  capability (`MODEL_SWITCH_CAPABLE = claude/codex/copilot`) resolved through `capabilityAgentId`, so a
  custom agent with a supported `baseAgent` inherits it automatically — the settings UI and canvas
  menu carry no agent allowlist. A model switch SIGTERMs the pane's foreground non-shell process
  group (never types `/exit`) and RECYCLES the tmux session before cold-resume: an existing shell may
  predate the gateway setting, and tmux env changes do not retroactively change that shell's
  environment. Recreating it guarantees the current URL/key applies without typing a secret into
  the pane. On Windows (session host / direct ConPTY — no process groups) the kill is `taskkill /T
  /F` on the re-proven agent pid only, never the console root, and requires the agent-identity gate
  (`session-host/terminate-owner.ts`; an older live host answers `'unsupported'`). Ordinary Restart stays in-place. Custom-agent env is still merged last and may override
  the shared mapping. Desktop and Server Edition use the same core handler; relay tabs deliberately
  do not apply this machine's gateway to another core. Mobile needs a settings/model-picker surface
  before it can expose the feature.
- **Grok** (`@xai-official/grok` 1.0.0, builtin since 2026-08) — in `AGENT_HOOK_TARGETS`,
  `RESUMABLE_AGENTS`, `RENAME_CAPABLE`, `PERMISSION_MODE_CAPABLE`, `CANVAS_CONTROL_CAPABLE`,
  `CONTEXT_LINK_CAPABLE`, `CHAT_CAPABLE`, `TRANSFER_SOURCE_CAPABLE`, `USAGE_CAPABLE`,
  `SESSION_ID_CAPABLE` and `SUBAGENT_CAPABLE`. Subagent cards come from grok's native
  `SubagentStart`/`SubagentStop` hooks, keyed by `subagentId` — measured on 1.0.13 by launching two
  `explore` children in parallel (same type, different ids; the start's `sessionId` is the PARENT's,
  the stop's is the CHILD's own and equals `subagentId`, so that is the only id both events share).
  The spawn tool call is not the card key. The other four came off the blocked list
  in 2026-09, once a machine with a logged-in grok session produced real fixtures: context links and
  the ⌘M panel read `chat_history.jsonl` (NOT `updates.jsonl` — see below), and the meter reads
  `signals.json`. Its hook config is a **directory** (`$GROK_HOME/hooks/*.json`, all merged), so nodeterm
  **owns one file outright** (`nodeterm-status.json`) instead of merging into a shared settings file —
  which is also why a malformed copy of it is *healed* rather than preserved, locally and on an SSH
  host (`RemoteHooks.installGrokRemote`, under the host's own `$GROK_HOME`). Its dialect is
  **camelCase keys with snake_case event VALUES** (`{"hookEventName":"pre_tool_use"}`) — the SDK path
  flips the keys to snake_case, so `normalizeGrok` canonicalizes the event name and reads every field
  twice, and the shells share one decoder (`grokRawFields`). It carries **no `transcript_path`**, so a
  session directory is DERIVED from `cwd` + `sessionId` (`core/agents/grok-paths.ts`, the one
  `$GROK_HOME` rule — `core/usage/grok-usage.ts` delegates to it) and remembered in the shells' raw
  listener; the name read is `core/grok-session.ts` over `summary.json`, routed per agent by
  `core/agent-session-name.ts`. **The tool-event `matcher` is a regex: `.*`, never `*`** — a bare `*`
  is invalid and silently stops tool events firing (hence `ManagedHookEvent`). Grok also reads
  **`~/.claude/skills`** (Claude compat), which is why canvas control needed no new installer, and
  **`~/.claude/settings.json`**, so every grok event ALSO fires nodeterm's claude hook — an **inert**
  cross-fire (`normalizeClaude` finds neither grok's camelCase keys nor, in the SDK dialect, its
  lowercase event values), pinned by tests; canonicalizing claude's event-name compare would make it
  harmful. The `auto` permission-mode **version gate is claude's alone** (it is fed by a `claude
  --version` probe), and grok's mode flag must go **BEFORE** its `--` separator, which is
  end-of-options. Full picture, dialect traps and the device checklist: **`docs/grok-agent.md`**.
- **Grok NEEDS YOU is confirmed against grok's own event log** (`core/agents/grok-permission-gate.ts`,
  inside the hook server, so both shells get it from one place). MEASURED on grok 1.0.13
  (2026-09-30, interactive TUI against a local fake chat_completions model, fixture
  `shared/agents/__fixtures__/grok/permission-events.json`): the `permission_prompt` notification is
  genuine (fired 1–20 ms after grok writes `permission_requested` to `<session dir>/events.jsonl`),
  but grok is silent about the ANSWER — approve fires no hook until the approved tool FINISHES (the
  capture's 10 s command read NEEDS YOU for 10 s), a dismissed dialog (Ctrl+C) fires none at all
  (the only later hook is `idle_prompt` 60 s on, which the mirror deliberately never lets clear a
  `blocked` node — a stuck badge until the next prompt), and a rejection fires `permission_denied`
  then cancels the turn with no Stop (RUNNING for 60 s). `events.jsonl` records all three:
  `permission_resolved {decision: allow|deny|cancelled}` and `turn_ended {outcome: cancelled}`. The
  gate ties each notification to ONE `permission_requested` written within 5 s before it and
  publishes what the file says: still pending ⇒ `blocked` + a bounded 1 s watch (a `stat` per tick
  while nothing changes); answered ⇒ `working` (unverified — a file read is not a hook POST — including when the
  answer is already on disk as the hook is read); a
  cancelled turn ⇒ `done` + `interrupted`. **The trap it is shaped around**: a SUBAGENT's prompt
  fires with the PARENT's `sessionId` while its request is in the CHILD's `events.jsonl` — reading
  the parent's file alone would find the parent's older, already-approved request and publish
  "answered" over an open child dialog. Candidates are the sessions this node's hooks named
  (children post their own ids), zero or several matches publish the hook unchanged, and every new
  prompt ends the previous watch (the replay found that exact race: the parent's spawn approval
  landed 90 ms before the child's prompt). The candidate set CAN miss the real request — a child's
  prompt may reach us before any of the child's own hooks, or a second request's line may not be
  on disk yet — and the older request found instead is then already answered. **The load-bearing
  rule is therefore: a request answered BEFORE the notification fired is never taken as its
  answer** (`resolvedTs < notifiedAt` ⇒ the hook is published unchanged, nothing watched): a
  notification cannot be about a dialog that closed before it. Every capture resolves after its
  notification (fastest 216 ms). Review of #1065 found that hole; tests A/B pin it. Closed sets throughout; an unknown decision, unreadable
  file or unparsable timestamp is today's behaviour, never a guess. Per-node ordering is kept (a
  confirm read holds that node's later hooks, ≤ 500 ms; polls run off that chain and discard a read
  that straddled a newer hook). A listener that throws costs that ONE event (as it did inside the
  hook server's try/catch before), never the node's delivery chain. A remote (SSH) grok node's file is on its host, so it reads "cannot
  tell" and behaves exactly as before — a remote leg is a follow-up. Unmeasured: `events.jsonl`'s
  shape on other grok versions (a changed shape degrades to today's behaviour).
- **Codex NEEDS YOU is checked against the session rollout under its auto-reviewer**
  (`core/agents/codex-permission-gate.ts`, issue #1171, in the hook server, so both shells get it).
  With `approvals_reviewer = "auto_review"` codex fires `PermissionRequest`, then its own reviewer
  subagent approves or refuses with nobody asked; no hook fires until the approved command's
  `PostToolUse`, so the node read NEEDS YOU for the review plus the whole command. MEASURED
  (2026-10-16, private CODEX_HOME + fake Responses model, codex 0.156.1 `exec` and 0.163.0 TUI;
  fixture `shared/agents/__fixtures__/codex/auto-review-permission.json`): the hook payload has NO
  reviewer field; the rollout's per-turn `turn_context` carries `approvals_reviewer` and a `turn_id`
  equal to the hook's, already on disk when the hook runs; `guardian_subagent` is recorded as
  `auto_review`; a failed review rejects to the agent, never to a person. Rules: a closed match (the
  `turn_context` for THIS `turn_id`, value in `CODEX_AUTO_REVIEWERS`) suppresses the event, so the
  node keeps PreToolUse's `working`; everything else — no `turn_id`, unknown value, a path outside
  the codex sessions roots (system `$CODEX_HOME/sessions`, managed `~/.nodeterm/cx/<16hex>/sessions`),
  unreadable file (O_NOFOLLOW), no match within the 16 MB backward scan, a read over 500 ms — is
  published unchanged as `waiting`. The hook reply never waits on the read; later events of the
  node wait behind it. A remote (SSH) codex node's rollout is on its host, so it behaves as before.
- **Grok chat view (⌘M + phone `chat.page`)** — `parseGrokChat` (`core/grok-chat.ts`) reads
  `chat_history.jsonl` into claude's `ChatMessage`/`ChatPart` shapes (no new wire field): typed
  prompts, assistant text, tool calls (`arg` = the salient argument — `command`, `target_file`, …, in
  claude's `toolArg` order — else the raw JSON, 200 units) with results summarised like claude's,
  `web_search` backend calls, harness-injected `synthetic_reason` lines as assistant-side `[reason]`
  notes, and `model_id`/`reasoning_effort` of the NEWEST assistant record (never carried forward).
  `reasoning` is hidden. It does NOT page: measured on 1.0.13, the file is rewritten via
  `.sync.tmp` + rename and `/compact`/`/rewind`/history repair replace lines, so it is one capped
  whole-file read with no keys and no `at`. Routing is by `capabilityAgentId`, so a custom agent built
  on grok reaches grok's reader, never claude's cwd fallback. **A remote (SSH) grok node is read on its
  host** (`core/remote-grok-chat.ts`, one `sh -c` round trip: `$GROK_HOME` if absolute else
  `$HOME/.grok`, the session found by id across `sessions/*/<id>/`, two matches refused, the
  paged-transcript window at 5 MiB) — its failures are terminal, never this machine's disk (the
  hook-derived local map names a wrong-machine path for these nodes). The phone gets it for free:
  `chat.page` reads through the same deps. Golden fixtures + exact rules for the Swift port:
  `src/shared/chat-fixtures/grok/`. Not supported: the composer's model/effort labels (grok's `/model`
  and `/effort` pickers are unmeasured — the TUI needed a login here), plan/question answer cards
  (claude-only), pre-compaction history, and a local session whose map entry `SessionEnd` retired.
- **Copilot ⌘M chat view** (`core/copilot-chat.ts`, 2026-09; copilot 1.0.88 measured in BYOK mode
  against a local fake model, plus the CLI's own `schemas/session-events.schema.json`). Reads
  `<COPILOT_HOME>/session-state/<id>/events.jsonl` (then the snap package's
  `~/snap/copilot-cli/common/.copilot`), located STRICTLY by the node's session id and routed by
  `capabilityAgentId` before anything claude-shaped, so a missing journal is "not found", never
  claude's cwd-newest or another session. The journal is append-only JSONL (compaction appends), so it
  PAGES like claude's — `parseChatWindow`/`parseGrowingWindow` take copilot's record parser — and the
  phone gets the same pages over the relay (`page()` gates only on `canChat`). Shown: typed prompts
  (`content`, never `transformedContent`; the sources copilot's own timeline hides stay hidden),
  assistant text, tool calls with results (`Error: …` on failure), a user's `!` shell command as the
  `!` part, `Error:`/`Warning:`/`Info:` notices, and `model`. Never shown: the system prompt,
  reasoning, sub-agent events (envelope `agentId` / `data.agentId` / `data.parentToolCallId`). Not
  supported: remote (SSH) nodes (`unreadable`, "not supported yet" — never this machine's disk),
  `effort` (not recorded), plan/question answer cards (claude-only), composer model labels (claude's
  picker commands only). Golden fixtures: `src/shared/chat-fixtures/copilot/` (README "Copilot").
- **Antigravity** (`agy` 1.2.3 measured on Windows; the 1.2.12 Linux binary read; builtin since
  2026-09 — Google's replacement for Gemini CLI on personal accounts) — in `AGENT_HOOK_TARGETS`
  (badge, NEEDS YOU from `ask_question`, a closed set of one, `--after` and triggers) and
  `RESUMABLE_AGENTS` (`agy --conversation=<id>`, the spelling agy's own exit hint uses; a dead id
  is ignored by agy, which starts fresh — without it a reboot left a bare shell). Launch is
  `agy --prompt-interactive '<p>'` via the new optional `AgentConfig.promptFlag` (agy has no
  positional prompt). Its hooks live in the GLOBAL `~/.gemini/config/hooks.json` under our own
  `nodeterm-status` bundle, and **each one is a synchronous gate whose stdout agy reads as a
  decision** — we subscribe `PreToolUse`, so a wrong byte denies tools in every `agy` on the
  machine, inside nodeterm and outside it. Three rules for whoever touches it:
  - **The stdout table is written ONCE** (`core/agents/hooks/antigravity-decision.ts`): `PreToolUse`
    → `{"decision":"ask"}`, `Stop` → `{"decision":""}`, the rest → `{}`, an unknown/empty event →
    NOTHING. Measured on 1.2.3: silence runs the tool, while `{}`, `{"decision":""}`, any non-JSON
    byte and exit ≠ 0 DENY it. Never `allow`, never `force_ask`, never `"continue"` on `Stop`. The
    script answers first and then sends stdout/stderr to `/dev/null`, because hook stdout is also
    model input (`injectSteps`).
  - **No quotes in the Windows command.** agy passes it to `cmd /c` with inner `"` escaped as `\"`,
    which cmd.exe does not understand — the codex form (`cmd.exe /d /c call "…"`) exits 1 = DENY.
    The command is relative to the hooks.json directory (agy's hook cwd) and guarded:
    `if exist ..\..\.nodeterm\agent-hooks\antigravity-hook.cmd (call … <Event>) & exit 0`. Test
    Windows dispatch WITHOUT `windowsVerbatimArguments` — Node's default escaping is agy's.
  - **AutoRun blocks the install.** agy's `cmd /c` has no `/d`, so a registry `AutoRun` runs first
    and its output would deny tools; the installer reads the three `Command Processor\AutoRun`
    values (`reg query`, absence decided by listing the parent key — reg's errors are localized)
    and installs NOTHING — and withdraws a bundle an earlier launch wrote — if one is set or the
    registry cannot be read.
  **The vendor-location fallback also owns launch reachability.** Measured on Windows 11 with agy
  1.2.7: the vendor installer wrote `%LOCALAPPDATA%\agy\bin` into the user PATH as `REG_SZ`, so the
  process inherited the percent expression literally and both `where agy` and `cmd /c agy` failed
  while `%LOCALAPPDATA%\agy\bin\agy.exe` existed and ran. `PtyManager` therefore APPENDS the
  directory returned by `findAgy()` to the PATH of a LOCAL Antigravity session, and only when no
  entry already names it (`pathWithAgyDir`) — prepending shadowed the user's own tools on
  macOS/Linux, where agy sits in a shared directory. The gate uses
  `capabilityAgentId`, so an Antigravity-based custom agent inherits it; plain terminals and SSH
  sessions do not. Detecting the binary only for hook installation recreates the original split:
  a configured badge for an agent the pane cannot launch.
  **Installed only where `agy` exists** (a file lookup — PATH, then the vendor's install dirs —
  never a spawn), in two passes per launch: the boot pass may only see the inherited PATH, so a miss
  there does NOTHING; after the login-shell PATH probe settles, a final pass repeats the lookup and
  only then withdraws a bundle of ours when agy is not found. An `agy` installed later gets the
  hook the next time nodeterm opens. **The opt-out is agy's own switch**: `"enabled": false` on our
  bundle is carried across every rewrite. hooks.json goes through the shared settings transaction
  (`updateSettingsFile`: a symlinked file keeps its link and mode, writers serialize, a file changed
  mid-update is not overwritten), and only entries under `.nodeterm/agent-hooks/` are swept as
  ours. The POSIX command forces exit 0 (`sh <script> || :`) — the answer is printed first, and a
  later failure (a broken endpoint file) must not turn into a non-zero status next to it. **No SSH
  hook installer yet** (`LOCAL_ONLY_HOOK_AGENTS` / `hasHooksOverSsh`): on an SSH project an agy node
  never reports, so `--after` refuses it as a dependency. The event name is not in agy's payloads:
  the command exports `NODETERM_AGY_EVENT`, the script POSTs `nodeterm_hook_event`, and the hook
  server merges it after `JSON.parse` — for antigravity ONLY, an empty field deleting a planted
  value. `newTurn` rides only the
  `PreInvocation` with `invocationNum === 0` (without it `lastTurnError` is never retired). Cost:
  on POSIX the POST already runs in the background and the part agy waits for measured 2–40 ms
  (pinned by a stalled-endpoint test, since a foreground POST plus the failover walk measured ~6 s
  against the 5 s handler timeout); the ~520 ms per event measured on Windows is Git Bash's fork
  cost before the backgrounding. Full picture,
  limits (permission prompt and ESC fire no hook) and the device checklist:
  **`docs/antigravity-agent.md`**.
  **No conversation view, and that is deliberate** (not in `CHAT_CAPABLE`): ⌘M shows the rendered
  terminal output, and the phone's Chat screen answers `unsupported`. The
  LOCATION is measured: every hook payload names `transcriptPath`, which is
  `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`,
  keyed by the id `normalizeAntigravity` already records as `sessionId`. The RECORD SHAPES were never
  captured; the 1.2.12 binary only describes them in prose. Four facts a parser needs are unknown:
  the `tool_calls` element keys, how a tool result links back to its call, the serialized enum
  spelling, and whether a line is rewritten when its step's status changes, which decides between
  claude's paged read and grok's single capped read. A parser built from that prose would be a rule-14
  wrong guess, so none ships, not even unwired. The capture recipe is §7.1 and §8.1 of the doc, using
  `scripts/agy-transcript-shape.mjs`, which dumps shapes and never text. When it lands: locate
  strictly by id (`brain/` holds every conversation on the machine), and have a remote node answer
  `remoteOnly` → unreadable like gemini.
- **Codex in the ⌘M chat view** (2026-09-28; the desktop panel, the kanban card modal, the phone's
  `chat.page`). `core/codex-chat.ts` reads the rollout with codex's own rules, never claude's
  resolver. It takes USER text from the UI stream only: `event_msg/user_message` (legacy, ≤ 0.146) or
  an `item_completed` `UserMessage` (paginated, ≥ 0.151). Model-side `role:user` messages also carry
  injected context (AGENTS.md, `<environment_context>`, image wrappers), so they are never read.
  Assistant text and tools come from `response_item`, correlated by `call_id`. The UI copies
  (`agent_message`, `AgentMessage`) and reasoning are skipped. Failed and interrupted turns become
  `[error] …` / `[turn aborted…]` notes. A tool result drops codex's `… Output:` preamble. The rollout
  is append-only, so it pages by byte offset like claude. The locator matches a WHOLE-uuid thread id
  (`CODEX_THREAD_ID_RE`), because a uuid's last group passes `SESSION_ID_RE` and suffix-matches
  another thread's file. It searches only the node's own account home, and uses the codex tail's hook
  path only as a checked hint. An SSH node is read on its host (`main/remote-codex-chat-page.ts`,
  through the same resolvers as its remote meter) or not at all. Because codex announces no session
  end, a chat send first asks the kernel (`renderer/lib/chatPaneGate.ts`, `isAgentPane`). After a
  `/quit` the store still reads `done`, and the message would otherwise run in the shell. **Not
  supported:** images in prompts, reasoning summaries, the composer's model/effort labels (the
  `/model` picker is measured for claude only), plan/question answer cards (codex never sets
  `held`), and a closed REMOTE session's transcript. Record rules and fixtures:
  `src/shared/chat-fixtures/codex/`.
- **opencode in the ⌘M chat view** (2026-09-28, opencode 1.18.25 measured) — opencode has NO
  transcript file (SQLite since 1.18; that database also holds its account tokens and is never
  opened), so `readChatTranscript` routes `capabilityAgentId(agentId) === 'opencode'` to
  `core/opencode-chat.ts`, which runs `opencode export <sessionId>` (argv only, no flag an older
  yargs-strict CLI might refuse) and parses the one JSON document into claude's `ChatMessage` shape:
  user/assistant text, tool chips (arg by an opencode key order, result = 3 lines / 500 units,
  `Error: …` on a failed call), `[name] message` for an errored turn, compaction/subtask chips,
  `at` from `time.created`, `model`/`effort` from the newest assistant's `modelID`/`variant`.
  Reasoning, `synthetic`/`ignored` text, file/agent parts and step bookkeeping are dropped;
  unmappable shapes are skipped and counted. **One page, always** (`olderCursor: null`): there are
  no byte offsets to page by. The page honours the caller's `maxBytes` (the phone asks 256 KB),
  grows ×4 up to 5 MB like claude's reader when it holds no whole message, and shows a newest
  message larger than 5 MB TRUNCATED (with a note) rather than as an empty conversation. Refusals: no/unsafe session id runs
  nothing (a bare `opencode export` opens a picker over the NEWEST sessions — someone else's); an
  export whose `info.id` is another session is `unreadable`; only `Session not found: <id>` with
  exit 1 and empty stdout is a clean miss. **Remote (SSH) nodes are refused** (`unreadable`, no
  export runs) — their sessions are in the host's database and there is no remote leg yet; the
  panel's copy names both causes an opencode `unreadable` can have. One export costs 1.0–1.7 s and
  ~320 MB, so `createOpencodeExportGate` runs at most one per session (a caller arriving mid-run
  gets a FRESH export) and two in total; the panel's hook-driven refreshes are marked
  `page.background` and spaced ≥ 5 s per session, while an open / ↻ / Retry is immediate (and wakes
  a sleeping background one). A **change gate** in front of it `stat`s (never opens) opencode's
  `opencode*.db` + `-wal` in `$XDG_DATA_HOME/opencode` (else `~/.local/share/opencode`, opencode's
  own xdg-basedir rule) BEFORE exporting, and an unchanged fingerprint answers from a 4-session LRU
  of parsed exports; no db file found, or `OPENCODE_DB` set, means no caching. The export runs with
  `cwd: os.tmpdir()` (from a repo cwd opencode writes `<repo>/.git/opencode`; sessions resolve by
  global id). **It inherits the APP's `process.env`, not the node's shell env**: a user who
  relocates opencode's data via `XDG_DATA_HOME` / `OPENCODE_*` only in their shell rc gets
  "Session not found" — an honest miss, not a bug in the reader. Plan/question answer
  cards stay claude-only (no `body`/`questions` on opencode's `question` tool). Desktop and Server
  Edition both serve it (core handler); the phone gets it over the relay `chat.page` for free.
  Fixtures + the exact rules for the iOS port: `src/shared/chat-fixtures/opencode/README.md`.
- **Gemini + codex parity** (2026-08-09) — brought both up to grok's level in the lists above. Unlike
  grok, **both CLIs are installed** and gemini **ships its own hook reference**
  (`/usr/lib/node_modules/@google/gemini-cli/bundle/docs/hooks/reference.md`), so almost every fact is
  measured. The load-bearing ones:
  - **Gemini's envelope IS claude-shaped** — `session_id`/`transcript_path`/`cwd`/`hook_event_name`
    (`reference.md:46-58`), the exact opposite of grok's missing `transcript_path`, so the shells just
    jail the path they are handed. The **event names** are gemini's own: eleven exist, `GEMINI_HOOK_EVENTS`
    subscribes **seven**. `AfterModel` is excluded because it fires **per streamed chunk**
    (`reference.md:236`) = one hook process per chunk; `BeforeModel` is **not** per-chunk (it fires once
    per request) and is excluded only because it reports nothing we render.
  - **`Notification` → `blocked`, matched as a CLOSED set** (`notification_type === 'ToolPermission'`).
    Before this, a gemini node sat on RUNNING while it waited for a permission answer. The closed match
    is measured, not cautious: gemini's `NotificationType` enum has exactly ONE member, and it fires
    only after `shouldConfirmExecute` returns details — i.e. only for a real dialog, so an
    auto-approved/`yolo` call fires nothing. **Grok's `includes('permission')` strobed on every tool
    call**; widening this "to be safe" is the unsafe direction.
  - **Context meter from each agent's own transcript** — one tail per agent, each with its own `parse`
    dep on `createContextTail` (`core/gemini-session.ts`, `core/codex-session.ts`), in **both** shells.
    Gemini: `tokens.input` and a window from `geminiWindowFor`, which mirrors the CLI's own
    `tokenLimit()` — a **family rule with a 1M catch-all default**, so an unknown model gets the right
    answer instead of a confident wrong denominator. Codex: `last_token_usage.input_tokens` and its own
    stated `model_context_window`. Two traps: `total_token_usage` is **CUMULATIVE** (would render a
    13%-full session at 79%), and `cached` is **INSIDE** `input` for both — while claude's input
    *excludes* cache reads, which is why claude sums them. **The formulas must not be unified.**
    The transcript jail is widened **per root** (`~/.gemini/tmp`, `<codexHome>/sessions`), never to
    `$HOME` — that predicate exists so a forged hook POST cannot aim a read at `~/.ssh/id_rsa`.
  - **`hasUsage` gated THREE features, not one.** Joining `USAGE_CAPABLE` also switched on
    `context.ensure` and the find bar's transcript index, both of which go through claude's
    `resolveTranscript` — whose **cwd fallback** then handed a codex node *the newest claude transcript
    for that cwd*: a stranger's session as its meter and its search hits. Gated by the pure
    `readsClaudeTranscript` (`renderer/lib/transcriptGates.ts`) rather than by a fourth list.
    `context.ensure` LEFT that gate in 2026-09 (issue #813) once its handler stopped *being* claude's
    resolver — see **Context-meter rehydration** below; the find bar's index still has no routing and
    so has not moved. The lasting rule is the one the episode taught: **grep every consumer of a
    helper before adding an id to its list**, and when two consumers need different answers, route
    the one that can be routed instead of widening the gate for both.
  - **`TITLE_READ_CAPABLE` was created here**: gemini names its own sessions through its `update_topic`
    tool (the title is in that call's `args.title`, NOT a top-level field) but has no rename command, so
    the read and write legs split. Its read path is the transcript the context tail already tracks
    (injected as `AgentSessionNameDeps.geminiPathFor`, held in a `let` in `src/main/index.ts` to avoid a
    TDZ throw that would kill a node's whole poll chain).
  - **In-place restart** works for gemini: `EXIT_SEQUENCES.gemini = '/quit'` — and it must stay **bare**,
    because `/quit --delete` exits *and permanently deletes* the session history, i.e. exactly what the
    restart exists to resume (pinned by its own test).
  Full picture, measurements, gaps and a device checklist: **`docs/gemini-agent.md`**.
- **Gemini CLI refuses personal Google accounts since 2026-06-18** (free / AI Pro / AI Ultra moved to
  Antigravity CLI — the `antigravity` agent above; Code Assist Standard/Enterprise, Vertex AI and paid
  API keys still work, so `gemini` stays a builtin). The refusal happens before any session, so no
  hook reports it: a gemini-harness node reads its own pane for the CLI's sentence
  (`renderer/terminal/gemini-retired.ts`, letters-and-digits match because the TUI wraps it in a
  box) and raises a slim banner — "Open Antigravity" (`nodeterm:open-agent`, an agy node beside it,
  in its frame) + Google's migration guide. It types and relaunches NOTHING, which is why a phrase
  match is enough here where `resume-fallback.ts` needs three refusals. `AgentConfig.notice` carries
  the one-line caveat to the menus/Dock tooltips; it is never read to decide behaviour.
- **Gemini ⌘M chat view** (2026-09, `core/gemini-chat.ts`) — gemini is in `CHAT_CAPABLE` with its own
  reader, routed in `readChatTranscript` via `capabilityAgentId` BEFORE anything claude-shaped and
  located only by the header session id (`locateGemini`, which now reads just the header and honours
  `GEMINI_CLI_HOME`). Its session file is an UPSERT log, not a message list: one id is rewritten in
  full as tool results/tokens land, `$rewindTo` truncates, and `$set.messages` replaces the MODEL's
  context at start, compression and rollback. The thread is the message records upserted by id with
  rewinds honoured and **`$set.messages` ignored** — honouring it erases the thread at every
  compression and shows the `<state_snapshot>` as the human's words. Not paged (a record depends on
  earlier ones): one read under the 5 MB cap, `olderCursor: null`, like grok. Shows typed prompts
  (`displayContent` over `@file` expansion; `<session_context>`/`<hook_context>` dropped per part),
  replies, tool calls with results, `[info]`/`[warning]`/`[error]` notes and (paged) the model;
  thinking is dropped. NOT supported: remote (SSH) nodes (`CHAT_LOCAL_ONLY` → "not supported yet"),
  plan/question answer cards, the composer's model/effort labels. The phone gets it over the relay
  unchanged; fixtures and exact rules: `src/shared/chat-fixtures/gemini/`, `docs/gemini-agent.md` §3.
- **Claude session context capacity (#818)** — the managed hook reports only
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` from the effective Claude process environment (including
  `--settings` env), never the GUI/server process environment. HookServer validates decimal safe
  integers and verified node identity before passing optional `contextWindow` metadata to BOTH
  shells. Missing metadata means an older/unverified hook; explicit null means the current hook
  observed no valid override and clears the old observation. Local and SSH tails apply the exact
  per-session limit before the family estimate, including SMALLER limits; equal model ids do not
  share configuration. The renderer labels family fallbacks as estimates. Claude observations are
  not loaded from localStorage: `context.ensure` rehydrates usage, and until another verified hook
  observes the session env an idle Claude session has only an estimated window. No arbitrary
  endpoint fields, credentials, config-file reads or CLI commands are involved. A changed transcript
  starts fresh tracked state; unchanged hook observations never replay usage. Only `context.ensure`
  explicitly replays the live snapshot for a remounted consumer. Async reads from replaced/untracked
  entries cannot publish.
  Desktop and Server share validation; the SSH tail receives the remote hook's own env. Canvas and
  kanban share ContextMeter. Mobile's separate implementation needs the same provenance distinction.
  Gateway catalogue/accepted-launch work remains in #723/#725; this does not replace those PRs.
