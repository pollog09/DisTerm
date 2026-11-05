# Agent state, context meter and permission mode

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Agent state, context meter and permission mode

- **SSH context polling is a bounded byte protocol** (issue #816). The initial snapshot reads
  only the last 1 MiB and records the absolute end offset; subsequent polls process at most
  1 MiB. `core/remote-ssh/transcript-window.ts` measures size and uses block-aligned POSIX `dd`
  with base64, transferring less than 1.6 MiB including alignment/framing; idle replies contain
  only the size/range header. The encoded dd exit status must survive the shell pipeline:
  pipeline success alone can hide a failed read. Short/malformed replies and SSH failures throw,
  retain the cursor, and back off from 2s to 60s with payload-free diagnostics — logged when a
  streak starts, when it settles at 60 s and when it recovers, never per retry, and naming only the
  observed status (`exit 255`, `malformed reply`), never a guessed cause: the runner reports a
  timeout as status 1. **A transcript that does not exist is not a failure.** Claude creates it on
  the first prompt while SessionStart already hands over the path (measured on 2.1.283), so every
  unused remote Claude node used to walk the failure backoff and log a line a minute. The command
  answers `NODETERM_ABSENT` with status 0 and the tail polls it on the idle cadence; a file that
  appears after being seen missing is live from byte 0 when its bootstrap window covers all of it.
  A SEPARATE idle backoff (`idleDelayMs`) stretches the 1 s poll after three consecutive empty successful reads
  (2/4/8 s, capped at 10 s) and is reset by any data-bearing read and by every same-ref `track()`
  — i.e. every hook POST for the session, which is what keeps a `<task-notification>` (it rides
  a UserPromptSubmit hook) at ~1 s latency; never merge it with the failure backoff. That same
  `track()` also skips the rest of a pending failure wait (the host just reached us) but keeps the
  failure streak, so a read that fails again goes straight back to 60 s. Bootstrap and
  detected truncation restore usage without replaying historical task notifications/tool results,
  including a historical partial line completed later. A changed remote reference replaces its
  tracking generation so stale in-flight replies cannot publish. Server Edition uses the local
  core tail on its host (no SSH-project manager); mobile has its own direct-SSH implementation,
  so this desktop fix makes no claim about that separate path. Real `/bin/sh` fixtures cover
  >20 MiB idle files and a new notification split inside UTF-8; BSD/macOS SSH remains a device check.
- **Context-meter rehydration (`context:ensure`)** — the meter is fed by hook events, and a tmux
  session outlives the app, so a continuing session that is idle after a restart emits nothing and
  its meter stays blank until the user's next prompt. The mount-time read that exists to close that
  is `core/context-ensure.ts` (`registerContextEnsureIpc`), **in core so BOTH shells serve it** — it
  used to be inline in `src/main/index.ts` and the Server Edition had no handler at all, so a browser
  node's meter filled only on its next turn too (issue #813; the identical hole
  `core/transcript-ipc.ts` was moved to core to close). Three rules:
  - **It routes per agent; it does not widen a gate.** `agentId` picks that agent's OWN locator and
    tail — claude → `resolveTranscript`, codex → `locateCodex`, gemini → `locateGemini` (the last two
    keyed STRICTLY by session id, no cwd fallback, so neither can adopt a session that is not its
    own). A closed switch: an agent that is not in it gets **no meter**, never claude's resolver.
    That is what let the renderer gate move from `readsClaudeTranscript` to `showUsage` — the danger
    was never the meter, it was one resolver answering for four agents. **grok is deliberately
    absent**: its meter reads a `signals.json` whose directory is learned from a hook event, so after
    a restart there is nothing to rehydrate FROM (`locateGrok` resolves a different file, the
    conversation). Structural, not pending.
  - **A remote node is resolved on its HOST or not at all.** The desktop injects `ensureRemote`,
    which asks the host through `remoteTranscriptRefFor` — the ⌘M path's locator, jail
    (`isSafeRemoteTranscriptPath`) and cache, reused as a second consumer rather than copied. Its
    "could not resolve" is **terminal**: falling through to any local resolver would search THIS
    machine for a file that only ever existed on the other one, and claude's cwd fallback would
    happily meter an unrelated local session under the remote node's id. Remote Codex uses its own account-scoped locator and parser over the same bounded SSH
    reader. Its reported transcript window wins; Claude estimates must never supply a Codex
    denominator. Unresolved/disconnected remote nodes cannot fall through to local readers.
  - **Nothing negative is ever cached.** A clean miss and a failed ssh call are indistinguishable to
    the locator, so both cache NOTHING and the next mount retries in full — a momentarily dead
    ControlMaster must not be remembered as "this session has no transcript", or the meter stays
    blank until the next turn anyway, which is the bug arriving by another route. The only
    de-duplication is of **concurrent in-flight** calls (a canvas mounts dozens of remote nodes at
    once and each resolve is an ssh exec on someone else's machine); it releases on settle, so it is
    not a cache. **No timer** — one read at mount, the same rule Remote usage and session memory
    follow.
  Surfaces: Desktop full; **Server Edition** full and local-only (it runs ON the host whose
  transcripts it reads — the legitimate asymmetry, stated the way the SSH skip is); kanban card +
  card modal render the same `ContextMeter` from the same store and inherit it; mobile N/A (its own
  context display, separate path). Tests: `core/context-ensure.test.ts` (routing, remote
  fall-through, no negative cache) + `main/context-ensure-wiring.test.ts` (the shell's closure, at
  source level, because it closes over `ptyManager`/`sshProjectManager`).
- **Permission mode** (agents in `PERMISSION_MODE_CAPABLE` — claude, grok, **gemini**, **codex**) —
  the mode a session **starts** in (`claude --permission-mode <mode>`; Shift+Tab still cycles it at
  runtime). Membership no longer implies claude's flag spelling: **the per-agent translation lives in
  `src/shared/agents/approval-mode.ts`** (`approvalFlags` / `modeSupported`), which is also where
  `withPermissionMode` now lives — it moved one layer up out of `config.ts` to break a cycle.
  gemini = `--approval-mode default|auto_edit|yolo|plan`, codex = `--ask-for-approval
  on-request|never` (and `untrusted` too, but only on a codex that still has it — see the next
  paragraph). Two rules the mapping exists to enforce: a mode the CLI **cannot
  express emits NO flag**, never a substituted nearest match (codex has no `plan` and no
  edit-specific mode; **gemini has no `auto`** — nothing in its vocabulary means "approve most things
  but not edits", and since `auto` is the DEFAULT mode, mapping it to `auto_edit` would have switched
  auto-approve-edits on for every existing gemini node at upgrade time, silently), and "supports"
  must not be a lie either — codex's `manual` maps to
  `untrusted` because its built-in default is `OnRequest` (measured: `codex doctor`, no `approval`
  key in `~/.codex/config.toml`), so leaving it unflagged would deliver "the model decides when to
  ask" under an "Ask each time" label. **codex is the first agent where `manual` emits a flag.** The
  UI copy is DERIVED from the mapping (`permissionModeAgentIds` / `permissionModeAgentsLabel` /
  `unsupportedModesNote` / `bypassSandboxCaveat`) so a sentence cannot drift from what the table
  does — so the note now reads "Auto has no Gemini equivalent…" beside codex's gaps, and the
  residual wart is only that `auto` and `manual` land on the same gemini policy (the *prompting* one).
  `--sandbox` is a separate axis and deliberately untouched (`--ask-for-approval never`
  still sandboxes).
  **AN AGENT'S VOCABULARY IS NOT A CONSTANT — codex's moved, and the table is gated on a probe of
  the binary in front of us (#785).** Measured release by release on the published linux-x64
  binaries: 0.146.0 / 0.147.0 / 0.148.0 advertise `untrusted, on-request, never`; **0.149.0**
  through 0.154.0 advertise `on-request, never`. clap does not ignore a value it does not know, it
  prints `error: invalid value 'untrusted'` and **exits**, so a Manual-mode Codex node launched from
  the pinned table died at the prompt and left the pane at a bare shell. The gate is codex's OWN and
  sits beside claude's, never inside it (a gate fed by `claude --version` belongs to claude):
  **`core/codex-cli.ts`** reads `codex --help` once per app run — FEATURE-detected, not
  version-compared, because a floor guesses about builds that are not on npm — parses the option's
  own slice with `codexApprovalValuesFrom` (the neighbouring `-s, --sandbox` carries its own
  `[possible values: …]` two lines up, and a page-wide scan emits `--ask-for-approval read-only`),
  and publishes `CodexCliCaps` over `codex.cliCaps()`, registered by **both** shells. Every emitter
  threads it as `ApprovalCaps` — `approvalFlags` / `modeSupported` / `withPermissionMode` /
  `unsupportedModesNote` all take an optional trailing `caps`, and the **omitted** form resolves to
  the BASELINE `['on-request','never']`, the two values every measured codex accepts. That default
  is the design: a call site that forgets to thread its probe result loses a mode, never a launch.
  On 0.149.0+ `modeSupported('codex','manual')` is **false** and the derived note says so —
  measured before concluding it: `-a unless-trusted` is refused, `-c approval_policy=untrusted`
  fails config load, and `--approve-for-me` routes approvals through *automatic* review. **Remote is
  unknown, never guessed**: an SSH node runs the HOST's codex and there is no remote codex probe yet
  (claude has one, at connect), so `codexApprovalCaps(ssh)` and the mirror's SSH slice publish
  nothing and fall to the baseline. Same for a relay tab (the guest's machine) — its stub answers
  unknown on purpose. Three surfaces: **Desktop** and **Server Edition** both probe their own
  machine (the server's `registerCodexCliIpc` is REAL, unlike its deliberately-false
  `registerCodexIdentityIpc`); **Mobile** gets the vocabulary as `MirrorSettings.codexApprovalValues`
  — the desktop/server now publish it, the iOS reader is the follow-up. The app-server **usage
  tier** (`usage/codex-usage.ts`) carried the same dead `-a untrusted` and silently returned null on
  every current CLI; it is now `-a never` with **no probe**, because `never` is in both vocabularies
  (measured against 0.148.0 / 0.151.0 / 0.154.0) and `-s read-only` is what actually guards the
  user's files.
  `settings.claudePermissionMode` (global, default **`auto`** — a behavior change for existing
  users, who previously got a prompt per action) is overridden per project by
  `project.defaultPermissionMode` (persisted to `.nodeterm/project.json`, so a `bypassPermissions`
  override travels to everyone who clones the repo — the tab menu warns). Modes are
  `manual | auto | acceptEdits | plan | bypassPermissions`, labelled once in
  `PERMISSION_MODE_LABELS` (from which `ALL_PERMISSION_MODES` is derived — the dropdown and the
  validator can't desync). `resolvePermissionMode(project, settings)` is the resolver
  (`renderer/state/permissionMode.ts` `activePermissionMode(agentId)` binds it to the live stores **and
  applies the version gate below — for `agentId === 'claude'` only**), and
  **`withPermissionMode(cmd, agentId, mode)` is the single
  funnel through which every agent-node launch site appends the flag** (new node, cold-restore
  resume, Branch, handoff/transfer, explain-commit, add-agent, canvas-control open-agent + team
  spawn). **WHERE the flag lands is decided at the composed layer** (`createAgentNode`), not in
  `withPermissionMode`: with no `argvPromptSeparator` (claude) it goes LAST, keeping the historical
  command byte-identical; with one (grok's `--`) it must go **BEFORE** the separator, because `--` is
  end-of-options and a flag after it is a positional — silently swallowed into the prompt or a clap
  usage error. Assert that at `createAgentNode`; a `withPermissionMode` test passes while the composed
  line is wrong. (gemini and codex declare no separator, so their flag goes last and their command
  lines stay byte-identical; grok is still the only agent taking the other branch.)
  UI: Settings → Agents, and the tab ⌄ menu for the per-project override.
  **Version gate (`auto` only) — CLAUDE's alone:** `--permission-mode auto` exists only in **Claude Code ≥ 2.1.71**;
  older CLIs validate the value against their own choices list and **exit 1** — and `auto` is the
  default, so an ungated flag would kill every Claude launch on an older CLI. So the CLI is probed
  (`core/claude-cli.ts` → `claude --version`, memoized, registered on `CorePlatform` so **both**
  shells serve it; reached from the renderer via `window.nodeTerminal.claude.cliCaps()`, with a
  **real** ws-bridge implementation) and `gatePermissionMode(mode, autoSupported)` degrades **only
  `auto`**, and only to `manual` = **no flag** = the bare pre-feature command. Everything **fails
  open**: unknown/unreadable version, a probe that failed or hasn't answered yet ⇒ bare command,
  never a blocked launch; the other four modes are never touched by the gate, and the user's
  *setting* stays `auto` (only the emitted command line changes). **SSH projects** are gated on the
  **remote** host's CLI, never the local one: `SshProjectManager.connect` probes `claude --version`
  on the host (through a login shell — an ssh exec channel's rc file usually bails out early — with
  `$HOME/.local/bin` + `$HOME/.claude/local` prepended to PATH: the official installer targets
  `~/.local/bin`, which a stock root `.profile` never adds, so a host whose interactive shells run
  claude fine still probed "not found" and silently degraded `auto` to manual) and
  caches the answer on the connection → `useSshConn`; not connected / not yet probed ⇒ no `auto`
  flag. A FAILED remote probe (claude not found — often a transient login-shell hiccup) **retries
  on a bounded backoff** (`PROBE_RETRY_DELAYS_MS`; every attempt pushes its answer immediately so
  launch waiters never block on the retry tail; a definite version — old or new — never retries),
  and the status event carries `remoteClaudeVersion` (`null` = probe failed) beside the boolean.
  The cold-restore relaunch `await`s the (shell-warmed) local probe because it fires on mount —
  and on an SSH project whose resolved mode is `auto` it also waits (`SSH_AUTO_PROBE_WAIT_MS`,
  bounded, fail-open) for the REMOTE probe's first answer, which races the same mount. Because
  the degrade is silent by design, the tab menu's Auto rows surface it: `sshAutoModeHint`
  (tri-state `useSshConn.autoPermAnswer` + probed version) puts a ⚠︎ + tooltip on "Auto" / "Use
  global (Auto)" for an SSH project whose remote CLI is too old / missing / not yet probed.
  **Security:** mode values come from hand-editable, git-shared JSON and end up interpolated into
  a shell command line (tmux `send-keys`), so `permissionModeFlag` **re-validates** the mode at the
  interpolation site (the type is compile-time only) — an unrecognized mode yields **no flag**, i.e.
  the bare, safe command. `'manual'` likewise yields no flag, reproducing the pre-feature command
  bit-for-bit. The setting and the per-project override apply to **terminal (CLI) agent nodes only**
  (the SDK **chat node**, which never honored it, was removed 2026-07). **No other agent inherits this
  gate:** grok has accepted every mode since 1.0.0 and gemini/codex accept theirs on the versions we
  measured, so gating any of them on a `claude --version` probe would
  downgrade their sessions on a machine whose claude is old or absent — `activePermissionMode` gates
  only `'claude'`, `ensureActivePermissionMode` awaits the probes only for `'claude'`, and
  `sshAutoModeHint`'s copy names Claude in every sentence for the same reason. An agent needing its
  own gate adds one beside claude's.
- **State via each agent's hooks → shared 4-state model** — detection uses the agent's own
  hooks, **not** output parsing. `src/shared/agents/normalize.ts` has per-agent normalizers
  (`normalizeClaude`/`normalizeCodex`/`normalizeGemini`/`normalizeCopilot`/`normalizeOpencode`/`normalizeGrok`/`normalizeAntigravity`) that map each agent's native hook
  events to a `NormalizedAgentEvent` over the shared `AgentState` (`working | waiting | blocked
  | done`) plus subagent/recurring/session kinds. Canvas's listener consumes
  `NormalizedAgentEvent` from `agent:status` and hands it to `applyAgentEvent`, the pure reducer
  that does every store write (state, session id, account, loop, subagent cards) and reports which
  alert the event raised; the listener keeps what is a fact about THIS window — the unread mark and
  its ack, the sound, the throttled (5s/node) background notifications, the handoff fold. A relay
  session feeds the same reducer into its own keyless store (`wireRelayAgentStatus`), with no ack,
  sound, notification or subagent cards. Header shows a pulsing
  **RUNNING** (working) / **NEEDS YOU** (waiting/blocked) badge.
- **DROPPED — the CLI died and nobody told us** (`renderer/terminal/agent-liveness.ts`, issue #616).
  Every ORDERLY exit announces itself: Eco's `/exit` sets `hibernated`, "Pause session" sets
  `paused`, and a user typing `/exit` fires the CLI's own SessionEnd, which `setState(id, undefined)`
  records. A KILL announces nothing — the process is gone before it can run a hook, and tmux's shell
  still owns the pane so the PTY never closes. The node therefore kept rendering its last badge over
  a dead conversation, with the CLI's parting `Resume this session with: claude --resume <uuid>` and
  a stray `^[%` in the pane as the only evidence. Not exotic: measured on the reporting host
  (2026-09-04) 62 GB RAM with swap fully consumed, kernel `oom_kill` at 187, 147 live `claude`
  processes holding 44 GB. The signal is `#{pane_current_command}` reading as a shell while the
  status table still believes an agent is parked there, and the four refusals are the feature:
  a `null` pane read is NEVER evidence (a downed ControlMaster must not make a canvas of healthy
  remote nodes claim they died); `hibernated`/`paused` are our own exits and already have chips;
  **only `done`**, never `working` — a turn in flight is exactly when a tool subprocess can own the
  pane's foreground, so the alarm would fire on a healthy agent running a shell command; and the
  agent must be in **`SESSION_END_CAPABLE`**. That last list is the false-positive gate and is
  DERIVED from `normalize.ts`, not chosen: exactly four normalizers map `sessionPhase: 'end'`
  (claude, gemini, copilot, grok) and **codex and opencode map none**, so on those two a deliberate
  `/quit` and an OOM kill leave byte-identical evidence and the chip would be a coin flip shown as a
  fact. Adding an id without first adding its normalizer branch puts a chip on every session its
  owner quit on purpose — `agent-liveness.test.ts` asserts the list against that source. The verdict
  (`agentStatus.dropped`) is TRANSIENT, a stronger call than the other clocks: it is a claim about a
  pane, panes are re-measurable in milliseconds, and a persisted one would strand a stale chip on a
  node someone resumed by hand. ANY hook event withdraws it — the one self-heal that deliberately
  does not gate on `alive`, since `done` disproves "there is no CLI in this pane" even though it must
  not clear `hibernated`. Cost is bounded by asking only for a node that is BOTH watched and already
  believed to be a parked agent. Resume reuses the hibernation wake closure unchanged, which
  re-reads the pane and refuses anything that is not a shell. Chip on the node header, the kanban
  card and the card modal; Desktop and Server Edition identical; relay tabs answer `null` and are
  never judged. **A second thing this catches, unplanned:** in the same sweep 9 of 149 panes sat at a
  bare shell because a cold-restore `--resume` had answered *"No conversation found with session
  ID"* — the persisted `sessionId` outlived its transcript. The chip surfaces those too, but the
  Resume it offers still replays that dead id — but cold restore no longer creates the state: it
  probes `transcript:exists` first and launches bare on a positive `absent`, saying so on the node
  (see **Cold restore** above). Re-measured on the same host 2026-09-09: **20** of 108.
- **An interrupted Claude turn (Esc / Ctrl+C) fires NO hook — the transcript marker ends it**
  (`core/claude-turn-interrupt.test.ts`, fixture `shared/agents/__fixtures__/claude/interrupt-capture.json`).
  MEASURED on Claude Code **2.1.285**, interactive TUI in a private tmux server, capture hooks via
  `--settings`, every `NODETERM_*` unset: Esc while it streams, Esc during a foreground tool call,
  Esc on a permission dialog, and Ctrl+C once mid-stream each fire **nothing** — no `Stop`, no
  `StopFailure`, no `PostToolUse(Failure)`, and **no `idle_prompt` either**: that notification came
  60 s after a NORMAL `Stop` but not in 75 s / 80 s after an interrupt, so the `idle` rescue in
  `normalizeClaude` does not cover this case. Before this a node sat on RUNNING (or NEEDS YOU, for a
  dismissed permission dialog) until the 20-min stale sweep: `--after` dependents waited, Eco never
  saw it idle, the notch and the phone showed it working. What the interrupt DOES leave is a USER
  record, content `[{type:'text', text:'[Request interrupted by user]'}]` (`… for tool use]` when a
  tool call or its dialog was cancelled), whose **`promptId` equals the turn's `UserPromptSubmit`
  `prompt_id`** in every capture. Wiring, and the rules it rests on:
  - `normalizeClaude` puts `prompt_id` on the `UserPromptSubmit` event as **`turnId`**; the mirror
    keeps it (`MirrorEntry.turnId`, runtime-only, dropped at a session boundary).
  - The claude context tails (local, and the desktop's SSH one) scan COMPLETE lines with ONE
    stateful scanner per tracked transcript (`createTurnInterruptScanner`): a CLOSED set of the two
    texts, array content with exactly that one text part, non-sidechain (a typed prompt is a plain
    string, so typing the words matches nothing) — **and a marker counts for turn P only if P's
    OPENING prompt record was read BEFORE it** (bounded set of seen prompt ids, 256). The id alone
    is NOT enough, and this is not theoretical: in real transcripts on the dev host (2.1.209–2.1.283)
    34 of 114 accepted-shape markers carried the promptId of the prompt written AFTER them — "queue a
    message while Claude works, then Esc": the CLI tags the marker with the QUEUED prompt's id and
    writes that prompt ~36 ms later, and its `UserPromptSubmit` has already made it the node's
    current turn, so an id-only match ended the NEW live turn (fixture
    `__fixtures__/claude/interrupt-queued.json`). Measured on this host after the fix: all 26
    queued-shape markers rejected, no real interrupt lost. The one interrupt this drops is the one
    it cannot place; the interrupted turn really ended and the node is already in the next one. The
    remote tail's historical first read records prompts but never reports.
  - **Both shells** check the marker with `turnInterruptEvent` (a mirror PEEK) and push the result
    through their ONE hook-event path — desktop `emitAgentStatus` (mirror, broadcast, Notch HUD,
    agent messaging, station notices), Server Edition `emit` (mirror, broadcast, `opts.onEvent`:
    its delivery queue and `--after` scheduler). Pinned in `hook-verified-parity.test.ts`. It ends
    the turn ONLY when the marker names the node's CURRENT turn (same session, same `turnId`, state
    working/blocked/waiting): a marker read back from history, one from a finished turn or another
    session, one after a restart (no `turnId` then) changes nothing. A prompt event whose
    `prompt_id` is missing or not a plain token carries `turnId: ''`, which makes the mirror FORGET
    the previous id. The event is an ordinary `done` + `interrupted` (what a `Stop` with
    `is_interrupt` already produced), UNverified (a transcript read is not a hook POST), so no
    completion alert and the question/approval resets apply unchanged.
  - **`--after` does NOT release on an interrupted turn** (decision, 2026-09-30): the person
    stopped it, usually to redirect it, and the dependent would start on unfinished work — #521's
    reasoning for an errored turn. It is its OWN annotation, `agentStatus.lastTurnInterrupted`
    (transient; set by an interrupted `done`, cleared by a new turn or a `done` that is not
    interrupted), read by `depSatisfied`, the QUEUED tooltip (`interruptedDeps`), `list`
    (`LAST TURN INTERRUPTED`; an error outranks it), the canvas's `armedDepSig` (a verdict can clear
    under a steady `done` — a guessed interrupt then the real Stop — and the launch effect must
    re-run) and team progress (its own `interrupted` kind, NOT counted as done, so the ring never
    says "finished" beside a held dependent). It is deliberately NOT `lastTurnError`: the TURN
    FAILED chip, the station-failure notice and issue runs do not treat an interrupt as a failure.
    **The `idle_prompt` rescue does NOT set it** (`recordsTurnInterrupt`): it is flagged
    `interrupted` only to stay silent, and since `idle_prompt` follows a NORMAL Stop, a rescue means
    a lost Stop POST on a turn that finished — its dependents release as before. ▶ / `run` still
    start the dependent. The renderer's older keystroke
    guess (`inferInterruptAfterSettle`, 1.5 s after a lone Esc/Ctrl-C typed into THAT terminal)
    now records an interrupted `done` too, so a guess cannot release dependents before the marker
    lands; it stays because it is the only signal for the next case.
  - **Residual, measured:** Esc or Ctrl+C BEFORE the first token rewinds the prompt into the input
    box and writes NO marker (the transcript ends at the prompt record). Only the renderer guess
    (keystroke in that canvas terminal) sees it; the mirror — notch, phone, Eco's mirror reads, the
    Server Edition's headless `--after` — keeps `working` until the next hook or the stale sweep.
  - **Esc "during a subagent":** on 2.1.285 the Agent tool launched ASYNC even when asked for a
    foreground run, so the parent turn had already ended (`Stop`) — Esc at the prompt then fires
    nothing and does NOT stop the child, whose `SubagentStop` and `<task-notification>` arrive as
    usual. Nothing to fix there; a truly synchronous child being interrupted was not reproducible.
  - Server Edition: same core path (its tail + handler); its own headless `--after` still ignores
    both #521 and this annotation (pre-existing gap). Mobile: gets the `done` through the mirror.
  - **Device checklist:** (a) macOS desktop: Esc mid-stream / mid-tool / on a dialog → RUNNING
    clears within ~1 s, no chime, an armed `--after` dependent stays QUEUED with the interrupted
    tooltip; (b) SSH node: the same over the remote tail; (c) Server Edition browser tab; (d) a
    Claude older than 2.1.285 — whether the marker text and `promptId` match there is unmeasured
    (a changed text or a missing `promptId` matches nothing and degrades to the old behaviour); (e)
    queue a message while a turn runs, then Esc: the node must STAY working on the queued prompt;
    (f) the phone's Live
    Activity ends on the interrupt.

An unanswered Claude `AskUserQuestion` is correlated by session and tool-use ID in the core
mirror, independently of its short-lived display stash. Ordinary hooks, subagent activity and
unrelated transcript results must not clear attention or archive its inbox card. Both shells
use `recordQuestionResult` for transcript rescue (including Escape/decline), and broadcast the
mirror's effective event. Keep result IDs through local and SSH tails; a boolean “some tool
finished” is insufficient. Explicit new user turns, interrupts and session boundaries reset it.

Claude child `PreToolUse`/`PostToolUse`/`PostToolUseFailure` hooks must not drive parent state.
Child `PermissionRequest` and attention `Notification` hooks still reach needs-you and phone
approvals, including the raw approval summary and deterministic reply ticket. Keep raw summary
recording before the child transcript-association guard in both shells.

A held parent question can overlap child permissions: retain its question card and waiting
state while publishing each approval ticket separately. Approval replies resolve only their
own ticket; the picker stays pending until its correlated answer or explicit reset.
When the parent answers first, retain concurrent approval tickets and blocked attention until
their own replies; ordinary tool activity cannot settle them. Explicit turn/session resets
still cancel both kinds of pending attention.

Held approval attention must not replace subagent, recurring or background-task events, or refresh
state evidence from those lifecycle hooks. A parent may ask several questions while a child ticket
is outstanding: track each new picker and preserve child approval cards independently, including
when their display titles match. Answering either resolves only that question or ticket.
