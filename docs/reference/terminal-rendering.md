# Terminal emulator, seeding and node lifecycle

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

### We have our own VT emulator — check it before asking tmux

xterm.js is not just a renderer. It parses the pane's output stream, so it **tracks DECSET modes
itself** and exposes them as public API (`term.modes`, `@xterm/xterm/typings/xterm.d.ts:1865`) —
bracketed paste, application-cursor, mouse tracking, origin mode, and the rest. We already read one
of them: `term.modes.mouseTrackingMode` decides whether a click means "follow this file link"
(`src/renderer/terminal/file-links.ts:341`).

We once did the opposite. `PtyManager.bracketPasteRequested` (now **deleted** — see the tombstone
in `pty-manager.ts`) asked **tmux** for the same class of fact, via `#{bracket_paste_flag}` — and
that format **first shipped in tmux 3.7** (2026-06-26). Ubuntu 24.04 LTS ships 3.4, Ubuntu 22.04 →
3.2a, Debian 12/13 → 3.3a/3.5a, Ubuntu 26.04 → 3.6a. On all of those it expanded to `''` exactly
like a bogus name, and the comparison against `'1'` answered **false for every pane**. The bundled
tmux did not rescue it: `extraResources` places it under `"mac"` only, and `bundledTmuxPath` is
deliberately the **last** candidate (see the comment at `pty-manager.ts:245-250` — preferring our
binary would pair a new client with the user's older running *server*, which upstream refuses). On
an **SSH project it was unfixable from our side entirely**: the remote's tmux is whatever the
user's server has.

**The rule this is an instance of: before asking tmux, ssh or `ps` something about a pane, check
whether the emulator already knows it.** Facts about *what the app in the pane is doing* (VT modes,
the alternate screen, the cursor shape it asked for) arrive as bytes we already parse. Facts about
*the session* (does it exist, what is the foreground process group, which panes are in it) are
genuinely tmux's and must be asked. Mixing the two up is how a feature acquires a dependency on a
tmux version we do not control. herdr has no version problem here for exactly this reason — it
reads `mode_get(MODE_BRACKETED_PASTE)` from its own state machine.

**Measured, and the emulator is NOT the answer here.** The `?2004h` a tmux *client* receives is
tmux's own paste-through on the outer terminal (`tty_start_tty`, gated on the outer terminfo
`BE`/`BD`), not the pane app's request: it arrives ~5 ms after attach and reads `true` even for a
pane running `sleep 30`. It never toggled across pane switches, window switches, re-attach or
co-attach. A constant is not a signal — so `term.modes.bracketedPasteMode` cannot stand in for the
pane's state, however tempting the symmetry with `mouseTrackingMode` looks.

