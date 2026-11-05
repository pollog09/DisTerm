# Agent session views: alerts, names, search and the ⌘M chat

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Agent session views: alerts, names, search and the ⌘M chat

- **Unread + notification** — on a busy→idle edge while the window is unfocused
  (`document.hasFocus()`), the node is marked unread (header dot, minimap stroke, project-tab
  dot). If notifications are enabled, `window.nodeTerminal.notify()` → main `app:notify`
  (shown only when `mainWin.isFocused()` is false); clicking it focuses the window and sends
  `app:focus-node` → `Canvas.focusNodeById` (selects + centers, switching projects via
  `pendingFocusRef` if needed). A one-time consent prompt gates notifications; toggle in
  Settings (`notifyOnClaudeDone`). Selecting, focusing, dwelling into, or opening a session card
  clears `unread` and ACKs the finish across phone/notch surfaces — existing read-on-view behavior.
  This NEVER changes the workflow bucket: read state is independent from agent state.
  The unread COUNT is the macOS Dock badge (counted over nodes some project HOLDS, closed ones
  included — never over the raw status table, which outlives nodes deleted by paths that skip
  `remove`; an orphaned entry is swept at load once its 90-day `lastSeen` clock ages out, and the
  sweep is skipped whenever the load is incomplete, `lib/unreadBadge.ts`), and on **Windows** a
  taskbar overlay icon (pure `planBadge` + BGRA rasterizer `rasterizeBadge`, "9+" above nine,
  `main/taskbar-badge.ts`) plus a `flashFrame` when the count RISES while unfocused (cleared on
  focus); Linux shows nothing. Windows toasts need `app.setAppUserModelId` set before ready to the
  package.json `build.appId` the NSIS shortcut carries (`main/app-identity.ts`, pinned by test;
  `execPath` in dev) — without it toasts are dropped or mis-attributed silently (Windows never
  emits Notification `failed`).
