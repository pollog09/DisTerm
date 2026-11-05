# Cold restore, SSH connect and Zellij

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

### Cold restore (machine reboot)

tmux only survives an **app** restart — a **machine reboot kills the tmux server**, so every
`nt-<nodeId>` session is gone. To bridge that, `create()` returns `PtyCreateResult` with a
`fresh` flag: it asks the tmux server whether the session already exists *before* spawning, so
`fresh=false` means a warm reattach (tmux redraws) and `fresh=true` means a cold start (first open
OR post-reboot). Locally that ask is one `tmux has-session` per node; **on an SSH project it is ONE
`tmux list-sessions` per host per burst** (`core/remote-ssh/remote-session-index.ts`), because a
project switch mounts every node in the same tick and N probe channels on top of N pty channels
overrun a stock host's `MaxSessions 10`. The measurement and the failure chain it closes are in
that module's header; the two rules a refactor must not undo are **(1)** only tmux's own exit 1 is
evidence of absence — every other outcome answers "exists", because a transport failure read as
"cold" replays a snapshot and types `claude --resume …` into a LIVE agent pane — and **(2)** a
session this process just spawned is recorded (`markPresent`) and a remote kill invalidates the
cached list, so nothing inside the cache window can be told it is cold when it is not. On a
cold start the renderer (`TerminalNode.tsx`) reconstructs state instead of relying on the dead
session (you can't keep a live OS process across a reboot):
- **Scrollback replay** — `core/scrollback-store.ts` keeps a byte-capped (`256 KB`) snapshot of
  each tmux session's recent output under `<userData>/terminal-scrollback/`, refreshed on a
  timer (`SCROLLBACK_SNAPSHOT_MS`) + on detach/quit (`tmux capture-pane -e`). On a cold start the
  renderer reads it via `pty.readScrollback` and writes it back into xterm (with a "session
  restored" separator). Warm reattach skips it (tmux already redraws). Deleted with the node in
  `destroySession`.
  **The periodic capture is paced, serialized and deduplicated** (`snapshotTick`,
  `core/scrollback-cadence.ts`). A working agent's spinner keeps its session dirty forever, so the
  old tick spawned a `capture-pane -S -1500` (an ssh exec for a remote node) and rewrote up to
  256 KB for EVERY busy session, all in the same instant, every 15 s. Now: a dirty session is
  captured on its first `BUSY_AFTER_TICKS` (4) consecutive dirty ticks, then every
  `BUSY_EVERY_TICKS`-th (60 s); an off-cadence tick KEEPS the dirty bit, which is what lets
  detach/quit still take their final capture; an idle tick resets the count. Captures run one at a
  time on `snapshotChain`, a session whose capture is still queued is never queued twice
  (`snapshotQueued`), and a failed capture OR a failed disk write re-marks it dirty
  (`writeScrollbackIfChanged` reports the write; a skipped unchanged capture counts as done). Every write (periodic, detach, quit)
  goes through `writeScrollbackIfChanged`, which skips a capture whose sha1 matches the last one
  written; the digest is dropped with the file in `endSession`, so a recreated node always writes.
  The cost is bounded and deliberate: a continuously busy session's post-reboot replay can be up to
  ~60 s stale, since the snapshot only serves a machine reboot.
- **Agent resume** — on a cold start of a node whose `agentId` is in `RESUMABLE_AGENTS`, the
  renderer re-launches the agent CLI: `resumeCommand(agentId, sessionId)` (from the session id
  persisted in `agentStatus` localStorage — `claude --resume`, `codex resume`, `gemini
  --resume`) when known, else the bare `launchCmd`. The one-shot `data.initialCommand` still wins
  on the very first open, so the agent is never double-launched. **The one exception: a `paused`
  node** (see "Pause session" below) skips this auto-relaunch — that is the entire point of the
  flag — and instead records the pane its fresh shell settled on (`agentStatus.hibernatedPane`),
  so a later explicit Resume can recognize it even for a default shell outside the wake's
  `isShellCommand` allowlist.
  **A persisted session id is not evidence the conversation still exists**, and a dead one is not a
  no-op: `claude --resume <dead id>` prints *"No conversation found with session ID: <uuid>"* and
  EXITS, leaving the pane at a bare shell under a node still wearing its agent badge. Measured
  2026-09-09 on the reporting host (`nodeterm-rmt`, 108 live sessions): **20** panes sat in exactly
  that state, and not one of those 20 ids had a `<id>.jsonl` anywhere under the system
  `~/.claude/projects` or the managed account root. Claude's own 30-day cleanup, a `/clear`, a
  removed account and an id minted for a session that never ran all produce it. So the cold-restore
  branch now asks `chat.transcriptExists` first (`transcript:exists`, served by
  `registerTranscriptIpc` in BOTH shells) and, on a POSITIVE `absent`, launches the agent **bare**
  and raises a slim `CoState.lostSession` banner on the node — "The previous conversation could not
  be found — this agent started fresh." — instead of opening a blank session in silence. Three
  rules make that safe:
  - **The answer is a TRI-state** (`TranscriptPresence`: `present | absent | unknown`) and only
    `absent` drops the id. The two errors are wildly asymmetric — wrongly resuming a dead id costs
    one line and a bare shell (today's bug), wrongly dropping a LIVE id strands work the user
    believes is continuing — so an unreadable root, a `readdir` that threw, a downed ControlMaster,
    a relay tab, a rejected call and an id we would not put on a command line are ALL `unknown` =
    resume exactly as before. `transcriptPresence` (`core/transcript-reader.ts`) is
    `resolveTranscriptPath` plus that one distinction, not a second way of finding a transcript,
    and a root that does not exist at all still answers `unknown` on purpose: cold restore runs at
    boot, where a not-yet-mounted `$HOME` is indistinguishable from an empty one.
  - **The remote leg's `unknown` is TERMINAL, never a fallthrough.** A remote session's transcript
    is on the host, so searching this machine for it would find nothing and report `absent` about
    the wrong computer. `remoteTranscriptPresence` (`src/main`) exists beside
    `remoteTranscriptRefFor` rather than reusing it because that function collapses "not remote" /
    "no home" / "ssh failed" / "the host looked and there is nothing" into one `undefined` — fine
    for a reader that falls back, fatal for a caller that acts on absence.
    `locateRemoteTranscriptCommand` was already built for this distinction (it exits 0 on a clean
    miss, "so no transcript is an ANSWER, not a failed ssh"), and that is the property this reads;
    it is deliberately more permissive than the local leg (it searches the account root AND the
    system root), which errs toward `present` = keep the resume.
  - **Claude only**, gated by `readsClaudeTranscript` — a codex/gemini/grok id misses this
    resolver by construction every time, so probing one would answer `absent` for a healthy
    session and drop its resume. Those agents keep the pre-existing behaviour until the probe
    learns their layouts (`handoff/locate.ts` has the per-agent locators; that is the seam).
  Decision logic is the pure `terminal/cold-resume-session.ts`. **Adding a `CoState` field owes the
  hand-written equality list in `setCo`** — a patch touching only an uncompared field is SWALLOWED
  and its banner silently never renders (it happened once to `spawnError`);
  `nodes/cold-resume-wiring.test.ts` now asserts every field of the interface appears there.
  Surfaces: Desktop full; Server Edition full (the handler is core, the ws-bridge leg is real, and
  that shell runs on the host whose transcripts it reads, so it needs no remote leg); relay tabs
  answer `unknown` and resume as before. **Not yet on the kanban CARD MODAL** — `ModalTerminal`
  reads no `CoState`, so a user who only ever opens the session from the board does not see the
  notice; the honest fix is a shared node-notice surface rather than a second copy of the banner.

### SSH connect: the ControlMaster is published BEFORE its setup chain

`connectOnce` (`main/remote-ssh/ssh-project.ts`) used to publish a project's ControlMaster only with
`status: 'connected'` — i.e. after the reverse hook tunnel, ~23 serialized per-agent hook installs,
`printf $HOME`, the remote tmux.conf write + `source-file` and the Codex runtime staging had all
run. MEASURED against a real sshd through a 25 ms one-way delay proxy (50 ms RTT): that chain is
**3.54 s** on a fully-provisioned host, while **18 remote terminals attaching in parallel over a
warm master paint in a median of 0.16 s** and are all settled by 0.71 s. So the attach was never the
bottleneck — every terminal of a switched-to project simply sat in `resolveSshRemote`'s 20 s wait
printing `[connecting to user@host…]` into a blank pane, for a transport that was ready the whole
time.

Two additive changes, and the rules that keep them safe:

- **The early signal.** The moment `ssh -O check` answers, `connectOnce` emits
  `SshProjectStatusEvent.masterControlPath` on a `connecting` event. `connected` keeps its exact
  meaning (the whole chain finished) and everything hanging off it — git routing, the remote claude
  probe, the tunnel resync, the connection banner — is untouched. The renderer keeps it in its own
  map (`useSshConn.earlyByProject`), **never in `byProject`**, which a dozen readers treat as "this
  project is connected".
  - **Only a node whose remote tmux session ALREADY EXISTS may act on it**
    (`PtyApi.remoteSessionConfirmed` → `RemoteSessionIndex.verdict`, the strict `present`-only half
    of the coalesced `tmux list-sessions` read `create()` already makes, so a warm switch pays no
    extra round trip). `new-session -A` on a live session merely attaches, and the two things the
    setup chain provides — the remote tmux config (`-f`) and the hook/account environment (tmux
    `-e`) — are read at session CREATION only. A node whose session is ABSENT, **or whose host
    could not be read**, waits for `connected`: creating its session without the hook env costs it
    its agent-status badges silently, with no later event to repair it. That is why the index now
    exposes a TRI-STATE (`present | absent | unknown`) — `exists()` folds `unknown` into "exists"
    for its own caller, and this one needs the opposite fold. Decision logic is the pure
    `renderer/lib/sshRemoteWait.ts`; a cold node's wait is pinned by its own test.
  - **Never for an ADOPTED live-orphan master.** The tunnel-verification failure path may `-O exit`
    that master and rebuild it, which would kill a terminal that had attached over it meanwhile.
    The rebuild clears `reusedOrphan` and re-enters the loop, so a rebuilt master does publish.
- **The boot-time pre-warm** (`core/remote-ssh/ssh-prewarm.ts`, planner + runner pure and tested;
  wired in `main/index.ts`). The master for a project was dialed only when the user first switched
  to it, so the first visit of every app run paid the cold establish (**0.44 s** measured) plus the
  whole chain. `SshProjectManager.prewarm` now dials the masters of OPEN SSH projects shortly after
  boot, **one host at a time** (a burst of fresh masters is what trips a host's `MaxStartups`; the
  `SshChildGate` caps exec children per control path and does nothing about logins).
  - **A pre-warm is SILENT — no status event at all.** The user is by definition not looking (if
    they were, the active-project effect would have connected it loudly), so a failure must not
    raise the connection banner for a project they never opened. The mark is lifted the moment a
    real connect arrives for the same project, including one that coalesces onto the pre-warm's own
    in-flight attempt.
  - **It never prompts for a passphrase either** (`isQuietMasterPid` → main's prompt handler
    declines): a modal in front of a user who opened nothing is the loudest thing an SSH connect can
    do. That master fails auth quietly; the user's own connect spawns a new one and prompts normally.
  - **CLOSED projects are never dialed**, and neither is a project that already has a master or an
    attempt in flight. `closeProject` is non-destructive, so a closed tab is the user saying "not
    now".

### When a freshness verdict was a GUESS: the late cold-start check

The cold-restore section above states the rule that makes the remote freshness read safe: only
tmux's own exit 1 is evidence of absence, and every other outcome answers "exists", because a
transport failure read as "cold" types `claude --resume …` into a LIVE agent pane. That rule is
right and does not change. What it costs, and what this closes, is the other side of the fold.

**THE INCIDENT (measured on the reporting host, 2026-09-15).** The host's `nodeterm-rmt` tmux
server died, so every remote session was gone; ten minutes later a 108-node SSH project was opened
and 107 sessions had to be created in one mount burst. sshd logged **757 `Accepted publickey` full
logins in seven minutes** — on a healthy ControlMaster that number is ~0, because everything
multiplexes over one connection. Under that pressure the freshness read times out, the fold answers
"exists", `tmux new-session -A` CREATES an empty session, `fresh:false` skips cold restore, and the
node sits at a bare shell with the user's conversation stranded on disk:

    15:29 burst,  22 sessions: 18 claude /  4 bash  ->  82% resumed
    15:39 burst, 107 sessions: 41 claude / 66 bash  ->  38% resumed

Load-dependent, i.e. a race. Three changes, and the order matters — the first saves the
conversation, the other two stop the burst that strands it:

- **A second opinion, never a different fold.** `create()` now reports `freshUnverified` when
  `fresh:false` came from an `unknown` verdict rather than a read. The renderer re-asks ONCE, after
  the attach has landed and the burst is over, and tmux settles it authoritatively:
  `#{session_created}` survives a `new-session -A` attach, so a session created within seconds of
  our own attach is one WE made (`PtyApi.sessionAge` → `remoteSessionAgeArgs`, which prints the
  stamp AND the host's `date +%s` on one line so the host's clock skew never enters the number).
  Every rule in `renderer/terminal/cold-self-heal.ts` is a refusal: never for a verdict that was
  READ (that would spend a round trip per warm node on every switch), never for an unknown age,
  never past the window, and never unless a SHELL still owns the pane — the same gate the
  hibernation wake and the resume-miss watcher keep. The scrollback replay is deliberately NOT
  re-run: by then tmux has painted the live pane, and writing a snapshot over it splices two points
  in time (the warm-attach seeding rule). The agent relaunch is what matters and is what runs.
- **The per-node token write is coalesced, not gated** — the brief that prompted this said
  `ensureRemoteNodeToken` bypassed the `SshChildGate`, and that was measurably wrong: main wires
  `RemoteHooks` with the gated runner, so it queues like everything else. The real cost was that it
  is one round trip PER SPAWN for work the connect path already did (`materialiseNodeTokens` writes
  every node's token), competing for a budget of 6 for the whole burst. It now memoizes per
  (control path, node) for the app run — seeded by the connect — and coalesces a burst into ONE
  remote write.
- **Remote pty spawns are paced** (`core/remote-ssh/pty-spawn-gate.ts`, cap 4 per ControlMaster).
  A pty deliberately never went through the `SshChildGate` — "a terminal is never queued for a
  screen the user is looking at" — which is right for a handful of terminals and wrong for a
  canvas. The one thing that makes pacing acceptable is that a slot is held only until the session
  starts painting: released on the pty's FIRST OUTPUT (one round trip for a warm attach) and
  unconditionally after `REMOTE_PTY_SPAWN_SETTLE_MS`, because a gate that can hang is worse than no
  gate. A node that ends up waiting SAYS so (`SLOW_REMOTE_SPAWN_NOTICE_MS`), for the same reason the
  `[connecting…]` line exists. Measured in the lab (real sshd, `MaxSessions 10`, 50 ms RTT, one warm
  master, 107 attaches):

  | | full logins | panes painted | wall |
  |---|---|---|---|
  | ungated | 72 / 77 | 102 and 96 of 107 | 2.1 / 2.3 s |
  | gated at 4 | **1** / **1** | **107 / 107** | 3.2 / 4.0 s |

  Wall time is the price and it is the right trade: ungated, five to eleven panes never painted at
  all inside a 20 s budget — the same shape `remote-session-index.ts` reports for its own burst.

### Zellij as an optional local backend (`settings.sessionBackend`)

Local POSIX terminals can live in **Zellij** instead of tmux (`src/core/zellij-backend.ts`; the
measurement table, the herdr comparison and the device checklist are in
**`docs/session-backends.md`** — Zellij 0.45.1 and herdr 0.9.3 release binaries, Linux, sandboxed
HOME/XDG/socket dir). Default stays tmux; `normalizeSessionBackend` reads anything unknown as tmux;
SSH projects keep the remote tmux and Windows keeps the session host. herdr was measured and not
implemented: its unit is a server of workspaces, a plain pane cannot be attached on its own
(`agent attach` refuses a non-agent pane), per-pane env is argv, and `pane send-text` ignores the
app's paste mode (measured: unframed after `?2004h`).

Rules a refactor must not undo:
- **The backend follows the session that exists** (`decideZellij`). A warm tmux session wins and
  never reaches the Zellij probe; a LIVE Zellij session is reattached in Zellij whatever the setting
  now says; only a node with no session anywhere is created in the selected backend. Otherwise
  flipping the setting cold-restores (`--resume`) an agent into the other multiplexer while the
  original keeps running in the first.
- **Env rides the client, never argv.** Each Zellij session is its own server forked by the client
  that created it, so the painter's `env` (hook env, account scope, gateway/project/custom-agent
  values, all merged in `spawnSession`) IS the session env — measured. There is no `-e` list to
  maintain and nothing to leak; do not add one.
- **Only an answer is absence, and `unknown` is WARM whatever the setting.** `list-sessions -n`
  exits 1 both for "No active zellij sessions found" (absence) and for real failures; only the
  sentence counts. When Zellij cannot be asked, the create is never cold — even with tmux selected
  — or a node still live in Zellij gets its snapshot replayed and its agent resumed a SECOND time
  in a new tmux shell (the review blocker on #1067: the first version folded to warm only when
  Zellij was selected). `sessionExists` is the opposite fold: it claims a Zellij session only from
  a listing that PARSED and shows it live, or every node on the machine "exists" (the phone's End
  session always said "still running"). Session names may contain SPACES (`my work [Created …]`),
  and a space-intolerant parser turned ONE personal session into `unknown` for every probe.
- **`--` before every positional text** (`paste`, `write-chars`): otherwise clap reads a leading
  `-` as a flag — measured in review, a markdown bullet list was refused and `-h` printed help with
  exit 0, delivering nothing while the caller then pressed Enter.
- **Zellij is probed only when it is in play** (`zellijProbeRun`: selected, or `zellij.kdl`
  exists — written only when a Zellij painter is created), so a tmux user with Zellij merely
  installed runs exactly the old path: no `list-sessions` per cold create, no `kill-session` per
  delete.
- **Socket path length**: Zellij refuses a socket path over `sun_path` (107 bytes on Linux, 103 on
  macOS). `zellijSocketPath` mirrors its dir rule; a create that would not fit falls back to tmux
  and Settings says why. A stock Mac with no `XDG_RUNTIME_DIR` computes to ~104 bytes for a real
  node id — calculated, not run; it is the first device-checklist item.
- **A zombie needs confirming before it is killed.** A shell that exits with no client attached
  leaves the session listed with only the hidden plugin pane, and `attach --create` to it exits at
  once, so `decideZellij` kills it first. But a session a moment old ALSO has no terminal pane yet
  (measured, and it made the first version of this code kill its own fresh sessions): five pane-less
  reads 300 ms apart, and one pane at any read is `live`.
- **Every action names a pane** (`pickZellijPane`): without `--pane-id` an action silently did
  nothing headless. `action paste` is the `paste-buffer -p` contract (framed only when the app asked
  — measured both ways); Enter is a second `write 13`; a paste over 120,000 bytes is refused, never
  split (one argv element; 140,000 failed with exit 126).
- **Keybindings are session-wide**, so our `zellij.kdl` decides what everyone attached to a canvas
  session can press: locked mode (Ctrl-g/p/t/o reach the app — Claude Code uses Ctrl-g), unlock on
  Ctrl-Alt-g so an outside client can still detach, `session_serialization false` so a killed
  session is not resurrected by the next `attach --create`.
- **`tmuxBacked` is also true for a Zellij session** (it means "releasing the client destroys
  nothing"); every path that would talk to the tmux socket asks `isZellij` first. A delete kills
  `nt-<id>` in Zellij whenever Zellij is in play (exact-name match, a no-op for a tmux node), because a
  node deleted after a restart has no live session and no record (only when Zellij is in play).
- **Explicit degrades, named in Settings** (`ZELLIJ_BACKEND_GAPS`, pinned to the doc by
  `zellij-backend.test.ts`): messaging/triggers refused (`paneOwner` null), model switch refused
  (`terminateForeground` false), the session-memory panel COUNTS Zellij sessions it did not measure
  (`SessionMemoryReport.unmeasured` — never "No sessions are running here." over live ones) and the
  reaper ignores them, pasted text rides argv (readable while the call runs), no pane cwd /
  stale-cwd banner, mobile direct-SSH sees only tmux. The pane foreground command IS provided, from one `ps` read
  (server → shell → the shell's `tpgid`); ambiguous (two pane shells) answers null.
Surfaces: Desktop measured and tested on Linux only (macOS unverified — socket path first); Server Edition the same core (row shown when its host reports Zellij);
Mobile via relay joins the Zellij session (`listNodetermSessions` includes and remembers them),
the phone's direct SSH path does not — iOS follow-up. Real-binary suites: `*.realzellij.test.ts`
(`NODETERM_TEST_ZELLIJ` or `zellij` on PATH; skipped in CI, which has none).