**That paragraph is about a tmux CLIENT, and the SESSION HOST is the opposite case** (issue #686).
On Windows there is no tmux, so nothing sits between the pane's app and the host's headless
emulator: a `?2004h` it sees was written by the app itself, which is exactly the fact
`paste-buffer -p` asks tmux for. `HostSession.bracketedPasteRequested()` reads it (behind
`outputTail`, like `serialize` — xterm applies writes asynchronously, so an early read answers "no"
for the turn that just enabled it) and `sendKeysWrites` (`session-host/send-keys-delivery.ts`)
sanitizes ALWAYS and frames only when the app asked. Separate writes alone can still be read
as one burst (#780). Both native Windows `sendText` and host `sendKeys` now execute through
`core/settled-text.ts`: capture a baseline, paste without Enter, then poll at 40 ms for at most
15 polls for a changed, stable screen containing the sanitized text. Only then write one Enter,
after rechecking liveness/generation and paste mode. Unknown capture, unchanged output or timeout
leaves the paste unsubmitted and returns `pasted-not-submitted`, never `true`. The discriminant
survives IPC/WS and `sendKeysV2`; canvas writes name the partial delivery, trigger runs record
a terminal miss (including queue flush), and one-way UI writers raise a visible warning. Test
success with `=== true`, never truthiness. Do not retry an unconfirmed submit and duplicate the paste. Overlapping sendText operations on the same pane
are refused before input; insert-only, empty Enter and unframed input retain their contracts.
A collapsed/hidden/oversize paste may require manual Enter. This is an observed-screen heuristic,
not an application acknowledgement. Linux fake-PTY tests cover a 150 ms busy reader; real Windows
Codex/Claude, context-link/write, dictation and rename device checks remain required. Existing
hosts refuse the additive `sendKeysV2` command until they retire; no raw-write fallback or
automatic host restart is performed. Legacy clients still use the existing `sendKeys` command.


**The actual fix is older than the problem: `paste-buffer -p`.** From tmux's own man page — *"If
`-p` is specified, paste bracket control codes are inserted around the buffer **if the application
has requested bracketed paste mode**."* Introduced 2012-03-03, shipped in **tmux 1.7**, so it is
present on every tmux in the field. We do not have to ask whether the app wants framing; we ask
tmux to do the framing, and it applies the pane's real state. Measured on 3.4: framed when the app
requested it, unframed when it did not, correct for a non-active pane, and the whole thing in one
round trip —
`tmux load-buffer -b nt - \; if-shell -F -t <target> '#{pane_in_mode}' 'send-keys -t <target> -X
cancel' \; paste-buffer -d -p -r -b nt -t <target> \; send-keys -t <target> Enter` (`-r` keeps
`\n` as `\n` instead of tmux's default `\n`→`\r` rewrite; see `tmux-naming.ts`).

Two hazards that come with it, both measured:
- **Copy mode silently unframes.** With `#{pane_in_mode}` = 1, `paste-buffer -p` delivers unframed
  (tmux checks the copy-mode screen, not the app), so a user who scrolled the wheel up gets the
  one-turn-per-line bug. The `if-shell` guard above runs `send-keys -X cancel` first — only when the
  pane is in copy mode — in the same invocation, restoring it.
- **`set-buffer -- "$text"` hits ARG_MAX** around 200 KB. Use `load-buffer -` over stdin — and on
  the SSH path that means piping into the remote command rather than putting the text in argv.

There is no longer a probe or a fallback to weigh: `sendText` delivers through `paste-buffer -p`
**unconditionally** (the plan builders live in `tmux-naming.ts`). The old two-step path — probe
`#{bracket_paste_flag}`, and on a false answer deliver `line1\nline2\nline3\r`, raw newlines into
the app that *mangled* every multi-line write on a pre-3.7 tmux — is gone with the probe.

### Seeding a fresh xterm (`attachReplay` / `seedPaint` in `terminal/terminal-config.ts`)

A newly mounted xterm is empty. Since tmux paints its own client, there is usually **nothing to
seed** — the cases are:
- **`none`** — the terminal was **parked** (its buffer is still live and correct), or it is a
  brand-new node with an `initialCommand`. Seeding either would duplicate content.
- **`cold-snapshot`** (`fresh` — reboot/first open) — the tmux session is genuinely gone, so replay
  the persisted `scrollback-store` snapshot, with a "session restored" separator.
- **`warm-attach`** (`!fresh` — app restart, tmux still alive) — **seed nothing.** tmux is attached
  to this client: it redraws the visible screen and owns the history under the wheel. This is where
  a `warm-history` hydration (`transport.captureHistory` → `tmux capture-pane`) used to run; it was
  **removed**, because writing into a buffer that tmux then repaints is what produced the black
  bands and duplicated screens. The single exception is a **co-attach joiner** (`seedPaint` →
  `create-screen`): tmux only repaints on SIGWINCH, so a joiner that did not resize never gets a
  redraw, and the screen captured server-side inside `create()` (`PtyCreateResult.screen`) is the
  only thing that paints it — see docs/team-presence.md. **A co-attach joiner also misses tmux's
  MOUSE-TRACKING modes** (`?1000h/?1002h/?1006h`): tmux emits them only at its OWN attach, and
  neither the `screen` capture (`capture-pane` carries no private modes) nor a SIGWINCH redraw
  re-sends them — so the joiner's wheel can't scroll tmux history until a keystroke makes the app
  re-request mouse. `join()` therefore sets `PtyCreateResult.coAttachMouse` for tmux-backed joins
  (gated on a REAL tmux client — `tmuxBacked && !sessionHost`, the same local that gates
  `coAttachAltScreen`/`tmuxClient`; NOT `persistKey`, which a Windows session-host session also
  carries and whose joiner then sent wheel/drag to the shell as SGR reports — on BOTH the screen
  and resize branches) and the renderer writes
  `CO_ATTACH_MOUSE_SEQ` into the fresh xterm (both `ModalTerminal` and `TerminalNode`). tmux is
  always `mouse on`, so this matches its invariant client state; the enable is idempotent. Was the
  "can't scroll the kanban card-modal terminal until you press a key" bug. **A co-attach joiner
  ALSO misses tmux's attach-time `\e[?1049h`**, and a renderer reload is a joiner too (it re-joins
  the SAME still-alive tmux client via `join()`, so tmux never re-attaches it). `join()` therefore
  sets `coAttachAltScreen` for tmux-backed sessions only — gated on `tmuxBacked && !sessionHost`,
  never plain-shell/session-host, whose normal-buffer scrollback is their only history — and the
  renderer writes `CO_ATTACH_ALT_SCREEN_SEQ` **BEFORE** painting (entering the alternate buffer
  clears the display, so writing it after would erase the paint; TerminalNode skips it once a
  resync has superseded the seed, since that repaint may already be on screen). **Known
  limitation of "never plain-shell":** a REMOTE SSH session on a host WITHOUT tmux
  (`tmuxOrExplain`'s plain login-shell fallback) is still recorded `tmuxBacked` — core cannot tell
  from here that the remote command degraded — so it too gets the alt switch (and `coAttachMouse`,
  and `tmuxClient`'s resync re-apply), hiding that shell's normal-buffer scrollback; detecting the
  degrade is a follow-up. Without it a
  renderer reload left every terminal on the normal buffer, piling up to 10k lines of scrollback
  and forcing a layout per output frame — measured 16.1% vs 7.3% CPU for one terminal at
  20 lines/s, 313 vs 1 forced layouts per 20 s. **A resync repaint loses the same two modes**:
  `repaintResync`'s `term.reset()` drops ANY terminal — the solo spawn too, not only a joiner —
  back to the normal buffer and clears mouse tracking, and resyncs happen under backpressure, i.e.
  on exactly the streaming terminals the alt switch exists for. So every create now reports
  `PtyCreateResult.tmuxClient` (same `tmuxBacked && !sessionHost` gate, set on spawn AND join), and
  `repaintResync` writes `CO_ATTACH_ALT_SCREEN_SEQ + CO_ATTACH_MOUSE_SEQ` between the reset and the
  paint when it is set. Optional on purpose: an older core or relay peer omits it and gets the old
  behavior (nothing re-applied), never a guess. The recycle banner ("session restarted by another
  user") is written AFTER the joiner's seed paint for the same reason — written before the alt
  switch, it sat in a buffer nobody could see.

xterm's own `scrollback` (`xtermScrollback(settings.tmuxScrollback)`, floored at 1000, capped at
`XTERM_SCROLLBACK_MAX` = 10000) is kept for the sessions tmux does *not* back (a plain shell when
tmux is unavailable) and for the cold-snapshot replay — it is not what the user scrolls in a tmux
session. **The Windows session host's headless emulator (and `NativeWindowsPane`) uses the SAME
clamp** (`src/shared/scrollback.ts`, re-clamped inside the host for older clients), never the raw
`tmuxScrollback`: xterm holds every line at full width (cols × 12 B, ~72 MB for 50k × 120 cols per
session) where tmux stores only used cells, and nothing above the renderer's cap is ever shown.
tmux's `history-limit` keeps the raw value.

### Character widths — one table for every emulator (`@shared/terminal-width`)

Every xterm in the stack sizes characters through `activateTerminalWidths`: the renderer's
terminals (`renderer/terminal/unicode-width.ts`, which explains the move off Unicode 6) and the
Windows session host's headless emulator, which is what a reattaching viewer is repainted from.
The table is Unicode 11 plus one rule xterm's tables lack: **a one-cell emoji followed by VS16
(U+FE0F) is two cells**, as are the keycap sequences (`1️⃣`). The program writing to the pane
(`string-width` in every Node agent CLI) and tmux (`variation-selector-always-wide`, on by default)
both count those pairs as two cells; xterm counted one, and every repaint by absolute position after
such a character landed a column short and left stale text behind. Measured with claude-hud's
`⏱️` status line, which read `113` for `11%` and `2h 327` for `2h 32m`. VS15 is deliberately left
alone (`string-width` sizes `⭐︎` by its base, as xterm already does), and so is an ASCII base
with VS16 alone (`1️` is not an RGI emoji) and the unqualified keycap `1⃣` (one cell, as tmux sizes
it; some `string-width` releases say two). Known xterm limitation: in insert mode (IRM) a widened
join overwrites the next cell instead of shifting the line. Agreement is the goal, not a particular
number: change the table in that one module, never in one emulator.

## Terminal node lifecycle (gotchas)

`src/renderer/nodes/TerminalNode.tsx` is the trickiest file:

- The xterm instance + PTY session are created once in a `useEffect(…, [data.respawnNonce,
  offscreenEpoch])` and torn down on unmount. The component persists across re-renders because
  React Flow keys nodes by `id` — never change a node's id, or you'll respawn its terminal.
  **Third in-place state — "released" (2026-08-11, offscreen dispose):** a node fully offscreen
  in the canvas viewport for `settings.offscreenTerminalMinutes` (default 10, `0` = never;
  Settings → tmux) has its xterm + PTY client torn down IN PLACE — node stays mounted showing a
  plate, tmux session untouched — and revives (warm reattach) when it re-approaches the viewport.
  Pure policy: `terminal/offscreen-policy.ts`. Two load-bearing rules a refactor must not undo:
  (1) the **visibility IntersectionObserver lives in its own mount-stable `[termKey]` effect**,
  NOT the lifecycle effect — the down transition re-runs the lifecycle effect, and an observer
  owned there dies with it, making revive unreachable (permanent plate; caught in review). The
  lifecycle run publishes to it through refs (`visibilityReportRef`, `offscreenLiveRef`,
  identity-checked on clear). (2) The remote exclusion asks `offscreenCoreIsRemote(session.source)`
  (`'local'` only is eligible — relay/server tabs excluded), NOT `data.remote`, **a field nothing
  sets on node data** (a gate on it was constant false and type-invisible; pinned by tests).
  SSH-project nodes are also excluded; collapsed = hidden (same convention as the WebGL budget);
  a `respawnNonce` bump while released revives first. Agent-status/fan-out clears live in a
  dedicated unmount-only effect (a release or respawn must not blank a live badge).
- **React StrictMode is deliberately not used** (`main.tsx`) — double-mount would spawn
  two PTYs per node.
- The xterm container is `nodrag nowheel`; a transparent **hover-guard** overlay sits on top
  until you dwell `settings.panHoverDelay` (so quick drag = move node, scroll = pan). After
  the dwell the guard is removed and xterm takes input. The header stays draggable.
- **Sloppy focus** (default, `settings.terminalFocusFollowsPointer` ON): the dwell above TAKES the
  keyboard, and `mouseleave` only re-arms the guard — it never blurs the xterm or drops the active
  flag / presence focus. The terminal keeps the keyboard until another node takes it (its dwell, a
  click) or the user clicks elsewhere. This replaced strict focus-follows-mouse, where leaving the
  node released everything and typing with the pointer resting on the canvas went nowhere. Release
  follows DOM focus through the SAME hook click to focus uses (below), so a dwell onto a node whose
  ⌘M view covers its xterm blurs the OTHER terminal's xterm (`dwellBlursForeignTerminal`) — else the
  previous pane keeps eating keystrokes while another node reads as active. The guard stays a
  POINTER contract in this mode: the hook's `setArmed` is a no-op here (`focusDrivesGuard`).
- **Click to focus** (`settings.terminalFocusFollowsPointer` OFF; issue #757, Settings → Behavior):
  the pointer decides nothing: no dwell, and `mouseleave` changes nothing. A click (`HoverGuard`
  pointer events → `onGuardClick` → `enterNow`) or a "go to node" takes the keyboard, and the
  node's active flag, presence focus AND guard then follow DOM focus. ONE hook
  owns all of it, `nodes/useClickToFocus.ts`, and it binds to the stable `.term-node` ROOT, never
  the React Flow wrapper: focus mode MOVES that root into the fullscreen surface
  (`surface.appendChild(root)`), so a listener or containment check captured on the wrapper went
  deaf there and read every body press as an outside press. The wrapper is re-resolved at event
  time only to recognise the node's own React Flow chrome (resize handles). Root `focusin`/
  `focusout` run `focusLossOutcome` (`lib/terminalFocusMode.ts`): focus moving inside the node or
  the WINDOW blurring (Cmd+Tab) keeps it, a press on the node's own chrome (header drag — React Flow
  focuses its wrapper, MEASURED in Electron 42) hands it back to the element that lost it (the ⌘M
  composer) or the xterm (`reclaimTarget`), anything else — another node, a field, the empty canvas
  (`onPaneClick` blurs the xterm textarea, `shouldReleasePaneFocus`) — releases it and re-arms the
  guard. A press on the ⌘M chat's MESSAGE TEXT (`.term-chat__msgs`) is the start of a drag-selection, so
  its reclaim waits for the press to end (`reclaim-on-release` → `reclaimOnRelease`): a plain click
  still hands the keyboard back to the composer, but a press that selected text leaves the
  selection (and Cmd/Ctrl+C) alone — reclaiming at once moved the selection into the textarea and
  nothing in the chat could be highlighted or copied. One document capture `pointerdown` does the rest: outside the node it releases activity
  claimed WITHOUT focus (go-to-node under the ⌘M view, Canvas's own `setActive` on a jump — no
  focusout ever comes, `outsidePressReleases`), and a document capture `focusin` landing outside
  the node (its own wrapper counts as inside) does the same for KEYBOARD focus moves — ⌘M open,
  then ⌘K's autofocus — else the stale `activeId` suppresses that node's unread dot; inside the BODY, any deliberate primary press that is not on the guard runs `enterNow`
  (`bodyPressAcknowledges`) — guard down, xterm focused, ⌘M view open, all the same — so an unread
  finish is cleared by clicking the terminal, not only by clicking the guard. A focus RESTORE that
  no press caused (window activation) never acknowledges. The xterm blur that OPENING the ⌘M view
  causes is `keep`, not a release (`lostIsCoveredXterm`). Focus mode's reparent blurs a focused xterm SYNCHRONOUSLY inside
  `appendChild` (MEASURED, Electron 42: `relatedTarget` null, root still connected — so an
  `isConnected` test cannot see it); `nodes/reparentKeepingFocus.ts` brackets the move with a flag the
  hook honours (`reparenting`) and re-focuses the element that held the keyboard, in BOTH modes —
  before it, entering/leaving focus mode dropped the keyboard in the default mode too. The guard listens to POINTER events
  (`nodes/HoverGuard.tsx`): React Flow's d3-drag swallows a left `mousedown`/`mouseup` on a
  draggable node before React sees them, so the old mouse-event guard never received a left click
  (#87's click-to-focus only ever worked through the dwell). Only a literal `false` in
  settings.json selects it (`resolveFocusFollowsPointer`). The ⌘/ shortcuts panel prints "Click" instead of
  the dwell. Renderer only: Desktop + Server Edition identical; kanban card modal N/A (it has no
  hover guard); Mobile N/A.
- **Where the wheel stops being the terminal's is decided by HIT TEST, per packet** — `Canvas.tsx`
  answers `overNativeScrollable` with `target?.closest('.nowheel')`, and React Flow's own
  `panOnScroll` walks the same class (`noWheelClassName`). Two consequences, and issue #767 reported
  the second as the first. **(a) Inside the body the wheel is already the terminal's, band
  included.** `.term-node__xterm` carries `nowheel` AND is `position: absolute; inset: 0` over a
  body with no padding and no border, so the visible inset band (the host's own `4px 2px 6px 6px`)
  and a co-attach letterbox band are part of the HOST's hit area — MEASURED with `elementFromPoint`
  under headless Chromium against the verbatim rules, and now pinned as a three-link CSS invariant
  by `canvas/terminal-wheel-boundary.test.ts`. The styles.css line the report reads ("insets the
  xterm by a few px") is about PAINT — the band shows the body's `--term-bg` because the host paints
  none — and paint is not hit testing. An overlay laid over a LIVE terminal therefore owes
  `pointer-events: none` (`.term-node__stalecwd`, joining `.term-node__upload` and
  `.term-copy-pill`); an overlay that REPLACES a dead view (`.term-node__offscreen`,
  `.term-node__closed`) deliberately keeps the canvas wheel — there is nothing underneath to
  scroll, so panning is the useful answer. **(b) The boundary that actually moves is TEMPORAL, not
  spatial**: while it is up, `.term-hover-guard` covers the whole body and is NOT `nowheel`, so for
  the first `panHoverDelay` after the pointer enters — and again after it leaves — a wheel over
  terminal TEXT pans the canvas. That is the guard's own contract ("quick drag = move node, scroll
  = pan canvas") and the reason those incidents cannot be reproduced on demand. Hoisting `nowheel`
  to `.term-node__body` would swallow the guard with it (a second consumer, React Flow's, reads the
  class the same way and no per-element opt-out can reach it); hoisting it to the whole NODE would
  additionally take wheel-zoom-to-cursor away over every node, which is exactly where a
  `wheelZoom` user aims.
- **FitAddon reads the host's computed size, not its content rect.** The absolute, inset
  canvas host uses `box-sizing: content-box` so its padding is excluded from that size
  (#671). Its outer hit/plate rect still fills the body. The board modal instead keeps
  padding on a separate wrapper. Do not put border-box padding back on a fit host:
  it over-reports rows and clips the last line. `scripts/terminal-fit-layout.test.ts`
  measures real xterm layout through resize sweeps at DPR 1, 1.25, 1.5 and 2 in Chrome
  (`CHROME_BIN` overrides the executable); this does not verify GPU row-seam rendering.
- A `ResizeObserver` drives `FitAddon.fit()` + `transport.resize`. Canvas zoom is a CSS
  transform, so it does *not* change `clientWidth` — cols/rows stay stable across zoom.
  `scale-fix.ts` patches xterm's mouse coords so text selection stays aligned when zoomed.
- **`sentCols`/`sentRows` are what the pty was told, not what the emulator last fit** (`planFit`,
  `terminal/terminal-config.ts`; ordering pinned by `nodes/fit-report-wiring.test.ts`). With no session
  yet a fit resizes only the emulator, and the sent size stays what `create()` carries. Moving it there
  made the catch-up `applyFit` after `create()` read a fit that changed mid-spawn as already reported,
  which left the pty at the size `create()` carried. This applies to every backend's canvas node, and it
  adds one resize only when the fit really moved during a spawn. Found by reading the code; how often it
  fired was not measured. The same symptom on a live `wsl:` pane had another cause, a placeholder size on
  the warm attach: `docs/windows-session-host.md`, "Output ordering, flow ownership, and geometry".

## IME mode switching (#680)

`terminal/ime-mode-switch.ts` adapts xterm 5.5's composition helper after `open()` in both terminal
surfaces. Caps Lock must not finalize an active composition: the subsequent native compositionend
owns that commit. The test executes the dependency's real helper, with an unpatched double-send
control. This pins one event ordering, not every native IME; macOS Chinese Caps Lock still needs a
device run, including insertText and compositionend orderings. Revalidate the adapter on xterm upgrades.