- **Sound alerts + custom sounds** (issue #289) — the `done` / `needsYou` alert (`SfxKind`) is a
  synthesized WebAudio chime (`renderer/lib/sfx.ts`, fired from Canvas's `alert` closure, gated by
  `soundEffects`, 5 s/node cooldown). Settings → Notifications lets the user replace either with their
  own file. The picked file's BYTES (never its path) go to `files.saveAlertSound`, a core handler in
  `registerFsHandlers` (both shells), which validates kind / extension allow-list / 5 MB cap / magic
  bytes and writes ONE format-independent name `<userData>/sounds/<kind>.sound` (`core/alert-sounds.ts`;
  a name per format needed a delete-the-others step, and two tabs saving different formats at once
  deleted each other's file — do not reintroduce per-format names); reads and Reset take only the
  kind (no path from the renderer, symlinks refused). Settings keep only
  `customAlertSounds[kind] = {name, stamp}`. Playback decodes the bytes with `decodeAudioData` — no
  `<audio>`, so CSP `media-src` is untouched on both surfaces — and **any failure (missing file,
  refused read, decode/playback error) falls back to the chime without throwing** (`lib/customSfx.ts`,
  read failures and a missing/closed audio context are retried on the next alert; a DECODE failure
  is cached for that `stamp`, so a new pick is tried afresh). Every `playSfx` caller must pass `customAlertSounds` (source-pinned in
  `customSfx.wiring.test.ts`). Server Edition: full — the browser's `<input type=file>` bytes are
  stored in the SERVER's data dir. Mobile: N/A (own notification sounds).
- **Status-grouped sessions** — three always-visible sections: **Waiting for your response** maps
  internal `done`, `waiting`, and `blocked` together (a completed turn, question, or approval all
  need the user); **Running** maps `working`; **Unknown** means no live hook state is available.
  There is no Done bucket: a normal `done` hook means the turn ended and the agent is waiting for
  another user prompt. Within each section rows sort newest-first by `lastEventAt`, the transition
  clock (same-state hook freshness is `stateAt`), and show its short relative age. Missing clocks
  stay last with no made-up timestamp. A click may clear the glow but cannot move the row.
  **The clock survives an app restart as "last seen", never as a state** (`agentStatus.lastSeen`,
  `{at, state}`). `lastEventAt`/`stateAt`/`state` are transient, so before this every row after a
  restart sorted as "no clock" and lost its age. `lastSeen` is the time of the LAST hook event (a
  same-state one included) and the state it asserted, persisted beside the agentStatus record under
  its OWN small key (`nodeterm.agentStatus.lastSeen`) — chosen over the core mirror because the
  sidebar already reads this store,
  the mirror expires state after 6 h and identity later, and reading it would need a new IPC leg for
  a display fact. Rules a refactor must not undo:
  - **Restored as a clock only.** Load fills `lastSeen` and nothing else: `state` stays unknown (the
    hook server was down with the app, so a turn may have started or ended in between), and
    `lastEventAt` stays unset. Load marks the clock `restored` (transient, never written); the row
    reads `lastEventAt ?? lastSeen.at` and its `statusClock` is `transition` / `seen` (a hook event
    this run but no transition yet) / `restored`. Only `restored` says "before nodeterm restarted"
    (`seen 3h ago`, tooltip naming the state it was last seen in). **The first event after a restart
    is usually a SAME-state one** (a cold-restore `--resume` fires SessionStart = `state: undefined`
    on an entry whose state is already unknown), so the store's in-place fast path must not take it:
    it replaces the entry (the row loses `restored` and re-sorts at once) without stamping
    `lastEventAt` (an unknown state is not an idle clock).
  - **Eco never reads it** (so `idleKnown` and `planHibernation` are unchanged). Even a proven-idle
    prompt after boot would not be enough: the background-task stamp and the subagent cards Eco
    also needs are transient and cannot be rebuilt after a restart, and `/exit` kills both
    silently. A session becomes a candidate again from its next live `done`.
  - **Bulk pause is the ONE reader that acts on it** (`idleForPause`, `lib/bulkPause.ts`): an
    unknown-state session is pausable only when `lastSeen.state === 'done'`. The difference from Eco
    is consent and proof, not the clock: a person confirmed the pause, the runner still proves the
    agent owns its pane before typing, and without it every session after a restart would be
    unpausable exactly when memory is tightest. The residual is stated there: a session last seen
    idle that started a turn while the app was closed (cron, loop, task notification) can be
    interrupted. Nothing automatic may read it.
  - **Its own key, so the main table's write cadence is unchanged.** State events still write
    nothing to `nodeterm.agentStatus`. That matters twice: the main table carries `loop.items` (up to
    100 × 4000 chars per loop node — 428 KB and ~2.1 ms per stringify with one full loop, measured in
    review), and on the Server Edition every tab rewrites its whole in-memory table, so a periodic
    rewrite would let tab B undo tab A's `clearUnread`/`hibernated` within seconds. A first version
    stored the clock inside that table on a 2 s THROTTLE and rewrote it every 2 s while any agent
    worked. The clock key is saved on a real TRAILING debounce (5 s quiet, `LAST_SEEN_SAVE_MAX_WAIT_MS`
    30 s at most while never quiet) plus `pagehide`: 2 Hz hook events for 10 s = ONE write. Measured:
    ~59 bytes per clock, 1000 clocks = 59 KB and 0.7 ms per `JSON.stringify` on this dev host. Two
    Server Edition tabs still race on the CLOCK key (last writer wins), which costs only display.
  - **Bounded.** At most `LAST_SEEN_MAX` (1000) newest clocks are written; a clock older than 90 days
    or more than 5 min in the future is refused on load (hand-editable input — a future stamp would
    pin a row to the top); an unknown `state` keeps the time and drops the state; an unreadable clock
    key costs the clocks, never the table.
  - **It cannot create a row**: rows come from canvas nodes, never from the status table.
    `remove(id)` writes the clock key at once, a pending debounced save included; a deletion path
    that bypasses `remove` (e.g. `reloadActiveProject` dropping nodes) leaves a clock that simply
    ages out. Tests: `state/agentStatus.lastSeen.test.ts`.
  - Surfaces: Desktop full; Server Edition per browser profile (localStorage, like `unread`); relay
    tabs keep a keyless store and persist nothing; kanban has no clock-ordered view, so nothing to
    wire there; Mobile N/A (its own state).
- **Session name ⇄ node title** — **two lists, because the two directions are separate facts**:
  `TITLE_READ_CAPABLE` (`canReadTitle` — claude, **codex**, grok, **gemini**) is the READ leg,
  `RENAME_CAPABLE` (`canRename` — claude, grok) the WRITE leg, and **read ⊇ write** is an invariant
  pinned in `config.capabilities.test.ts`. Gemini and codex are the reason: they name their own
  sessions (codex via `readCodexSessionName`) but have **no rename command** (gemini's `/chat save
  <tag>` is a checkpoint, not a title), so one list for both legs would light the rename UI on a
  node where the write silently does nothing. The **write** is the same literal
  `/rename <name>` for claude and grok; the **read** legs are per-agent and none may ever
  search another's tree, so the routing lives in ONE place, `core/agent-session-name.ts`
  (`readAgentSessionName(sessionId, accountId?, agentId?, deps?)` — trailing/optional so every pre-grok
  caller is unchanged), serving the desktop IPC handler **and** both shells' session-name sweeps.
  Grok's read leg is `core/grok-session.ts` over `summary.json` in the session dir a hook told us
  about; gemini's is `pickGeminiTitle` (`core/gemini-session.ts`) over the transcript path its context
  tail already tracks — including the `$set` history a **resume** replays, which is exactly the case the
  read leg exists for. Routing is not cosmetic — claude's resolver *scans* `~/.claude/projects` on a
  cache miss, so an unrouted grok/gemini node paid that scan every 60 s for a guaranteed null.
  **The sweep's gate lives in core, not in the shells:** `startSessionNameSweep` defaults `supports` to
  `supportsTitleRead` (`core/session-name-sweep.ts`) and neither shell passes it — the duplicated copies
  drifted, and reverting both to `canRename` left the whole suite green while silently skipping every
  gemini node.
  - **session → title (read, claude):** the authoritative name lives in the transcript `.jsonl`, not the
    OSC terminal title (`/rename` does **not** update OSC — a known Claude gap — so reading the
    file is the only thing that works after a **resume**). `core/transcript-reader.ts`
    `readSessionName(sessionId)` resolves the session file **strictly by sessionId** (no cwd
    fallback — that would make every Claude node in one folder resolve to the same newest transcript
    and adopt each other's names) and `pickSessionName` returns the latest `custom-title`'s
    `customTitle` (the `/rename` name) else the latest `ai-title`'s `aiTitle` (auto name). Exposed
    over `pty.readSessionName`. `TerminalNode` polls it (~4 s) **only once this node's own sessionId
    is known** and **while the title still auto-tracks** (`data.titleAuto`, default true on agent
    nodes), and adopts it as the `title`. `term.onTitleChange` now feeds the `session` chip only.
    **A poll of an unchanged transcript reads no bytes**: the local read is gated on the resolved
    path's (size, mtime) (`titleCache`, bounded at 500, a failed tail read never cached), and the
    remote one (`main/remote-title-reader.ts`) on the remote context tail's `offsetFor` for the SAME
    path — that offset is the file size at the tail's last read, so a remote `/rename` lands within
    the tail's idle backoff (real gaps between idle reads ≈3/5/9/11 s) PLUS one title poll
    (4–15 s); an untracked session (offset unknown) always reads.
  - **title → session (write):** the moment the user renames the node by hand (header rename box /
    ✦ AI-name / sidebar / command palette → all funnel through `applyManualTitle` or
    `renameSession`), `titleAuto` flips to **false** (polling stops overwriting) and the chosen name
    is pushed into the live session as `/rename <name>` via `pty.sendText` (tmux `send-keys`, same
    one-way bridge as Branch's `/branch`; works whether or not the node is mounted).
  - The launch command is left bare (no `-n`) — Claude's own name is canonical until the user
    overrides it; `titleAuto` is persisted so an overridden name survives reload/resume.
- **Search** — the command palette (⌘K) matches the session name + tags + `nt-<id>` in the
  hint, and substring-searches each terminal's **visible buffer** (captured via `pty.capture`
  on palette open, cached ~3s); content matches show "found in output".
- **⌘M transcript view (`ChatPanel`) — resolution is three-legged, and each leg fails differently.**
  `chat.readTranscript(sessionId, cwd, accountId, nodeId)` returns `ChatTranscriptResult
  {messages, found}`, NOT a bare array: an empty thread and an unresolvable transcript are
  different facts, and rendering both as "No conversation yet." is what made every failure below
  look like an empty session. (1) **Remote (SSH) nodes** — `remoteTranscriptBySession` is fed
  ONLY by hook POSTs, and a tmux session outlives the app, so after a restart an idle remote node
  has no ref and the local resolvers search the WRONG MACHINE. `remoteTranscriptRefFor` (main)
  therefore asks the host itself: the pure `core/remote-transcript-locate.ts` builds one `sh` line
  (exact `<root>/<encoded cwd>/<id>.jsonl` per root, then a glob; account root before the system
  one; `*` outside the quotes; **exits 0 on a clean miss** — "no transcript" is an answer, not a
  failed ssh), it runs over the ControlMaster, and the reply is jailed by
  `isSafeRemoteTranscriptPath` before it is read. A ref WE located is tracked in
  `locatedTranscriptSessions` so a dead one can be dropped on an empty read (the panel's Retry
  would otherwise replay it forever) — a HOOK-fed ref is never dropped that way, since an empty
  read there is usually a transient master hiccup and forgetting it sends the next read local.
  It is generated shell, so `remote-transcript-locate.test.ts` runs it for real under `/bin/sh`
  against a fake host tree — keep it that way.
  **A remote node never falls through to this machine** (2026-09-28): the handler decides
  remoteness from the SHELL's records (`isRemoteNode` dep — live remote pty or
  `workspaceStore.sshProjectIdForNode`, never a renderer flag) and applies `remoteOnly` to the
  paged ⌘M read, the legacy read, the find-bar index (`[]`) and `transcriptExists` (`unknown`).
  The host locate is tri-state (`locateRemoteTranscriptRef`): a CLEAN MISS is `found:false`, a
  failure to ask is `unreadable` ("Couldn't read the transcript.") — the phone's `chat.page` shares
  the same deps and the same distinction. Before this, a mounted SSH node whose locate missed (or
  whose master was down) read THIS machine's resolver, cwd-newest fallback included. `transcriptExists` shares the same locate
  (`remotePresenceFromLocate`: ref/absent/unreadable → present/absent/unknown, a malformed id
  `unknown`), so it also works for a node with no live pty. A remote grok node is read on its host
  by its own leg (`readRemoteGrok`, see the grok chat bullet), with the same absent/unreadable split. (2) **The cwd fallback keeps `accountId`** in BOTH
  `resolveTranscript` and `contextEnsure`; without it a managed-account node fell back to the
  system root and could adopt an unrelated session's newest transcript. (3) **Relay tabs** stay
  local-only (a transcript read over the relay would read the GUEST's disk) and reject with
  `E_UNSUPPORTED`; ChatPanel catches it and says so instead of leaving the initial `[]` on screen
  as an empty conversation. Same `nodeId` rides `claude.readTranscript`, so the find-bar searches
  a remote node's transcript too.
  **Which session id is read is ONE rule, `transcriptSessionFor`** (`renderer/lib/transcriptSession.ts`,
  2026-10): the hook-confirmed `agentStatus.sessionId`, else the id the node was LAUNCHED with
  (`data.agentSessionId` — minted with `--session-id`, or the id "Open recent" resumed). The canvas
  node, the ⌘M hint, the kanban card, the card modal and its viewer all ask it. Before, Chat (and
  the meter) were gated on the hook id alone, so a node whose hook events never reached this app —
  an SSH session pinned for life to a dead hook endpoint, the 107-of-128 case in "A reused
  ControlMaster…" — opened "Markdown view" and showed no meter while its transcript sat on disk
  under an id the node itself had on record; others in the same project opened Chat. The fallback
  is HONEST, because the persisted id can be stale (`/clear` / `/resume` in the CLI moves to
  another session; nothing rewrites `agentSessionId` from hooks): (1) ChatPanel's
  `sessionFallback` prints one quiet line saying so, and the meter's popover says "From the session
  this node was started with"; (2) the read carries **no cwd** (`transcriptReadCwd`), because
  claude's resolver answers a missing id with the newest transcript in the folder — under a
  fallback id that would be a stranger's conversation; the remote locator globs by id without a
  cwd, so SSH nodes are still read on their host; (3) plan/question answer controls are never
  offered on a fallback thread (an answer is a WRITE bound to the live `held` ticket). The composer
  still sends (it types into the pane, which is right whatever the transcript). The persisted id is
  the CREATED agent's, which is exactly the agent both mount sites pick the reader by, and it is
  re-validated against `SAFE_SESSION_ID` (hand-editable project.json). The find bar's transcript
  index still uses the hook id only (it has claude's cwd fallback and no `remoteOnly` here).
  **Both channels live in `core/transcript-ipc.ts` (`registerTranscriptIpc`), so the Server
  Edition serves them too** — it used to have no handler at all, which is why ⌘M in the browser
  read as an empty conversation on EVERY session. The remote leg is an injected dep
  (`readRemote` — `null` = "not a remote session"): `src/main` supplies it, the server passes
  none, which is complete there because it runs ON the host whose transcripts it reads. The
  server registers it in `src/server/index.ts` right after `wireAgentStatus` (which now returns
  its `contextTail`, the hook-fed path authority). The browser's real reader is
  `buildTranscriptApi` in ws-bridge — deliberately NOT folded into `buildClaudeApi`, which the
  relay shares and must not adopt it.
  **System-injected user records are not the user's words** — a `<task-notification>`, a peer
  `<agent-message>`/`<cross-session-message>`, an auto-continuation/coordinator prompt — so
  `parseChatRecords` (and the find-bar index) renders each as ONE assistant tool part
  (`classifySystemRecord`: "Background task" / "Agent message" / "System", no wire change; each is
  a turn boundary in `assistantTurnEnds`) and fences a human paste's `<pasted_content>` span (the
  CLI's own 4-hex-id grammar only; titles keep the raw text) — all `indexOf` scans, never a
  backtracking regex (quadratic on unclosed tags); exact rules in `src/shared/chat-fixtures/README.md`.
  **Paged reads (2026-09).** `chat.readTranscript` takes a trailing optional `page`
  (`{before?, maxBytes?}`, `shared/chat-page.ts`). Absent = the legacy 5 MB-tail read, byte for byte
  (result is exactly `{messages, found}`). Present = ONE window of at most `maxBytes` (clamped
  64 KB…5 MB — it is untrusted IPC/WS input; an invalid `before` REJECTS rather than being coerced
  to "end of file") ending at byte `before`, and the result adds `olderCursor` (where the window's
  first complete line starts — the next page's `before`; `null` = reached the start), a per-message
  `key` (the line's ABSOLUTE byte offset — stable across prepends and appends), `id` on tool parts,
  and `unmatchedResults` (tool results whose `tool_use` sits in an OLDER window: the newer page is
  read first, so the renderer holds them until that page arrives). Parsing is the pure
  `parseChatWindow` over BYTES (a multi-byte char cut by the window edge only lands in the dropped
  partial line), and every window is read with **one byte of lookbehind** — the only way to know a
  line begins exactly on the edge; without it that line is dropped as "partial" and lost. A window
  with **no complete line** (one record bigger than the window — in practice a `type:user` line
  carrying a pasted screenshot or an image tool_result; 181 lines over 512 KB in 30 days on one
  host) is flagged `noCompleteLine` and **re-read at the same `before` with ×4 the bytes, up to the 5 MB cap**
  (`parseGrowingWindow` in `core/transcript-ipc.ts` — local AND SSH leg; a failed re-read is
  not-found, never the skip). Only a line **longer than 5 MB** is skipped (`olderCursor = window
  start`, never the window end, which would re-request the identical window forever) — before this,
  every line bigger than the page vanished, a regression against the legacy 5 MB read. The **SSH leg** is a ranged read
  (`transcriptPageCommand`, `core/remote-ssh/transcript-window.ts` — size + window in ONE round
  trip, dd status inside the base64 like the context-tail's window command) instead of pulling the
  5 MB tail on every open and every turn-end reload; its `{ok:false}` is terminal (never the local
  disk), and it is tested under a real `/bin/sh` (`transcript-page.realsh.test.ts`). **Grok does not
  page** (its file is rewritten in place, so offsets are no identity): a paged request gets its whole
  capped read with `olderCursor: null`, no keys, and the newest record's `model`/`effort`.
  Server Edition passes `page` through ws-bridge to the same core handler; relay still refuses.
  **ChatPanel consumes it progressively** (pure state in `renderer/lib/chatPaging.ts`): the first
  read is a 256 KB tail (`CHAT_TAIL_PAGE_BYTES`, with a "Loading conversation…" row), older 512 KB
  pages load when the user scrolls within 200 px of the top (or by themselves while the thread is
  shorter than the viewport — it cannot scroll), one at a time behind their own token, prepended
  with the scroll position ANCHORED on the scrollHeight delta (the loading row's own appearance
  included). A turn-end reload / ↻ re-reads only the tail and **merges by key**, keeping the older
  pages already loaded — unless no rendered message reaches into the new window (the turn wrote
  more than a whole window, so the bytes in between were never read): then it RESETS to the tail
  rather than stitch over a hole. Carried tool results are held until their tool's page arrives and
  dropped at the start of the file. `found:false` on an OLDER page is a failed page load (retry row,
  thread kept), not a missing transcript; a reload that fails to resolve never blanks a rendered
  thread — only a read with nothing on screen says "No transcript found". The remote leg's
  forget-a-located-ref rule lives in `main/remote-transcript-page.ts` (a hook-fed ref is never
  dropped on a failed read, and a hook event re-marks a located ref as hook-fed). Grok: one
  unkeyed read, no older pages, no "Beginning of conversation" marker (a capped read cannot know).
  **Loading surfaces (2026-09).** The lazy ChatPanel chunk suspends into `ChatPanelFallback` at
  ALL THREE mount sites (canvas node, kanban card modal, closed-transcript dialog — it replaced a
  `fallback={null}` that left the ⌘M face blank over the terminal): the panel's own shell plus
  `ChatLoadingStatus`, which ChatPanel's initial "Loading conversation…" row renders too, so the
  handover is identical DOM (a second row swapped rings and re-announced its `role=status`). Its
  spinner is the app's ONE spinner, `components/Spinner` / `.nt-spinner` — frozen, not hidden,
  under `prefers-reduced-motion`; never add a local one. A terminal node's label row ends in a
  quiet ⌘M hint (`lib/mdViewHint.ts`, id `md-hint`, hideable in Settings → Appearance) naming the
  EFFECTIVE chord and what it opens on that node; it sits in a zero-basis trailing slot that
  clips, so it can never add a line to the row (a height flip would refit xterm and SIGWINCH
  tmux). It is not on the kanban card modal: that header already carries the ⌘M toggle.
  **The composer sends only in `done` or an unknown state** (`canSendFromChat`,
  `renderer/lib/chatSendGate.ts`), with ONE exception: `working` for an agent in
  `INPUT_QUEUE_CAPABLE` (claude — measured: a prompt submitted mid-turn waits in Claude Code's own
  queue and reaches the model at the next tool boundary), where Enter QUEUES (`chatSendMode`) and
  the bubble reads "Queued" until the transcript has it. Only a plain prompt queues (`canQueue`):
  a slash command or `!` line mid-turn is unmeasured and waits. While the agent works the textarea
  stays editable for every agent (`composerStandsDown`) — only sending is gated. Never in
  `waiting`/`blocked`:
  PermissionRequest and AskUserQuestion both normalize to `waiting`, the pane then holds a TUI
  select dialog this view does not show, and `sendText`'s Enter would ANSWER it ("Yes" is the
  default highlight). It also refuses any node whose CLI has left the pane — hibernated, paused,
  dropped, or **exited** (`/exit`/Ctrl+D: `state: undefined` + `sessionEnded`) — because a SHELL
  owns it and the message would run as a shell command. That test is `agentProcessInPane`
  (`terminal/live-work.ts`), the same single rule the memory levers use — never a second copy of
  the flag set — and it ranks above the state (`chatSendRefusal`). Everything is re-read from the
  store at send time, not only at render. Same trap as the in-place restart's `/exit`. The bar's ↻
  reloads on demand (beside the empty state's Retry), since a session whose hooks never report
  `working` never takes the turn-finish reload.
  **A chat prompt is TYPED for claude, never pasted** (`core/typed-input.ts`, `TYPED_INPUT_CAPABLE`).
  Claude Code records a multi-line paste as `<pasted_content>`, which its model is told may not be
  the user's words; typed text (lines joined by tmux's `M-Enter`, measured on 2.1.281) is recorded
  as plain user text. Three rules: (1) **core decides it from the agent id** inside
  `sendChatPrompt` (`typedFor`), never a renderer-sent flag — every other agent and every other
  `sendText` caller keeps the paste; (2) **every write into a pane is serialized per pane**
  (`PtyManager.serializePaneWrite`, wrapping `sendText` AND `sendEnvelope`): a typed send takes
  seconds (one paste per line, then a settle wait before Enter), and an agent message, a reminder
  or dictation arriving in that window would otherwise land between its lines and be submitted as
  part of it; (3) **the screen is checked again right before the Enter** (`TypedSurface.canSubmit`):
  the dialog check `sendChatPrompt` makes is seconds old by then, and an Enter into a dialog that
  opened meanwhile would ANSWER it — the text stays in the composer and the caller hears
  `pasted-not-submitted`. The panel ignores a second Enter while a send is in flight (the draft is
  cleared only once it lands). **"The text arrived" is read from the COMPOSER, never counted
  across the screen** (`TypedSurface.draftOf` → `readClaudeDraft`, on a styled capture so the dim
  placeholder is not draft text): the draft must end with the message's tail and differ from the
  draft before typing. Typing also clears the placeholder and shortens the status line ("· ← for
  agents" goes away), so a one-letter answer like `a` appeared once more in the box and once less
  elsewhere; the screen-wide count never rose and every such send ended `pasted-not-submitted` with
  the answer sitting in the box. The screen-wide count stays only as the fallback for a poll with
  no readable input box (a draft too tall for the box reader).
  **The agent's OWN dialogs are read off the screen** (`shared/agents/claude-screen.ts`, claude
  only — `SCREEN_DIALOG_READABLE`). The folder-trust prompt, `/model` and one-time setup questions
  fire NO hook, so the state gate above reads `done` while one owns the keyboard, and a paste into
  it was swallowed while its Enter answered the dialog (the trust prompt's default is "No, exit").
  A send therefore goes through `pty.sendChatPrompt`, where core captures the pane first and
  refuses (`ChatPromptBlocked`, nothing written, the draft kept) when the bottom of the screen is a
  dialog footer or has no input box; an empty or unreadable capture is NOT evidence and sends as
  before. A LOCAL pane is also polled every 2 s while the view is visible AND the window focused
  (an unfocused window skips ticks — ~30 tmux spawns a minute per view otherwise — and `focus`
  re-reads at once; unknown focus polls), to disable the composer and show the dialog's lines; SSH and relay panes are not polled (a round trip per read) and rely
  on the send-time check. Another CLI's layout would read as a permanent dialog, so an agent joins
  the list only with its own measured reader.
  **Live progress (2026-09).** While the agent works, a `role=status` row closes the thread (the ONE
  spinner + the placeholder's own "<agent> is working…"/"waiting for an answer" sentence; optimistic
  right after a send, bounded by `CHAT_OPTIMISTIC_WORKING_MS`), and every hook event re-reads the
  tail — throttled (`CHAT_LIVE_RELOAD_MIN_MS`, trailing read guaranteed), single-flight, never for a
  hidden panel or document (`lib/chatLive.ts`). The trigger is `agentStatus.onHookEvent`, NOT a
  `stateAt` selector: same-state events refresh `stateAt` in place and notify no zustand subscriber.
  A live read passes `applyTail(…, {carryUnconfirmed})`, which keeps the trailing unkeyed optimistic
  send until the tail holds a matching user line (the send's own UserPromptSubmit read races the
  transcript write); it never resets a failed older page or flips an empty state to "Loading…".
  Gap: the panel reads the DEFAULT agent-status store, the only one Canvas's hook listener writes, so
  a relay tab gets neither the row nor live reads until relay status is routed per session.
  **Plan and question bodies (2026-09).** A tool call is normally a collapsed chip (`name` + a
  ≤200-char `arg`), which left an `ExitPlanMode` plan — the full markdown the terminal shows as
  "Here is Claude's plan" — and an `AskUserQuestion` question + options unreadable in ⌘M, the one
  place meant for reading them. `core/chat-tool-body.ts` (pure) fills the tool part's optional
  `body` for exactly those two tools (`input.plan`; the questions rendered as markdown), capped at
  64K characters (never splitting an open code fence or a surrogate pair; model-authored labels are
  kept to one line with emphasis escaped), degrading to no body (the old chip) on any other shape;
  ChatPanel shows a part with a body as an expanded "Plan"/"Question" card through `MarkdownText` with its result under it, and
  the find-bar index (`linesFrom`) indexes the body in full like assistant text.
  **Answer controls on those cards (2026-09).** Only the card the node's `held` ticket belongs to gets
  controls (`lib/chatAnswer.ts` `activeAnswerCard`: newest unanswered card of the held tool; a question
  also needs identical question texts — `held.questions` and the card's `questions` come from the ONE
  `readQuestions`), and only while the pane is in a dialog state. They send a `PermissionAnswer`
  through `answerPermission`; a refusal is a quiet retryable error pointing at the terminal. Plan's
  default button is `restore` — never auto. See docs/hook-reply-approvals.md.
  **A card answers only the request the THREAD was read for** (`answerCardState`, same rule as
  iOS #41): `threadHeldFor` = the held ticket at the START of the last applied tail read, keyed by
  transcript identity. While held moves A → B (a revised plan) plan A's card can still be on screen
  unanswered, and a tool-name match would approve B from it — so until a read started under B lands,
  the latest unanswered card of that tool says "Updating… — or answer in the terminal" and nothing
  is answerable. A held change forces a tail reload (queued behind a read in flight, which started
  under A and cannot bind B, and behind an older-page fetch, which it never cancels). It is a QUIET
  read (no "Loading…"), and one path owns it: on working → blocked the turn-end reload does. While a
  request is unbound it retries with backoff (`rebindRetryDelay`: 2 s doubling to 30 s, reset per
  request) — card on screen or not; it stops once B surfaces on a new card (a duplicate ticket for the same tool_use keeps a quiet 30 s retry while the agent stays blocked). A read under B that still shows the card A was bound to (same tool id / line offset —
  the transcript can lag the hook) stays "Updating…": B must surface on a card the thread shows as
  new. The answer payload carries the BOUND id, re-checked against store and binding at send time.
  Residuals: the previous-card memory is per MOUNT (a panel opened fresh under B has none, so it
  binds B to the latest matching card); a re-issued ticket for the SAME tool_use (duplicate hooks)
  stays "Updating…" and is answered in the terminal; and the whole guarantee assumes Claude writes
  the tool_use to the transcript before the hook fires.
  **The thread look (2026-09-26, claude.ai-style)**: the user's message is a neutral rounded bubble
  on the right (`term-chat__bubble`, a tint lift — never the blue accent), the assistant's is plain
  full-width text with no bubble. One quiet action row per assistant TURN (`lib/chatThread.ts`
  `assistantTurnEnds` — a turn is a run of consecutive assistant lines, so a tool-heavy turn gets one
  row, not one per tool call), hidden until hover/focus and always shown on the latest turn: Copy (the
  turn's TEXT parts as markdown source, through `window.nodeTerminal.clipboard` — the app channel,
  which never rejects and bridges to execCommand in the browser) and a relative time from the new
  optional `ChatMessage.at` (epoch ms from claude's ISO `timestamp`, set by the core parser on BOTH
  the legacy and paged paths; absent when the line states none — never a made-up time). One
  60-second `now` tick in ChatPanel drives every row's label. No thumbs / read-aloud / retry (no
  terminal equivalent). `.term-chat__text` stays the markdown sink the link guard scopes to.
  **Every code block has the same Copy control in its top-right corner** (`nodes/CodeBlockCopy.tsx`;
  ONE button component, `ChatCopyButton`, shared with the per-turn Copy so the two cannot drift).
  The Markdown is an HTML string, so after each new string the hook wraps every `<pre>` in a
  positioned `.term-chat__code` (never inside the `<pre>`: it scrolls sideways and would carry the
  button) and portals the button beside it. It copies the block's `<code>` text minus marked's one
  trailing newline (`lib/codeBlockCopy.ts`) — a pasted command must not run on paste. Hover-revealed,
  kept visible while it says "Copied". Chat messages, thinking and plan/question cards all render
  through `MarkdownText`, so all get it; the ⌘M output view and the editor preview do not.
  **The composer (2026-09-26, claude.ai-style)** is one rounded box — textarea on top, a toolbar
  under it: "+" attach on the left; model label, muted effort label and a mic on the right (pure
  decisions in `lib/chatComposer.ts`). Four rules: (1) **attach = paths in the DRAFT, resolved the
  way a drop onto that node's terminal is** — the mount site passes `pathsForFiles` built on
  `droppedPaths` with the node's own SSH scope (`dropProjectId` in TerminalNode; `spawn.ssh` in the
  card modal), so an SSH node's file is uploaded to its HOST and the composer never grows a second
  resolver; "+" / drop / file-or-screenshot paste all feed it, and nothing is ever sent. (2) **The
  mic targets THIS composer's textarea, never the pane**: `nodeterm:dictate` carries a per-MOUNT
  `composerId` (the canvas node and the card modal can both mount one session's composer),
  `DictationTarget` gained `kind: 'chat-composer'`, and the overlay hands the take over
  `nodeterm:chat-dictation` (`lib/chatComposerDictation.ts`), saying so if the composer closed
  mid-take. (3) **The labels read the ContextMeter's store** (`useContextUsage` — ONE reader) and
  a click TYPES the agent's own picker command (`/model`, `/effort`) through the SAME
  `chatSendRefusal` gate as a message, re-read at click time, then flips to the terminal
  (`onShowTerminal`); `sendText` must answer `=== true` to flip. Measured for claude only
  (`composerPickerCommand`, via `capabilityAgentId`): any other agent shows no label, since a label
  that opens nothing is a lie. Hidden when the model is unknown; effort hidden with it. (4) **Effort
  was measured, not assumed** (Claude Code 2.1.283): read = the top-level `effort` the CLI writes on
  every assistant record it sent with one (`...E!==void 0&&{effort:E}`; its own history reader
  walks the same field; a transcript flips `medium`→`xhigh` on the first request after `/effort`);
  change = `/effort` (a `local-jsx` picker, levels `low|medium|high|xhigh|max`). `parseLatestUsage`
  takes it from the LATEST usage record only — never carried forward, a record without it means
  that model takes no effort — and both context tails push on an effort-only change
  (`ContextWindowUsage.effort`, optional: older hosts and other agents simply omit it). Like the
  model, it lags until the next request. Narrow composers drop effort first, then the model
  (`composerToolbarLayout`); "+" and the mic stay. No voice-conversation button: there is no
  terminal equivalent. Surfaces: Desktop + Server Edition identical (dictation and uploads already
  bridge — `files.saveUpload`, `speech.*`); SSH nodes upload to the host; kanban card modal shares
  ChatPanel and wires both props; relay tabs keep the panel's existing refusal; mobile N/A.
  Fix-round rules (same day): the composer is its OWN component (`nodes/ChatComposer.tsx`) so the
  thread and the composer restyle independently. A label click is an explicit "go to the
  terminal", so the flip FOCUSES the xterm whatever its entry state was
  (`requestTerminalFocusOnExit(nodeId)` before the state change, consumed once by the node's
  `useMdModeFocus` — TerminalNode and ModalTerminal both key it by node id). `/model` and `/effort`
  open LOCAL pickers that fire NO hook, so the gate still reads `done` while one is on screen: the
  composer holds a picker command in flight (ref + disabled/`aria-disabled` labels, and Enter is
  swallowed) from click until the flip or failure — a second click would otherwise paste
  `/model` + Enter INTO the picker, confirming its highlighted row. **Inherent limitation:**
  returning to ⌘M while a picker is still open reads `done` too, so a chat send or a label click
  there would type into it — the pane is not observable from here. Shortcut dictation (keyed chord
  and hold-to-talk) targets the composer holding the caret before the selected terminal (the pane
  under the view is hidden) via `composerFromElement`; the dispatcher offers keyed dictation in
  that one text field (`isChatComposerTarget`). Both are keyed on the composer BOX
  (`[data-chat-composer-id]`), never on the textarea's `term-chat__input` class — the plan
  "Revise…" textarea and the question "Other" input share that class and sit outside the box. With
  focus anywhere else inside `.term-chat` (those fields, the answer buttons) BOTH shortcut paths
  refuse (`shortcutDictationFocus` → `refuse`): their fallback, the selected terminal, is the hidden
  pane showing the very plan/question dialog, and typed characters landing there would move its
  highlight or fill its "Other" field (the overlay types with `enter: false`, so nothing submits).
  **Every mic that names only a NODE** — the terminal header mic, the card modal's header mic, the
  Dock mic and the shortcut fallback (selected terminal / open card) — goes through
  `dictationTargetForNode`: while that node's chat view is up (`.term-chat[data-chat-node-id]`) the
  take goes to its mounted composer (the card modal's own when the modal is open for that node, so
  a modal showing the LIVE terminal still targets it), a chat view with no composer refuses, and
  otherwise it is the terminal as before. Every refusal says so in one `nodeterm:toast`
  (`announceChatDictationRefusal`, naming the composer mic) instead of a silent dead key.
- **The composer completes `/` and `@` (2026-09-30).** Typing `/` at the START of the message (after
  optional whitespace — every CLI measured reads `/x` mid-sentence as text) opens a menu of the
  node's CATALOG; `@` at the start of a word opens the node's files. Arrows move, Enter/Tab ACCEPT,
  Esc closes the menu only (CardModal's capture-phase Esc already stands aside inside
  `.term-chat__compose`). **Accepting only inserts text** (`/name ` / `@path `): nothing is typed into
  the pane, and the send is still the composer's own gated Enter (`chatSendRefusal`) — completing
  `/clear` then pressing Enter is exactly typing it. **Enter accepts only when accepting CHANGES the
  draft**: a fully typed `/model` with the menu still open is a message and Enter sends it (the
  first version swallowed it, and `ChatPanel.live.test.tsx` caught the regression). Pure decisions in
  `renderer/lib/chatComposerComplete.ts`; the wire shape, sanitizer, measured tables and ranking in
  `@shared/chat-catalog`; the builder in `core/chat-catalog.ts` behind `chat:catalog`
  (`registerChatCatalogIpc`, registered by BOTH shells). Rules a refactor must not undo:
  - **Built-ins are only what was MEASURED** (2026-09-30), by typing `/` in each TUI inside a private
    tmux server and paging the whole menu: claude 2.1.285, codex 0.156.1, opencode 1.18.25, gemini
    0.62.0 (throwaway HOME + a dummy API key — the menu is client-side). **grok has no table**: 1.0.44
    would not start past its browser sign-in on the measuring host, and a list copied from docs is a
    guess about the binary the user runs. Plan-, login- and experiment-gated entries are left out.
    Any other agent (grok, copilot, antigravity, a custom agent with no base) gets `@` only; a custom
    agent inherits its base's table through `capabilityAgentId`. The descriptions are our own words.
  - **A built-in that opens a DIALOG in the TUI is `interactive`, and sending one flips to the
    terminal.** `/model`, `/rewind`, `/resume`, `/config`, `/permissions`, … open a picker the ⌘M view
    cannot see while the state still reads `done` — the next message's Enter would ANSWER it (confirm
    the highlighted row), the hazard the toolbar labels already guard. So every built-in is tagged
    `interactive` EXCEPT a per-agent `SAFE` set of measured no-dialog commands (claude
    `clear compact init recap reload-skills security-review`, codex `clear compact init new recap`,
    gemini `clear compress init`, opencode `new`) — unknown means dialog, because over-tagging costs a
    flip and under-tagging costs a wrong answer. `ChatPanel.send` calls `onShowTerminal` after a send
    confirmed `=== true` whose text `isInteractiveBuiltin` (menu-completed OR typed by hand, with or
    without arguments); a composer with no `onShowTerminal` does not offer those entries at all. The
    phone gets the tag in its catalog and owes the same rule.
  - **Custom commands and skills: claude and gemini only**, at the measured locations. claude:
    `<configDir>/commands/**/*.md` + `<cwd>/.claude/commands/**/*.md` (measured: a subfolder is a
    `dir:name` namespace; description = frontmatter `description`, else the first body line; a
    `SKILL.md` inside a commands folder names its FOLDER, `review/SKILL.md` → `review`, per the 2.1.285
    loader) and
    `<configDir>/skills/*/SKILL.md` + `<cwd>/.claude/skills/*/SKILL.md` (measured: the frontmatter
    `name` WINS over the folder name, the folder is the fallback, `user-invocable: false` is not
    offered). `<configDir>` is the bound account's dir (`claudeConfigDirFor`, linked accounts
    included), which REPLACES `~/.claude` — never both, and a malformed account id yields NO user
    root, never the system dir in its place (another identity's commands). gemini:
    `~/.gemini/commands/**/*.toml` + `<cwd>/.gemini/commands/**/*.toml` (its shipped
    custom-commands reference). Precedence project > user > built-in, deduped by name. Other agents'
    custom locations were not measured, so they list none — a guessed location offers commands the
    CLI does not have.
  - **A PROJECT root follows no symlink, at any level** (`CatalogRoot.within`). A cloned repository's
    `.claude/commands/notes.md -> ~/.git-credentials` otherwise put the token-bearing first line in
    the menu and in the phone's catalog (reproduced in review, both legs). Locally entries are
    lstat'ed and files opened `O_NOFOLLOW`; remotely `find -P` and `[ -L ]` on the skill folder and
    its SKILL.md; and the root itself must resolve inside the cwd (realpath / `pwd -P`), so a
    `.claude` linked out of the project lists nothing. USER roots (the person's own config dir) are
    followed — that is how shared system skills reach an account dir.
  - **Names and descriptions are hostile data** (a project's `.claude/commands` is whatever the
    repository holds): a name passes `catalogName` (closed alphabet `[A-Za-z0-9][A-Za-z0-9._:-]*`,
    ≤ 64, never trimmed) or the entry is dropped; a description is one line with C0/C1 and `\p{Cf}`
    (bidi, zero-width) removed, capped at 160 code points. The renderer re-runs
    `sanitizeChatCatalog` on every reply and renders both as text nodes. `@` never offers a path with
    whitespace, a control or format character, or one failing `isSafeQuickOpenRelPath`.
  - **The menu is DERIVED from the draft plus a caret snapshot taken for that exact draft**
    (`caretSnap.value === value`), never kept as its own state. A draft changed outside the textarea
    — ChatPanel clearing it after the async send, dictation, an attach — invalidates the snapshot and
    closes the menu (reproduced in review: send `/compact`, the Enter's keyup re-armed the menu from the
    old text, and Tab then turned the emptied draft back into `/compact `). A disabled composer derives
    nothing. A bare `@` is not a choice: Enter sends `hello @`, Tab still accepts.
  - **Cost: nothing is polled.** A composer asks on its first `/` (or `@`) and reuses the answer for
    `CATALOG_REUSE_MS` (30 s). Core caches every directory listing by the directory's mtime and
    every file head (first 4 KB) by (mtime, size), so an unchanged tree costs stats, no reads. Per
    root at most 200 files, commands 3 levels deep.
  - **`@` is the existing quick-open index**, not a new walker: `files.quickOpen(cwd)` on the
    session's api (this machine, or a relay peer's core) or `sshFs.quickOpen(scope, cwd)` for an SSH
    node — gitignore-aware, capped, traversal-guarded — rooted at the node's cwd, ranked by the
    quick-open fuzzy ranker. The SSH scope is the one the composer's attach already uploads through
    (`nodeUploadScope`), passed as ChatPanel's `sshProjectId` from both mount sites.
  - **An SSH node's catalog is read on its HOST, in ONE round trip** (`remoteCatalogCommand`, run over
    the node's master by the desktop's `runRemote`; tested under a real `/bin/sh` against a fake host
    tree). A remote node whose host cannot be asked — or a shell with no remote leg — answers
    built-ins + `partial`, never this machine's folders. Every file's bytes pass `tr -d '\036'`, so a
    hostile file cannot forge a record boundary. Remoteness is the shell's own record
    (`isRemoteTranscriptNode`), never an argument.
  - **Surfaces.** Desktop full (local + SSH). Server Edition full, local only (real ws-bridge
    `chat.catalog`; it runs on the host it reads). Relay tabs: `chat.catalog` REJECTS (stub) and the
    composer offers the shared built-in table alone; `@` uses the peer's own quick-open index, which
    is the right machine. Kanban card modal: the same ChatPanel/composer. **Mobile**: `chat.status`
    carries the same catalog as an OPTIONAL field when the phone sends `catalog: true`
    (docs/mobile-chat-view.md); an older phone never asks. It is bounded
    (`HOST_CHAT_CATALOG_TIMEOUT_MS`, 4 s, then the status goes out WITHOUT it — `chat.status` is the
    relay's status poll and must never wait on an ssh round trip to a half-dead master), and a client
    asks once per composer open, not on every poll. The Server Edition names an SSH-project node
    remote (`workspaceStore.sshProjectIdForNode`), so it answers built-ins + `partial` there instead of
    reading the server's own `~/.claude`. Adopting it in nodeterm mobile is an iOS
    follow-up.
