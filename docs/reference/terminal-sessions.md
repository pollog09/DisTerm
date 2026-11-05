# Terminal session continuity

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Terminal session continuity (tmux)

`src/core/pty-manager.ts` runs each terminal inside a persistent tmux session
(`tmux new-session -A -D -s nt-<nodeId>`) on a dedicated socket (`-L node-terminal`) with
a generated config (`-f <userData>/tmux.conf`, so the user's `~/.tmux.conf` never
interferes; status bar off, **mouse on**, 50k history, `set-clipboard on` + `terminal-features
",*:clipboard"`, and the copy-mode mouse bindings). Because the tmux *server* outlives the app,
sessions survive when no client is attached. `src/shared/ssh.ts`'s `remoteTmuxConf` is the same
config for an SSH project's remote tmux.

**Exact tmux targets: every node id that becomes a `-t` goes through `exactPaneTarget` (`=name:`) or
`exactSessionTarget` (`=name`)** (`core/tmux-naming.ts`, security audit F1/F2, 2026-10). tmux resolves
a BARE target by exact name, then fnmatch, then PREFIX on a miss, and node ids end in a counter or a
random tail: with only `nt-term-abc-12` alive, `send-keys -t nt-term-abc-1` typed into it,
`capture-pane` read it and `display-message '#{pane_pid}'` named its process (measured, tmux 3.4).
That made every node-keyed verb (send-text, typed chat input, send-keys, capture, pane command/cwd,
pane owner, terminate-foreground, has-session, the control-mode shadow, an attach-only reattach) a way
to reach a DIFFERENT node, whether its own session was gone or the id was a relay peer's invention.
For an existing session `=name:` is the same pane the bare name was (current window, active pane,
re-measured with three windows and a split). An exact miss is `can't find session` (exit 1), except
`display-message`, which exits 0 with every format EMPTY — every parser here answers null for that.
On a REMOTE command line the target is single-quoted: zsh's EQUALS option expands a word starting
with `=`. Proven against a real tmux driving a real `PtyManager` (`pty-exact-target.realtmux.test.ts`).
A new tmux call site owes the same, and both helpers refuse a name `sessionName` did not produce.

**Every synchronous tmux call on main is bounded (`TMUX_BOOT_CMD_TIMEOUT_MS`, 2 s, via
`PtyManager.runTmuxSync`).** `ensureTmux`'s `source-file` runs before the first window exists, and
`ensureUpdateEnvKeys`' `show-options` / `set-option` run on a spawn; unbounded, a server that accepts
the connection and never answers held main for the wedge's whole lifetime (4.05 s in a repro, i.e.
forever against a server that never recovers). The bound kills only our short-lived
client (SIGKILL, so one that ignores SIGTERM cannot keep `execFileSync` waiting), never the server.
A timeout is `console.warn`ed and fails open (tmux stays resolved; the spawn goes ahead); "no server
yet" stays silent, as it always was. A timeout also ends the rest of that call's tmux work — the
next `set-option` would only wait out the same wedge — and a `show-options` / `set-option` timeout
starts `TMUX_UPDATE_ENV_COOLDOWN_MS` (60 s) in which `ensureUpdateEnvKeys` makes no tmux call at
all: every spawn passes the account-scope names, so without it each later spawn on a slow server
would stall main again (20 terminals ≈ 40 s). After it, the next spawn probes again. Proven against a real client in
`pty-tmux-wedged.realtmux.test.ts`. A new sync tmux call goes through `runTmuxSync`, not a bare
`execFileSync`.

**Every REMOTE tmux invocation starts with `remoteTmuxPathPrologue()`** (`shared/ssh.ts` — PATH
**append**: `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `$HOME/.local/bin`): an ssh
exec channel gets a non-login shell, and on a macOS host Homebrew's `shellenv` lives in
`~/.zprofile`, so a host whose own terminal runs tmux fine answered
`zsh:1: command not found: tmux` to every command of ours (issue #449 — the same class as the
remote claude probe's login-shell + PATH fix). Append, never prepend: a PATH that already resolves
tmux keeps exactly that binary, so nothing re-pairs a long-lived tmux server with a different
client build. When tmux is genuinely absent the interactive spawn (`tmuxOrExplain`,
`control-master.ts`) prints what is missing, how to install it and what a tmux-less remote loses,
then degrades to a plain login shell — mirroring the local plain-shell fallback; the raw
`command not found` line must never be the user-facing error again.

**tmux owns the mouse — scrolling, selection, and the alternate screen are all its job.** This is
the native behavior, and it is deliberate:
- **The wheel scrolls tmux's own history** (`history-limit`), not the emulator's buffer.
- **The pane is on the alternate screen** (`\e[?1049h`) — capabilities are NOT blanked — which is
  what keeps a full-screen TUI's input box *put* instead of scrolling away with the text.
- **Selection is tmux copy-mode.** A drag copies; apps that request mouse tracking themselves
  (vim, htop) still get their own mouse events — tmux forwards those regardless.

**Do not take scrolling away from tmux again.** A previous design did exactly that (`mouse off` +
`terminal-overrides ',*:smcup@:rmcup@:indn@'` to keep tmux on the *normal* screen, so its output
flowed into xterm's scrollback, which was then hydrated from `tmux capture-pane` on reattach). It
failed structurally: **tmux is a screen PAINTER, not a stream.** Every redraw (attach, resize,
refresh) erases and repaints, so blank and duplicated rows leaked into the emulator's scrollback —
users saw black bands and duplicated screens when scrolling up — and the pane stopped behaving
natively. The hydration that design needed is gone (see the reattach seeding below).

**Copy → the system clipboard, via OSC 52.** `set-clipboard on` **plus** `set -as terminal-features
",*:clipboard"`: on copy, tmux emits OSC 52 to the attached client, and the renderer's OSC 52
handler (`parseOsc52` in `terminal/osc52.ts`, applied in `TerminalNode.tsx`) writes the system
clipboard. Two traps, both measured on
tmux 3.4:
- **The `terminal-overrides ',xterm*:Ms=…'` entry does NOT work on tmux 3.2+** — with it, a copy
  emitted **zero** OSC 52 to the client. `terminal-features` is what actually enables the sequence.
  Do not "fix" the `Ms=` override back; it is why copying from SSH sessions never worked.
- **No `pbcopy` pipe.** The copy-mode bindings are bare `copy-pipe-and-cancel` (no command): piping
  to `pbcopy` was macOS-only, and over SSH it would have copied on the *remote* host anyway. OSC 52
  is cross-platform and works over SSH.

**Copy-on-select (opt-in, `copyOnSelect`, default off — #759)** is the route for a selection
**xterm** owns, which OSC 52 never sees: a plain drag on Windows (no tmux), a forced Option/Shift
drag inside a mouse-tracking app. `terminal/copy-on-select.ts` triggers on the GESTURE (a press
xterm's SelectionService takes, then a release anywhere), not on `onSelectionChange` — the search
addon's `select()` must never touch the clipboard. Canvas node and kanban modal only, never the
settings preview; attached once per xterm (it survives park/adopt) and written via the bridge's
`{ quiet: true }` path so a failed write raises no toast per drag.

**Every viewer answers the tmux client's handshake; only one answer may reach it** (issue #1172).
A new tmux client queries the terminal it is drawn in (DA1 `ESC[c`, DA2 `ESC[>c`, XTVERSION, OSC
10/11 — measured on 3.4). With N viewers on one pty (two Server Edition tabs, a canvas node plus its
kanban card modal, a relay peer) all N xterms answer; tmux consumes ONE DA answer inside its ~5 s
query timeout and passes the rest — and a lone late one — to the pane as typed input, so
`1;2c0;276;0c` landed in front of agent launch lines (the echo check passes: the line itself is
intact) and in live prompts on every reattach. OSC replies are always consumed by tmux. The gate is
`core/da-reply-gate.ts`, per Session, fed from `proc.onData` and applied in `PtyManager.write`: a write
made ONLY of DA1/DA2 replies spends one open query of its kind per reply, and a reply with no open
query (a duplicate, an unsolicited one, or one past `DA_REPLY_TTL_TMUX_MS` = 4 s for a real tmux
client) is dropped. Rules: match only `CSI ? … c` / `CSI > … c` — no key produces them, while a
broader report match eats keystrokes (`ESC[1;2R` is CPR AND Shift+F3); touch only whole reply-only
writes (xterm.js emits each reply as its own data event, so a mixed write is a person); never close
the gate for the session's life (a pane app's DCS-passthrough query shows up as the same `ESC[c` and
gets exactly one answer).

**A tmux client is not necessarily a watcher.** `SessionInfo.clients` is a COUNT
(`#{session_attached}`), never a boolean, because one session can hold several: the app's painter,
the user's own `tmux -L node-terminal attach`, a second nodeterm on the same socket, and our own
**control-mode shadows** (`PtyManager.shadowAttach`, used for background writes without spawning a
painter). The session reaper subtracts ours via the `shadowed` seam — a shadow is a real client but
not a watcher, so a shadowed session must stay exactly as cullable as an idle detached one.

The count is carried numerically rather than collapsed at parse time **because the subtraction
needs it**: a session holding our shadow AND a real client must still read as attached, and a
boolean could only be forced to false — reaping the session out from under whoever that other
client belongs to. **Any future reader of `list-clients` / `session_attached` owes the same
subtraction.**

Lifecycle, by intent:
- **Offscreen release (in place, 2026-08-11)** → a mounted node fully offscreen past
  `settings.offscreenTerminalMinutes` detaches its PTY client and disposes its xterm without
  unmounting (plate shown; tmux keeps running; reattach-redraw on approach, measured <500 ms).
  See the Terminal node lifecycle section for the two invariants (mount-stable observer;
  `session.source` remote gate). Note the released node is a DETACHED tmux session — it joins
  the session reaper's candidate pool (6 h grace still protects it).
- **A hidden window counts as offscreen (2026-10)** → close-to-tray (the Windows default), macOS
  hide-on-close and minimize send `app:window-visibility` (`main/window-visibility.ts`); the
  renderer flag (`terminal/window-backgrounded.ts`) makes every node report itself offscreen
  through the SAME mount-stable observer path, so the release runs at `min(offscreen setting,
  BACKGROUND_RELEASE_DWELL_MS = 2 min)` behind every existing gate (live-work, held launch, Eco,
  remote, selected, `0 = never`); after that dwell Canvas runs the memory-pressure reclaim pair
  (`runReclaimLevers`), which now frees the on-screen terminals' WebGL contexts too because they
  all read hidden. Show cancels the dwell and revives warm. It feeds existing levers — it is not a
  new one — and an occluded window or a Server Edition tab switch never triggers it (explicit IPC,
  not `visibilitychange`; the bridge declares it a no-op). Eco and the liveness poll see a hidden
  window as "nobody watching" too. **A raw Electron `hide` is NOT the signal**: on macOS
  `BrowserWindow` emits `hide`/`show` from occlusion changes (a window merely covered by another
  app, another Space, ⌘H), so main forwards `hide` only when the close branch set
  `windowHiddenByApp` before its own `win.hide()`; `minimize` always counts. A focused renderer
  clears the flag (fail-safe for a WM that restores without a `restore` event).
- **Every memory lever must ask whether the kill ends live work** (`terminal/live-work.ts`). The
  renderer reclaims terminal memory in FOUR places — park window expiry, the park's LRU cap, the
  memory-pressure drop (all three in `park-budget.ts`) and the offscreen viewer release
  (`offscreen-policy.ts`) — and all four were written as if dropping a PTY client were free,
  because "the tmux session keeps running and re-attach redraws". **That sentence is only true
  where tmux is actually underneath.** On the plain-shell fallback (no tmux installed, tmux
  switched off in settings, or an install path `findTmux` missed) the pty IS the shell, so the
  identical call kills it and everything under it — an agent CLI mid-turn included. Issue #126: a
  project switch terminated a working Claude agent, which then auto-resumed from wherever the kill
  landed. The predicate is deliberately the narrowest one that closes it — a tmux-backed session is
  never protected (the kill costs a redraw), and neither is a plain terminal. **An IDLE agent CLI on
  a non-persistent pty IS protected** (`agentProcess`, `agentProcessInPane`; not once hibernated,
  paused, dropped, or once its CLI announced a SessionEnd, `sessionEnded`, which is its own
  transient flag because `state: undefined` alone is also what an idle agent looks like): killing it looked free because cold restore `--resume`s it on revive, but the
  resumed CLI fires `SessionStart:resume` and idles with no further hook event, the status mirror
  leaves it unverified, and agent messaging refused it for as long as it stayed idle — measured
  2026-09-13 on Windows native ptys. The mirror now also lets a verified `idle_prompt` right after a
  verified `SessionStart` commit a verified non-inferred `done` (`MirrorEntry.sessionStarted`), and
  the decider reports a proven node reset by a boundary as `targetNotIdleUnknown`, not
  `targetStatusStale`. **A fifth lever owes the same gate.**
  The fifth is the offscreen release of an ARMED node (`shouldDeferReleaseForHeldLaunch`):
  held launches now require the attached transport for echo verification, on every backend.
  Keep that transport until delivery or recovery; a blind paste by session name loses the
  shell-init repair and canonical-line protections.
- **Node unmount (project switch)** → the RENDERER **parks** the terminal (`TerminalNode.tsx`
  `parkedTerminals`): the xterm instance + its attached PTY stay alive with the `.xterm` element
  detached from the DOM, so a remount within the park window re-adopts them — instant, and
  exact (the tmux client never detaches, so mouse-tracking/alternate-screen modes and scrollback
  carry over; do NOT "optimize" this into a respawn+redraw — a fresh xterm on a reused client
  misses the attach-time mode sequences and breaks scrolling). The park timer then runs the real
  teardown: `kill()` detaches the PTY client; the tmux session keeps running. **Window and cap
  are settings (issue #886)**: `settings.terminalParkMinutes` (default **10**, raised from 5; **0 = until app quit** —
  `parkWindowMs` returns `null` and NO timer is armed, never `Infinity`, which `setTimeout` clamps
  to ~1 ms and would dispose every park at once) and `settings.terminalParkMax` (default **20**, raised from 12), both
  re-validated at park time. The LRU cap evicts **local parks before remote ones**
  (`planParkEviction`'s `isRemote`): a local re-adopt miss is a warm reattach in ms, an SSH one is
  a new client per terminal paced 4-per-master, plus a login if the master idled out
  (`ControlPersist`) — and a live parked client is also what keeps that master from idling out.
  Parking does not raise sshd `MaxSessions` pressure: masters are per project, so a parked SSH
  project holds exactly the channels it held while in view. Measured (headless xterm, 200×50): a
  parked tmux-backed terminal ≈ **2 MB** (alternate screen, empty normal buffer — tmux owns the
  history); a plain shell with a full 10k scrollback ≈ **27 MB**. WebGL contexts are
  **viewport-scoped and budgeted** (browsers cap ~16 live contexts, and a canvas holds far more
  terminals). A per-terminal `IntersectionObserver` (`rootMargin` pre-announces approach) only
  REPORTS visibility to a **module-level budget coordinator** (`terminal/webgl-budget.ts`) that owns
  every grant decision and all timing: it keeps the contexts WE hold at/under the live budget
  (`WEBGL_BUDGET` 12 default — the browser Server Edition; on DESKTOP main raises Chromium's cap
  itself via `--max-active-webgl-contexts` = 32 and boot raises the budget to 24 via
  `setWebglBudget`, constants in `src/shared/webgl.ts`) so
  the browser never has to **force-evict** — which is the bug that flashed Chromium's dead
  "lost context" placeholder (white box + sad-face) on a visible terminal during a fast pan / zoom
  out, because the old per-node observers each acquired independently and momentarily overshot the
  cap. Rules: a client granted only after an **acquire debounce** (`WEBGL_ACQUIRE_DEBOUNCE_MS`, so a
  pan-through never grabs a context for a two-frame flash); if granting would exceed the budget,
  **reclaim on demand from the least-recently-visible HIDDEN holder** (`hiddenAt` LRU order);
  if every holder is currently visible (zoomed way out), the newcomer is NOT granted and **stays on
  the DOM renderer** — we never push past the budget. A hidden holder keeps its context
  **indefinitely** (warm for a pan-back of any length) — there is no time-based release; it is
  reclaimed strictly on demand, either by a visible newcomer that needs its slot or by
  `releaseAllHiddenGrants` (queued through the drain) under memory pressure. `acquire()`
  returning false (WebGL2 unavailable) doesn't burn a slot; an externally-lost context
  (`onContextLoss`) is reported via `handle.contextLost()`, drops from the accounting, and — for a
  still-VISIBLE client — schedules ONE delayed budget-gated re-grant (sleep/wake GPU resets lose
  every context at once with no visibility change; without this every woken terminal sat on the
  DOM renderer until panned out and back). The NODE still never re-acquires itself (that loop is
  the eviction fight the design fears): the retry goes through `tryGrant` — never exceeds the
  budget, never reclaims a visible holder — and stops after `WEBGL_LOSS_STREAK_MAX` consecutive
  losses (visibility transition resets). The node registers via `registerWebglClient` on mount
  and `handle.dispose()`s on unmount (which releases + cancels timers). A parked terminal is
  off-screen so it holds no context. Permanent-delete paths call `disposeTerminalOnUnmount(id)` so a
  deleted node disposes instead of parking.
  **A renderer released while the node is unmeasurable mismeasures its own row spacing**
  (`terminal/dom-renderer-spacing.ts`): `WebglAddon.dispose()` is also the back-to-DOM-renderer
  path, and it runs from the lifecycle effect's CLEANUP — after React detached the element — so the
  fresh DOM renderer derives `letter-spacing` from a width cache whose `offsetWidth` is **0** and
  bakes in a whole extra cell per character. That is the "letters drift apart for a split second
  after a project switch": the adopting mount paints wide until the WebGL grant lands 150 ms later.
  Focus mode's `display:none` wrapper is the same shape. xterm re-derives the spacing on a char-size
  / dpr / options change and **not on a resize**, so nothing in the reattach path heals it —
  `applyFit` calls the change-gated `resyncDomRendererSpacing(term)`, which bails while the
  measurement is still 0 rather than re-baking the wrong number.
  **Which renderer a terminal uses** is `settings.terminalGpuRendering`, resolved by the single
  resolver `resolveTerminalRenderer(value)` (`src/shared/webgl.ts`) to `dom | webgl | shared`:
  `'off'` = xterm's DOM renderer, `'on'` = one budgeted WebGL context per terminal (everything the
  paragraph above describes), `'shared'` = **glyphgrid**, ONE canvas-wide WebGL2 context every
  terminal paints into (`src/renderer/glyphgrid/`, reached through `terminal/glyphgrid-attach.ts`;
  the per-terminal budget is OFF in this mode). `'auto'` (the default, and what legacy/unknown values
  fall back to) = **`webgl` on EVERY platform**, macOS included. The macOS branch has moved twice:
  it was `dom`, then `shared` on 2026-08-05 (per-terminal WebGL composited terminals black after
  zoom-out bursts, blamed on the OS compositor), and is now `webgl` — the blackout was root-caused
  not to context count but to a dependency skew (addon-webgl 0.19's dispose crashed on the 5.5 core
  and aborted its own DOM-renderer restore; pinned + healed, see
  `renderer/terminal/webgl-addon-pair.test.ts`). What actually guards macOS is a lower budget,
  `WEBGL_BUDGET_DESKTOP_MAC` (16, vs 24 elsewhere), capping compositor pressure at every zoom. The
  four-way setting stays as the escape hatch: `'shared'` is now opt-in only (also where the macOS
  default points back if the one unconfirmed 2026-07-30 whole-window-flicker report recurs), and
  `'off'` drops GPU rendering entirely.
- **Window close / app quit** → clients detach (`PtyManager.killAll()`); the tmux session keeps
  running. `killAll()` deliberately does NOT kill sessions.
- **Window close off macOS = background mode** (`settings.runInBackgroundOnClose`, `'auto'` = on for
  Windows, off for Linux; `resolveBackgroundOnClose` in `main/background-mode.ts`): the × HIDES the
  window into a notification-area tray (`main/tray.ts`, pure model `tray-model.ts`: Open / unread /
  phone-access status / Quit) so the phone relay host, hook server, notifications and updater keep
  running — the Dock analogue. A hide is not a quit, so no confirm dialog; tray **Quit** is plain
  `app.quit()` (before-quit + confirm run as for the menu Quit — File → Exit on Windows, where
  Electron's quit role has NO Ctrl+Q accelerator; never set `quitting` before it, a cancelled
  confirm must leave the × hiding). Hide only while the tray actually EXISTS
  (`backgroundOnCloseActive`), so a failed tray never turns × into a hide with no way back. The
  updater/update-prep quits keep flipping `quitting` first, or a hidden window would block them.
  First hide posts a one-time toast (userData marker file, not a settings key — the renderer's
  full-snapshot saves would overwrite a main-side settings write).
- **Node reopen / app relaunch** (nothing parked) → a new PTY attaches to the same
  `nt-<nodeId>` session and tmux redraws current state.
- **User clicks ×** → `destroy(persistKey)` runs `tmux kill-session`, permanently ending it. For a
  REMOTE node it kills the remote session **and then the local one of the same name** — normally a
  no-op, but it reaps the orphan the pre-`requireRemote` local fallback below could leave behind.
  **Whether a node IS remote is answered WITHOUT a live session** (`core/remote-end.ts`,
  `planRemoteEnd`). `runEndSession` used to read it off the dying `Session` alone
  (`dying?.sshRemote`), and its comment claimed "both callers run while the session is still live"
  — which is false for the case that matters: a delete arrives precisely when there may be nothing
  attached (an app restart, the offscreen release, the 5-min park expiry, a project that is not
  even open). `dying` was then `undefined`, remoteness read as "local", the remote branch was
  skipped **in silence**, and the one kill that went out went to the LOCAL socket, where a
  `requireRemote` node has nothing at all. Everything else about the teardown ran, so the node left
  the canvas looking deleted while its `nt-<id>` kept running on the host — a leak with no surface
  anywhere. The durable answer is the machine-local index: the shell wires
  `PtyManager.setRemoteNodeOwner` to `workspaceStore.sshProjectIdForNode` + that project's
  ControlMaster (`refForProject`). A LIVE `sshRemote` still wins when there is one — it is the exact
  master the session was spawned over, and a node created seconds ago may not be in the index cache
  yet — so the two sources are complementary, not redundant. The Server Edition wires no resolver
  (it has no SSH-project manager) and its deletes stay on the local path unchanged.
  **And the kill is CHECKED.** The old `catch {}` read "remote session may not exist / master down;
  ignore", which are not the same fact: tmux's own exit 1 ("can't find session", `probeSaysAbsent`)
  is an ANSWER, while ssh's 255 / a 127 / a spawn error is a NON-answer with the session still
  running. A non-answer — and a node whose project has no master at all — is **recorded**
  (`core/pending-remote-kills.ts`, atomic JSON under userData, keyed by `user@host` because several
  projects share one host's tmux server) and settled the next time that host connects
  (`SshProjectManager.settleOwedKills`, hung on the shared connect attempt so the REUSE branch pays
  too; an entry is dropped only on tmux exit 0 or 1). The delete itself is **never refused** over an
  unreachable host: the node is going, and a refusal strands it on the canvas with the same session
  still running plus a dialog — the user answers that by deleting it again. That trade is only
  defensible BECAUSE the debt is durable; drop the store and refusing becomes the honest option.
  **Only a `delete` may owe a debt.** A `recycle` keeps the node (worktree move, model switch,
  "pause & end session"), so a kill deferred to a later reconnect would land on the session that
  node has since RESPAWNED under the same name — ending live work hours after the action that
  queued it, with nothing on screen connecting the two. A recycle still ATTEMPTS the remote kill;
  it just records nothing when it cannot land, exactly as before.
- **A remote node is NEVER spawned locally** (`PtyCreateOptions.requireRemote`). `sshRemote` says
  "here is the master to run over"; `requireRemote` says "and if there isn't one, spawn NOTHING".
  Without it, a create with no `sshRemote` falls through to core's local tmux/plain-shell branches
  — which is how an SSH project's terminal opened while the ControlMaster was down (no network,
  host unreachable, `ssh` missing) quietly became a LOCAL shell in the local `$HOME`: same node id,
  same `SSH user@host` header chip, the REMOTE session's scrollback snapshot replayed into it, and
  — for an agent node — a cold-restore `claude --resume <remote session id>` running on the wrong
  machine under the local account, leaving an orphaned local `nt-<id>` behind. Refused on both
  sides: the renderer never calls `create` when `resolveSshRemote` came back empty
  (`CoState.offline` + the node's Reconnect button), and core refuses in `spawnNew`
  (`PtyCreateResult.unavailable`) so a master that dies inside the round-trip can't sneak through.
  The spawn refusal is in `spawnNew`, and `join` refuses (`'held-elsewhere'`) a `requireRemote`
  create whose held session is local or on another host (host, user, or port differs) — a join to
  the SAME remote's live session (a second view over the same endpoint) still attaches, and so does
  a create that names no `sshRemote` onto a held remote session (its master momentarily down, or a
  relay tab's create on the host, which carries none). The held session is never killed. A relay /
  team tab's node, which may carry no `sshRemoteTmux` at all, is kept off this core by the session
  it runs under plus a renderer-side `spawnBelongsElsewhere` refusal (Projects (tabs)). An
  offline node reports itself to `SshReconnector`, so the canvas heals itself; `retryNow` (banner
  Reconnect / node Reconnect) skips the backoff and clears the refuse window.
  **Whether a node is remote comes from its PROJECT, never from its own fields** (issue #1186,
  `@shared/ssh-project-nodes`). `requireRemote`/`sshRemoteTmux` used to be stamped only by this
  machine's node factories, but an SSH project's `project.json` lives on the host and other writers
  put nodes into it — above all the host's own desktop, which opens the same folder as a LOCAL
  project (`cwd: "."`, no `ssh` fields). Such a node ran on the VIEWING machine in an unrelated
  folder, under the id the host was running. Three layers: (1) `fileToProject` routes every session
  node of an SSH project to the project's host (`routeSshProjectNodes`: `ssh` = the project server,
  `sshRemoteTmux`, cwd resolved POSIX-style against `remoteCwd`; editor/video/files get `sshFs`),
  and `persistedCanvases` / `getNodeResolved` read the cache the same way; (2) `projectToFile`
  writes the SSH mirror NEUTRAL (`neutralSshProjectNodes` drops those fields, cwd back to `./x`),
  because the file is shared LAYOUT — a node stamped "runs over ssh on <host>" cannot run on the
  host's own desktop at all; (3) core refuses a local spawn whose `ownerProjectId` is an SSH project
  (`PtyManager.setSshProjectCheck`, wired in BOTH shells from the index) even without
  `requireRemote`. Kept as written: a plain `ssh <host>` terminal (`ssh` without `sshRemoteTmux` —
  `shell: 'ssh'` at the spawn) and a foreign host ATTACHMENT (`sshRemoteTmux` + another host). The one
  local terminal an SSH canvas may hold is a LOCAL-account login node, marked in memory only
  (`renderer/lib/localOnSshCanvas.ts` → `localOnSshCanvas` on the create; a scoped relay guest's is
  deleted); after a restart it routes to the host like any other node. **Downgrade:** a build older
  than this one reads the neutral file's nodes as local (the bug it already had for host-made nodes).
  **The phone's relay `pty.attach` is the other way in, and it is closed the same way**
  (`PtyManager.prepareRelayAttach`, pure routing in `core/relay-attach-plan.ts`). It used to call
  `attachDetached(nodeId)` → `tmux new-session -A` on the LOCAL socket for whatever id the phone
  named, with no `sshRemote` and no `requireRemote` — so an SSH project's node opened on the phone
  before the desktop mounted it became a local shell in this machine's `$HOME` (no context meter, ⌘M
  fell back to Markdown, work ran on the wrong machine), and the desktop's later mount created a
  SECOND `nt-<id>` on the host: one node id, two sessions, two machines. Rules a refactor must not
  undo:
  - **Where is decided from THIS machine's records, never the phone's words.** The desktop wires
    `setRelayNodeResolver` (`workspaceStore.relayNodePlacements` — EVERY project holding the id, the
    node as that project recorded it — plus `SshProjectManager.spawnRefFor` and the index's SSH
    identity). A node is remote when it carries `sshRemoteTmux` + `ssh` (a host attachment routes
    over its attachment scope, as `sshConnectionScope` does) or sits in an SSH project; a plain
    `ssh` terminal (`ssh` without `sshRemoteTmux`) runs `ssh` locally, as the renderer does. The
    phone's optional `projectId` may only CHOOSE among those placements, or REFUSE (an unknown id it
    places in an SSH project) — it never routes a node anywhere on its own.
  - **Remote = over the project's live master, with `requireRemote`, or refused** with a sentence
    the phone shows (`{message, reason}`: `not-connected` / `no-ssh` / `still-connecting` /
    `unregistered-remote`). Never a local fallback. A master whose connect setup has not finished
    (`Conn.setupDone`, set exactly where `connected` is emitted) may only JOIN a session the host
    positively lists — the renderer's `waitForSshRemote` rule: a session created before the setup
    chain carries no hook/account env and no tmux.conf, for life.
  - **The env is the desktop's, from the one builder.** The plan hands `spawnSession` the node's
    recorded `agentId` / `agentModel` / `accountId` / `cwd` / `shell` / `ownerProjectId`, so
    `buildPtyEnv` (agent id, canvas-control grant, permission wait), the account dir and project
    overrides apply exactly as on a desktop create; no second env is written for the relay. The
    shared pre-spawn refusals (`requireRemote`, the managed-Codex scope) are ONE helper,
    `spawnRefusal`, used by `spawnNew` and the relay. Pane ownership is still NOT recorded for a
    relay-created session (unchanged): the owner would be derived from project files, which is the
    one source that ledger refuses to trust.
  - **One id in a local AND an SSH project** (the same committed canvas opened in two folders) is
    answered by whichever session exists: a live LOCAL one wins, otherwise the remote one.
  - **Existing damage is reported, never killed.** A stray local `nt-<id>` the old path left for a
    node that only lives remotely is never attached from the relay again (and the desktop's own
    mounts already pass `requireRemote`), and a relay attach that finds one logs a `[relay] … left
    untouched` warning. It is not killed automatically: it may hold work typed into it, and nothing
    proves it idle. Do NOT point a user at the session-memory panel's × for it — a delete resolves
    remoteness from the index (`planRemoteEnd`) and would end the REAL remote session too; the
    manual cleanup is `tmux -L node-terminal kill-session -t =nt-<id>`.
  - Server Edition: no phone relay host, no resolver wired — `prepareRelayAttach` there is the bare
    local attach it always was. Tests: `relay-attach-plan.test.ts` (matrix),
    `pty-relay-attach.test.ts` (real PtyManager, node-pty mocked), `remote-security.test.ts`
    (host reply), `main/relay-attach-wiring.test.ts` (the desktop wire, at source level).
- **Codex's auto-started shared daemon: every nodeterm Codex TUI runs `--no-daemon`** (2026-09-30).
  From codex-cli **0.157.0** the `daemon_auto_start` feature is `stable, true` (0.156.1:
  `experimental, false`; 0.148.0: no such feature): a plain `codex` TUI no longer runs in-process
  but starts, or JOINS, ONE background `app-server` per `CODEX_HOME`, and that daemon keeps the
  environment of the pane that STARTED it and outlives it. The daemon is what spawns tool shells and
  hook processes, and nodeterm tells a node apart by environment (`buildPtyEnv`). MEASURED on
  0.159.2 (private `CODEX_HOME`, private tmux socket, `env -i`): pane A (`NODETERM_NODE_ID=node-A`)
  started the daemon; in pane B (`node-B`) the tool shell printed `node-A` and every hook process
  logged `node-A` — pane B's status, canvas-control verbs and context-link reads were pane A's.
  `--no-daemon` put pane C back on `node-C` in both; `-c features.daemon_auto_start=false` did NOT
  (it still joins a RUNNING daemon); there is no environment switch. Transcript and the three help
  pages: `src/core/__fixtures__/codex-daemon/`. Rules a refactor must not undo:
  - **Feature-detected, fail open.** `core/codex-cli.ts` `codexNoDaemonFrom` reads the flag off the
    option-header lines of the same memoized `codex --help` the approval vocabulary uses;
    `CodexCliCaps.noDaemon` rides the existing `ApprovalCaps` bag (`codexNoDaemon`) that every launch
    site already threads, and `withCodexNoDaemon` (`shared/agents/codex-daemon.ts`) appends it in
    BOTH assemblers — fresh launch and resume (cold restore, restart, restart-with-model, account
    switch, transfer, headless Server opens, custom agents whose `baseAgent` is codex, a launch-
    command override). Only a literal `true` emits it: clap exits on an unknown option, so an
    unprobed, remote-unknown or older CLI gets the line it always got.
  - **Await the answer before building a line — the race is the bug.** After a reboot every Codex
    node cold-restores in the same tick; a node that builds its line before the probe lands launches
    flagless, starts the shared daemon with ITS env, and every other node joins it. On a
    shared-identity machine `codex app-server daemon version` reports such a daemon `running`
    (verified in review), so the managed launcher adopts it too. So TerminalNode's four codex sites
    (cold restore, its fresh fallback, restart, wake) `await ensureCodexLaunchCaps(...)`
    (`renderer/state/codexCli.ts`, 3 s bound, fail open to the old line): local waits for the local
    probe, SSH waits for that host's answer to arrive in `useSshConn`, non-codex agents and relay
    tabs never wait. Pinned at source level by `nodes/codex-launch-caps-wiring.test.ts`.
    `createAgentNode` (a NEW node) is synchronous and still reads the landed answer — a node created
    inside the first ~second after boot can miss it; stated, not fixed.
  - **A relay tab never gets this machine's answer.** Its pane runs the HOST's codex; the guest's
    `true` typed into a host older than 0.156 dies on the unknown option. `codexApprovalCaps(remote,
    projectId)` treats a relay-bound project (checked through `registerCodexRelayProjectCheck`,
    registered by the projects store to avoid an import cycle) or a node's
    `session.source === 'relay'` as remote-with-no-probe: no flag, baseline vocabulary.
  - **One detection rule, two spellings.** `CODEX_NO_DAEMON_HELP_RE` / `_ERE`
    (`shared/agents/codex-daemon.ts`): an option header at indent <= 6 followed by whitespace or end
    of line, so a future `--no-daemon-x` is not this flag. TS reader, launcher and remote probe all
    use it; a test runs the ERE through real `grep -E` beside the regex.
  - **Never beside `--remote`** — measured: `ERROR: --no-daemon cannot be used with --remote.` The
    managed launcher (`buildCodexLauncherScript`) therefore STRIPS it before its own
    `codex --remote unix:// resume` and routes every plain-codex fallback through `nt_exec_plain`,
    which keeps it, or ADDS it when the codex about to run advertises it (the SSH launcher's host was
    never probed from here). This matters beyond the fallback node itself: a daemon started by a
    plain pane carries that pane's `NODETERM_NODE_ID`, and the thread-identity prelude only resolves
    a tool shell whose `NODETERM_NODE_ID` is EMPTY — so one plain launch used to poison every managed
    thread of that account too. Our own start stays the scrubbed `nt_start_app_server` (#350).
  - **SSH: the HOST's binary is asked.** `core/remote-ssh/codex-no-daemon-probe.ts` runs one
    marker-delimited `codex --help` through the login shell after connect (off the connect path, like
    the claude probe) and publishes `{hostKey, supported}` on a `connected` event and on a reused
    connect's result; the renderer keeps it per host (`useSshConn.codexNoDaemonByHost`). **The key
    is `user@host:port`** (`codexProbeHostKey`), NOT `sshHostKey`: two containers behind one machine
    (`root@localhost:2222` on 0.159, `:2223` on 0.148) are two binaries, and a portless key let the
    last probe answer for both. The SSH mirror slice carries the host's `true` to the phone.
  - `codex exec` (commit messages), `login`, `mcp` and `app-server` take no such flag and are not
    TUI clients of the daemon. The phone gets `MirrorSettings.codexNoDaemon`, local and per SSH slice (iOS
    reader: upstream follow-up). opencode was checked the same way: no published release has `serve --service`
    (latest 1.18.33 and the `dev` channel), and a plain TUI leaves no process behind.
  - **Residuals, stated:** (1) a `codex` TYPED into a pane rather than launched by us — by hand in a
    plain terminal, or by an agent through `open-terminal --cmd codex` / `write` — carries that
    node's `NODETERM_NODE_ID` and, on 0.157+, can still start the account's daemon with it; managed
    threads' tool shells then keep the leaked id (the prelude skips a set one). Changing the prelude
    to prefer the thread record over a set id was rejected FOR TOOL SHELLS: a bind-refused fallback
    pane legitimately runs a thread another node's record names. HOOKS are different (#1175, below):
    their payload names the event's own thread, so the codex hook script lets that thread's record
    outrank an inherited id unless the pane is marked `NODETERM_CODEX_PLAIN=1`. (2) A launch-command override or custom `launchCmd`
    that runs a DIFFERENT codex than PATH's (`npx @openai/codex@0.148.0`) is given the flag from
    PATH's probe and dies on it; the fix there is the user's (drop the pin or add the flag to their
    own command) — we cannot probe an arbitrary command line. (3) The Windows argv planner
    (`core/agent-launch.ts`) carries the flag but has no production caller today; Windows native
    Codex is unmeasured.
  - **Machines that ran a pre-fix build keep the mis-attribution until they recycle.** Panes already
    joined to the daemon stay joined across a warm reattach (the TUI process is still the old one); a
    daemon started before the fix keeps its first pane's env, and so does its `pid-update-loop`
    process (verified in review), so managed threads keep using it. We deliberately do NOT kill it:
    every unsupervised plain client attached to it would die with it. Recovery, in order: restart
    each Codex node (node menu → Restart, or close and reopen), then from a shell WITHOUT any
    `NODETERM_*` variables run `codex app-server daemon restart` (one per account: set that
    account's `CODEX_HOME`).
  - **Device checklist:** (a) macOS desktop, npm codex ≥ 0.157: two Codex nodes, each RUNNING badge
    and `nodeterm list` line on its own node; (b) standalone codex with shared identity: a node
    whose launcher fell back still reports as itself; (c) SSH project on a host with codex ≥ 0.157:
    the second remote Codex node's badge is its own after the probe landed (and flagless before);
    (d) Windows native codex: whether the daemon exists there at all is unmeasured — the flag rides
    only if its `--help` lists it; (e) reboot a Mac with 5+ Codex nodes: after cold restore each
    badge is its own (the bounded wait); (f) an upgraded machine: after the recovery steps above,
    `ps eww` on the daemon shows no `NODETERM_NODE_ID`; (g) two SSH projects on one host at
    different ports with different codex versions: only the newer one's lines carry the flag.
- **A shared Codex daemon restart is NOT a terminal-session restart.** tmux survives, and the Codex
  rollout/thread survives, but every `codex --remote unix://` TUI attached to that account's one
  app-server socket exits together. `buildCodexLauncherScript` therefore stays in the pane as a
  bounded transport supervisor after binding a thread instead of `exec`ing the remote TUI. On an
  abnormal client exit it resumes that exact thread only when `app-server daemon version` no longer
  reports `status: running` or the known control-socket inode changed; the same healthy generation
  returns the original status so a deterministic CLI error cannot relaunch forever. A reconnect
  never replays the launch prompt/options (that would duplicate the user's turn), and three rapid
  resets stop with a manual `codex resume <thread>` receipt. Preflight probes live protocol health
  before lifecycle start: Codex's PID ownership record can go stale while the shared process remains
  responsive, and killing that "orphan" would fan one bookkeeping failure out across every node.
  The generated-shell tests run the replaced-socket, missing-daemon, healthy-client-error, and
  responsive-orphan cases under real `/bin/sh`; the healthy-error case is the mutation guard.
  **Both shells wire this spine.** Electron and Server Edition arm the same signed record secret,
  thread start/bind handlers, capability refresh, and UI identity events; the server composition is
  isolated in `server/codex-shared-identity.ts` and behavior-tested. The old Server Edition
  "deliberate plain Codex" answer bypassed the launcher entirely, so a reconnect implementation in
  the launcher could be perfectly green while every headless pane still fell back to its shell.
  **No approval override ever rides that remote resume** (issue #811). MEASURED on
  `codex-cli 0.154.0` against a real thread on a running shared app-server, under a pty:
  `codex --remote unix:// resume <thread> --ask-for-approval on-request` answers
  `Error: Permission overrides are not supported when resuming a remote task.` and exits 1 —
  `on-request` being that build's own default policy and a member of its enum, so this is **not**
  the missing `untrusted` of #785. The same command with the flag removed resumes and the TUI stays
  up, and `-c approval_policy=never` is refused identically: the rule is about the OVERRIDE, not
  about a value or a spelling, so there is no mapping of `manual`/`auto`/`bypassPermissions` that
  survives this path and nothing to decide. Since `withPermissionMode` appends the flag to every
  agent launch, every shared-identity Codex node died on its first turn at a bare shell.
  `nt_run_shared` therefore strips `--ask-for-approval`/`-a` (both the spaced and the `=` form)
  from the first-launch argv. **The strip is in the LAUNCHER, not in the TypeScript that builds the
  line, and that placement is the invariant**: every identity-setup failure above it ends in
  `exec codex "$@"` — plain codex, no `--remote` — where 0.154 still accepts the flag, so
  suppressing it one layer up would take the permission mode away from exactly the nodes that could
  not get a managed identity. The `else` branch has always resumed with no caller options at all,
  so this only makes the first launch agree with the recovery beside it; the cost on an older codex
  that still accepts the flag on a resume is that the mode is not applied on the managed path, which
  after the first daemon reset was already true. **There is deliberately no capability gate**: the
  refusal is a runtime check, absent from `--help`, so `codexCliSupportsRemote`'s shape does not
  transfer — and it fires AFTER the session lookup, so a throwaway thread id answers "no saved
  session" with or without the flag. Probing costs a real resumable thread, which is the thing being
  launched.
- **"Restart agent (resume)"** → deliberately NOT a session lifecycle event: `terminal/
  agent-restart.ts` restarts the agent CLI *inside* the pane and leaves the PTY, the tmux session
  and its scrollback untouched. It exists for **new-model pickup** — a freshly released model only
  shows up in a CLI's model list on a fresh launch, and doing that by hand means closing and
  re-resuming every agent node on the canvas. Choreography: ask the CLI to quit with a fixed
  number of Ctrl-Cs (`CTRL_C_QUITS`: codex 2, claude 3, grok 3, opencode 2, copilot 2). In all
  five, Ctrl-U clears only the cursor's line, so a typed exit submitted the rest of a multi-line
  draft as a prompt, while Ctrl-C clears the whole composer and quits once it is empty (#842,
  #928). gemini alone still gets its typed exit (a bare `/quit`), because it was never measured
  — its composer is only reachable after a login. `EXIT_SEQUENCES` is still the
  gate — an agent not in it can never be restarted in place. Then poll `pty:pane-command` (`#{pane_current_command}`, local tmux socket or the
  project's SSH ControlMaster; any failure reads as "not a shell yet") every `RESTART_POLL_MS`
  (250 ms) until a SHELL owns the pane, then echo-deliver `resumeCommand(...)` — the same
  `claude --resume` / `codex resume` the cold restore uses. **Nothing is ever killed**: if the CLI
  has not quit within `RESTART_EXIT_TIMEOUT_MS` (6 s) the run reports `exit-timeout` and leaves the
  session running. **A user-asked restart gets a late window on top** (`RESTART_LATE_EXIT_MS`, 60 s,
  spent only while the pane still reads): issue #899 was a 19 h cron session whose CLI quit a moment
  AFTER the 6 s, with nothing left watching — the node sat at a bare shell with no agent and no
  resume. The Eco sweep and Pause keep the bare 6 s (the sweep is serialized canvas-wide). The
  exit-timeout notice (`exitTimeoutNotice`) hands over the bare resume line for exactly that
  late-quit case. A `working` **or `blocked`** session is refused — `/exit` typed into a
  permission prompt would ANSWER it, not quit — and a node is held one-restart-at-a-time until the
  resume line has actually LEFT the pane (an un-submitted line is where a second `/exit` would be
  spliced in). The bulk action runs the same per-node closure sequentially over every idle agent
  node in canvas order and reports one summary line. `performRestartResume` is now a COMPOSITION of
  `performExitPhase` + `performResumePhase` (2026-08-12, behavior-pinned split) — hibernation
  drives the halves separately; each half refuses independently.
- **Agent hibernation ("Eco", 2026-08-12, OPT-IN default off)** → `settings.agentHibernationEnabled`
  (+ `agentHibernationIdleMinutes`, default 30; Settings → Agents): a 60 s renderer sweep
  (`Canvas`) exits the CLI of up to **2** agent nodes per pass that are hook-idle in state `done`,
  fully offscreen (`isNodeWatched` — an open kanban card modal counts as watched), local, idle ≥
  window, non-recurring, without live subagents (`planHibernation` +
  `lib/hibernationCandidates.ts`, both pure/tested). tmux + shell survive; node shows a clickable
  SLEEPING chip; wake (view / chip / modal open) verifies a SHELL owns the pane
  (`isShellCommand` OR the persisted `hibernatedPane` the exit settled on — xonsh/elvish users) before
  the KILL_LINE'd, echo-verified `withPermissionMode(resumeCommand(...))`. Sweep/wake/menu-restart
  share ONE `guardConcurrentRestart` set. Load-bearing rules a refactor must not undo:
  (1) **recurring fact is durable** — both loop-card dismiss surfaces route through
  `lib/loopCard.ts`, which HIDES a cron/schedule card but retains `agentStatus.loop`
  (`dismissed: true`); clearing it would let Eco `/exit` a CLI whose cron wakeup lives in that
  process. (2) **Fire-time re-asks**: still-offscreen, remote, eligibility — a plan-time verdict
  is stale by seconds. (3) `hibernated` **self-heals** on live hook states + SessionStart (never
  on `done` — a late Stop POST must not undo a just-performed hibernate); cold restore (`fresh`)
  clears `hibernated` UNCONDITIONALLY and normally lets auto-resume own the node — **`paused` (see
  below) is what makes that auto-resume itself conditional**, the one deliberate exception: the
  flag it gates is still cleared, only the relaunch is skipped. (4) **Ordering with offscreen
  release**:
  Eco defers the Phase-2 viewer release until the node hibernates (hard cap idle+offscreen), but
  ONLY when the idle clock is known (`idleKnown` — `lastEventAt` is transient, so after an app
  restart nothing can hibernate and deferring would make Eco a memory regression). Eco is
  structurally inert for sessions with no turn in the current app run, and that is now a DECISION,
  not a follow-up: the persisted `agentStatus.lastSeen` clock (see **Status-grouped sessions**) is
  deliberately never an idle proof FOR ECO — see "A restored clock is not an idle proof" in
  `terminal/hibernation-policy.ts`. (A user-confirmed bulk pause is the one place it is read as weak
  evidence; see **Bulk pause** and the `lastSeen` rules under **Status-grouped sessions**.)
  The deferral is also unaware of `paused`: a deep-paused node's freshly recycled shell keeps its
  xterm alive until the hard cap, waiting for a hibernation that (being already exited, or having
  no CLI to exit) can never come — a second documented follow-up.
  Device checklist (8 items) in PR #130 — owed before recommending Eco to anyone.
- **"Pause session"** (manual, or via Eco when `settings.agentHibernationPersistAcrossRestart` is
  on) → `agentStatus.paused`, a persisted flag alongside `hibernated` with ONE job: stop a node
  from coming back on its own. Two depths, chosen per node: shallow — identical to an Eco exit
  (`registerAgentPause`'s `pause` closure reuses `performExitPhase`), plus `paused` — or "pause &
  end session" — the same recycle `restartAgentNode(…, restartShell: true)` uses
  (`transport.recycle` + a `respawnNonce` bump), so the node comes back `fresh` next time, with no
  live tmux session to hold memory. Two pure predicates in `terminal/hibernation-policy.ts` pin the
  contract: `shouldColdResume` (a `fresh` mount must not auto-relaunch a paused node — see Cold
  restore above) and `shouldAutoWake` (the mount-timer, visibility-edge, and kanban-card-modal-open
  auto-wake triggers must not fire for a paused node, hibernated or not — only an explicit Resume,
  which reuses the SAME `wakeHibernatedNode` trigger the SLEEPING/PAUSED chip's click uses, so it
  gets the same `WakeInputBuffer` splice protection and retry budget). Pausing an already-hibernated
  node skips the exit phase entirely (`alreadyExited` in the closure) — asking an idle CLI-less
  shell to quit would type `/exit` into it as a real command. `paused` is ALSO excluded from Eco's
  own candidate plan and its exit closure's fire-time re-ask (`HibernationCandidate.paused`,
  `hibernationCandidates.ts`) — a deep-paused node has `hibernated` unset (its tmux was recycled,
  not exited), so `!hibernated` alone would still admit it to a sweep whose dropped SessionEnd hook
  POST left a stale `done` behind: the same `/exit`-into-a-bare-shell mistake `alreadyExited` closes
  on the manual path, closed here on the automatic one. Node menu only today (canvas right-click +
  the sessions sidebar row menu, which shares the same `selectionItems` builder, plus a read-only
  kanban card badge and a clickable one in the card modal); no command palette entry.
- **Bulk pause** (tab menu and sessions-sidebar project menu: *Pause project* / *Cancel pending
  pauses* / *Resume all*; group frame menu: *Pause group*; a multi-selection of ≥2 agents: *Pause N
  sessions*; a count badge on the tab) → the shallow "Pause session" above, applied to many nodes
  at once, and it works on nodes that are NOT mounted (a project that is not on screen has no
  `TerminalNode`, so no registered pause closure). It never recycles a tmux session. Rules a
  refactor must not undo:
  (1) **Typing into a pane by node id is ONE primitive, `PtyManager.sendPaneKeys(persistKey, data)`**
  (`pty:send-pane-keys`, `HOST_ONLY`, classified `EDITOR_ONLY` in the relay access policy and
  `SCOPED_REFUSED` for a scoped guest). Keys go over stdin to `tmux source-file -` through the
  existing `controlInputPlan` / `remoteControlInputPlan`, never argv, to the exact `=nt-<id>:`.
  (2) **An SSH-project node is never read or typed into on the local socket.** `paneRemoteRef`
  resolves an unmounted SSH node through `remoteNodeOwner` (the machine-local index); a
  disconnected master, or a stray LIVE local session for an SSH-project node, is `not-connected` /
  unreachable, never a local fallback. `paneCommand` / `paneOwner` take an opt-in
  `{ resolveUnmounted: true }` and **the default stays the legacy live-only path ON PURPOSE**:
  agent messaging and `terminateForeground` also call them, and if they resolved an unmounted
  remote node they would prove an owner on the HOST and then act on the LOCAL socket. Zellij, the
  Windows session host, a native Windows pane and a plain shell answer `unsupported-backend`.
  (3) **`planBulkPause` (`lib/bulkPause.ts`) is the whole decision**: `now` (idle `done`, or an
  UNKNOWN state whose persisted `agentStatus.lastSeen.state` is `done` — `idleForPause`),
  `whenDone` (working / waiting / blocked, or a held question/approval ticket — typing `/exit` into
  those would answer a prompt), `alreadyExited` (hibernated by Eco: nothing to type, just mark it
  paused), and named skips, exactly the `BulkPauseSkip` reasons: `not-agent`, `no-session-id`,
  `not-resumable` (also an agent with no `exitSequence`, e.g. antigravity: resumable, but nothing
  can ask it to quit), `already-paused`, `relay`, `dropped`, `ended`, `state-unknown`. The
  unknown-state rule exists because state is transient: right after an app restart every node reads
  unknown, and an idle CLI and one mid-turn look the same — typing an exit into a running turn
  abandons it. `lastSeen` is the one clock that survives the restart, so a node last seen `done` is
  paused and every other unknown node is skipped, never guessed at (the runner re-asks the same
  rule at fire time). A skipped node says why; nothing is silently dropped, and the result line
  (`bulkPauseResultText`) counts EVERY outcome — paused, pending, unreachable, `unverified`, not
  eligible, still running, skipped — so a batch against a disconnected host never reads "Paused 0".
  (4) **`whenDone` is `state/pendingPause.ts`, TRANSIENT** (never persisted: after a restart nothing
  is watched, so a stored mark would lie). It fires on a CLEAN `done` edge only (not errored,
  interrupted or held), the mark is removed BEFORE the fire so a second edge cannot double it, and
  Resume, Cancel, node delete or the fire clear it, and the watcher also drops a mark when the node
  is paused elsewhere or its status disappears. **A mark is bound to the session it was planned
  against** (`BulkPauseTarget.sessionId`): the watcher drops it unfired when the node's session id
  changes, the runner refuses a mismatch, and every Canvas funnel that replaces the CLI —
  `restartAgentNode` (restart, fresh shell, model switch, reopen as), the Claude and Codex account
  switches, the bulk idle restart and both `transport.recycle` sites — removes it, or a mark taken
  for one turn would quit the NEW session on its first turn end.
  (5) **Every exit holds `guardConcurrentRestart(nodeId, …)`** (the Eco / Pause / restart set) and
  runs through ONE `createHostLimiter(BULK_PAUSE_HOST_CAP = 3)` per host key, shared by the batch
  and the pending fires; owner reads are bounded. The host key is `local` or the **SSH project id**,
  not the host: ControlMasters are per project, so the cap bounds channels per master.
  `pauseNodeHeadless` (`terminal/headless-pause.ts`) is `performExitPhase` over `sendPaneKeys`, with
  the menu restart's late window (`RESTART_LATE_EXIT_MS`) so a CLI that quits just after the base
  6 s is paused rather than reported "still running"; a failed key write ends that wait at once
  (`unreachable`). A pane owner that cannot be read before the exit (no live ControlMaster, a hung
  read) is `unverified`, distinct from `not-eligible` (read and refused): nothing is typed in
  either case.
  (6) **Resume all is the active project only**: waking is the mounted node's `wakeHibernatedNode`,
  so elsewhere the row is disabled with `Open the project to resume`.
  Surfaces: Desktop full (local + SSH); Server Edition has the core primitive and a real ws-bridge
  leg, but pending fires need an open browser tab (the watcher is the renderer's); relay tabs are
  refused; the kanban card menus inherit the rows through `nodeActionItems`; Mobile: follow-up.

The node id is the `persistKey` (passed to `transport.create`), so it must stay stable.
If tmux is unavailable, `PtyManager` falls back to a plain shell (no cross-restart
continuity). `findTmux()` resolves an absolute path because GUI apps don't inherit the
shell PATH, and it tries three sources **in this order: fixed system paths → the shell's
PATH → the tmux the macOS app SHIPS** (`bundledTmuxPath`). System first is deliberate — a
machine that already has tmux keeps using its own, so the bundled copy is a floor, never an
override. `resourcesPath` is `undefined` on the **Server Edition**, so the bundled binary is
unreachable there by construction; a Linux host is expected to have its own. Under
`electron-vite dev` the last candidate resolves against `process.cwd()`, which is where
`scripts/build-tmux.mjs` writes its artifact. If tmux is unavailable from all three,
`PtyManager` still falls back to a plain shell; `TMUX`/`TMUX_PANE` are stripped from the child env to avoid nesting refusal.
The same strip, one layer up, applies to a LAUNCHER that was itself an agent session: started from a
Claude Code terminal, the app used to hand `CLAUDE_CODE_CHILD_SESSION` and its siblings to every pane,
and the Claude CLI there then turned transcript saving off (no ⌘M view, no context meter, nothing for
`--resume`). `buildPtyEnv` deletes the explicit, measured `NESTED_AGENT_ENV_STRIP` list
(`core/nested-agent-env.ts`) and `ACCOUNT_SCOPE_UPDATE_ENV` lists the same names, so a tmux server
seeded from such an environment does not hand them back (the #419 mechanism). Explicit names, never a
`CLAUDE*` prefix sweep: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are how a managed account is selected.

**The local tmux CLIENT is spawned from `localTmuxClientCwd()` (home, else `/`), never the node's
cwd — the pane's directory rides `new-session -c` only** (issue #1131). Any client can be the one
that starts the shared server, the server keeps that client's cwd for life, and from tmux 3.7
`spawn.c` applies a pane's `-c` only when the server's own `getcwd()` succeeds: once the dir the
server started in is deleted (a removed worktree), every NEW pane on the server inherits the deleted
dir whatever `-c` said, and agents launched there hang. MEASURED on a locally built tmux 3.7c
(private socket): client in the doomed dir → `-c <proj>` pane at `<gone> (deleted)`; client in
`$HOME` → pane at `<proj>`. tmux 3.4–3.6 honour `-c` either way, which is why CI cannot reproduce it
and the guard is a spawn-options assertion (`pty-tmux-client-cwd.test.ts`). The plain-shell fallback
is the pane itself and keeps the project cwd; remote tmux is started from an ssh exec channel, which
sshd places in the login home. A server started by an earlier build keeps its old cwd until it is
restarted (`tmux -L node-terminal kill-server`, which ends every session).

**A session-host session follows its most recently ACTIVE viewer, like tmux's `window-size
latest`** (issue #914). Under tmux a relay-mirrored phone is its own tmux client, so dismissing its
keyboard gives it its rows back; on the session host the phone and the desktop node share ONE
client socket, and the old componentwise minimum held the phone to the desktop node's rows with an
empty band and no explanation. `latestClaimSize` (`core/pty-size.ts`) picks the claim with the
highest recency — bumped by an attach, a claim that CHANGES, and a write that is not an emulator's
automatic answer (`core/terminal-reports.ts`; every attached xterm answers a DA/CPR/OSC query, and
counting those would hand the session to whoever answered last). Three rules, each load-bearing:
(1) a viewer that cannot adapt is a CEILING — a pty wider than the phone's screen would wrap into
garbage there (or, rendered at the pty's size, be clipped to its left ~45 columns), so a relay sink is
`bounding` unless `pty.attach` said `resizedFrames: true`. The iOS app deliberately does NOT send it:
it reads `OP.Resized` only to show a "Sized to another screen · Fit this screen" hint, and every
phone report is ANSWERED (the sink's `sinkShown` is forgotten on each report) because the phone
clears that hint whenever it sends a size; (2) the real size flows back to every viewer (`SessionHostPty.onSize` →
`PtyManager.applyBackendSize` → `pty:size`, and `OP.Resized` to the sink), and a session-host
`Session`'s `applySize` only VOTES; (3) the host's `geometry` push is NEGOTIATED at `hello`
(`SESSION_HOST_FEATURES`) and sent only to sockets that asked — an older client reads every
non-`data` push frame as an EXIT. Across app connections the host still takes the minimum. Full
write-up: `docs/windows-session-host.md` → "Output ordering, flow ownership, and geometry".
