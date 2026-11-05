# Platform support

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Platform support

macOS, Linux, and a browser Server Edition are the shipping targets; Windows is being brought up
as a first-class desktop target (extraction from external PR #276). The policy for what "supported"
means — and what you may assume when writing a feature — is three tiers, not "100% parity":

- **Core is first-class everywhere.** The terminal + agent + canvas + session-continuity
  experience must work on every desktop platform. Continuity is tmux on POSIX and, where there is
  no tmux (Windows), a standalone session-host process — the mechanism differs, the guarantee does
  not.
- **POSIX-bound edges degrade explicitly, never silently.** Some subsystems are structurally tied
  to POSIX (SSH ControlMaster, the unix-socket askpass transport, some tmux-only paths — SSH
  projects on Windows use the in-process transport instead, see **SSH projects on Windows**). On a
  platform where they cannot work they must either use a platform-appropriate mechanism or be
  clearly gated off — a feature that throws `EACCES`/`EPERM` on Windows because nobody checked is a
  bug, not an accepted limitation.
- **Agent launch lines are POSIX source; a Windows-native pane never gets one typed if it can
  be avoided.** A prompt-bearing builtin agent node carries `data.launchIntent` (bound to its exact
  `initialCommand`, never serialized); on a local win32 session-host pane whose host recorded a
  `pwsh`/`windows-powershell`/`cmd` dialect, the launch writer executes it via `pty:execute-launch`
  (`core/launch-intent-execute.ts` → `prepareAgentLaunch` → `sessionHostExecuteLaunch`). Every
  other pane answers `unsupported-shell` and keeps the typed line byte-identical. Only a
  pre-delivery refusal may fall back to typing; `delivery-failed` never does. Details:
  docs/windows-session-host.md, "Agent launches in a Windows-native shell".
- **Run configurations (launch.json run node) are gated off for process launches on a Windows core**
  — the launcher is a POSIX `sh` script stopped and hot-reloaded by POSIX signals. The core's
  `gateEntriesForPlatform` marks those entries unsupported with `RUN_WINDOWS_REASON` (browser
  configs and browser-only compounds still run), and the add menu / Dock disable the row (the palette hides it)
  from the core's own platform (`useCoreIsWindows`). A pwsh launcher is the follow-up.
- **Windows terminals run on node-pty's BUNDLED ConPTY when it is installed**
  (`windowsConptySpawnOptions`, `src/core/windows-conpty-dll.ts`, spread into both `pty.spawn`
  sites). Windows 10's inbox ConPTY swallows mouse-tracking and alternate-screen modes, so a
  fullscreen TUI could not be scrolled. The DLL is looked up exactly where node-pty's native loader
  looks (beside the loaded `conpty.node`), restaged after `electron-rebuild` wipes `build/`
  (`scripts/stage-conpty-dll.mjs`), and missing ⇒ the inbox ConPTY. Details + device checklist:
  docs/windows-session-host.md, "Which ConPTY".
- **A WSL terminal is a `wsl:<distro>` value of the machine-local `shell` field**, resolved to argv by
  `core/terminal-profiles.ts` in `spawnNew`, never accepted as argv from a wire payload. Do not use
  `wsl.exe --cd`: it runs the command anyway when the directory is missing. Details:
  docs/windows-session-host.md, "Windows profile resolution".
  **Every menu that starts a terminal offers the distributions, from ONE list**
  (`state/wslTerminals.ts`): the pane menu, sidebar "+", Dock, group frame menu, ⌘K, both kanban boards,
  and both "New terminal here" menus. Canvas publishes one read, so a menu on each of many nodes costs
  no `wsl.exe` launch. The list is empty off a Windows core, so a new surface needs no platform check of
  its own, only `useWslTerminalsFor` / `wslTerminalsForProject`, which also refuse an SSH project and a
  relay tab. `canvas/wsl-terminal-entry-points.source.test.ts` pins the surfaces it names and cannot
  catch a new one. Two starts have no row and use the default shell, which Settings → Shell can make
  WSL: the `node.newTerminal` chord and the `nodeterm://open` sheet. The list is read again on window
  focus (at most once a minute), because the core answers no distributions for a failed `wsl.exe` too,
  so such a read never erases a list that had them (`nextProfiles`). Surfaces: Desktop on Windows; a
  browser on a Windows Server Edition gets the rows from that server's distributions; Mac, Linux and
  relay tabs get none. Mobile: N/A, it attaches to existing sessions.
- **New code is platform-neutral by default.** Do not hardcode POSIX assumptions. Publish files
  through `renameAtomic`/`writeFileAtomic` (`src/core/fs-atomic.ts`), not a bare `fs.rename` — the
  guard test (`fs-atomic.guard.test.ts`) enforces this. Resolve path separators / absolute-path
  checks / file-link dialects against the filesystem-owning core's platform, not the viewer's, and
  never assume `/` or a unix socket. When a test can only run on one platform, gate it with
  `it.skipIf(process.platform === 'win32')` (or the inverse) and say why — never let it fail the
  cross-platform CI. The `windows-latest` CI job runs the platform-dependent suites on real Windows.
- **Line endings are decided by `.gitattributes` (`* text=auto eol=lf`), not by each contributor's
  git config.** Without it `text`/`eol` are unspecified and Git for Windows' default
  `core.autocrlf=true` gives every Windows clone CRLF working files — so a test that reads a
  checked-in file and slices on a `\n`-bearing literal (`CSS.indexOf('}\n}')`,
  `indexOf('\n}\n')`, `indexOf('\n}')`) matched nothing and failed on a checkout with ZERO local
  changes (issue #578). Two suites did; one reported 25 theme tokens missing that were all present,
  which reads like a regression rather than a broken slice. Attributes only apply on re-checkout
  (`git add --renormalize .` for a tree cloned earlier), so the readers ALSO normalize —
  `readFileSync(f, 'utf8').replace(/\r\n/g, '\n')` — and `src/shared/line-endings.guard.test.ts`
  fails on any such read that does not. `*.bat`/`*.cmd`/`*.ps1` are the deliberate exception and
  keep CRLF: cmd.exe is not reliably tolerant of LF, and those are the files a Windows contributor
  runs before anything else works.
- **A WSL project's git runs inside its distribution** (`localGitCommand`, `src/core/wsl-git.ts`, the
  one way a local `git` is spawned). A Windows core reaches such a project through
  `\\wsl.localhost\<distro>\...`, and Git for Windows must not read it. MEASURED (Windows 11, git
  2.49, Ubuntu repo): it refuses the folder ("dubious ownership"), which Source Control used to report
  as "No git repository" with an "Initialize repository" button and no commit graph. With the check
  waived through `safe.directory` it lists every executable as changed (`100755 => 100644`), so
  "stage all" strips exec bits, and `status` takes 3.9 s against 0.35 s. **Do not "fix" this with
  `safe.directory`.** `wsl.exe -d <distro> --exec git -C <linux path>` has none of the three; UNC
  arguments go in as Linux paths and `rev-parse --show-toplevel` / `worktree list` come back as
  `//wsl.localhost/...`. Run under real Windows Node: status, history, stage, a commit message with
  quotes and newlines, worktree add/list. **Not covered:** `gh` (`publish`) and clone still run on
  Windows, and the GitHub credential read in `core/github/credentials.ts` is unchanged.
  **A failed read is not "no repository"**: `GitStatus.readError` (`gitReadFailure`) carries a refused
  folder or a git that could not run (not installed, SSH down), and the panel shows it with Try again,
  never "Initialize repository". Desktop on Windows only; the optional field is inert elsewhere.
- **PATH resolution and direct execution are separate on Windows.** `findInPathString` correctly
  follows `PATHEXT`, which means an npm-installed CLI may resolve to `<name>.cmd`; Node's
  `execFile`/`spawn` still cannot execute that path directly (`spawn EINVAL`). App-owned
  subprocesses must pass their resolved executable and argv through `directExecutableInvocation`
  (`src/core/exec-path.ts`), which invokes `.cmd` through a hidden `cmd.exe` with explicit escaping,
  verbatim arguments and delayed expansion off. Never replace this with `shell:true`: commit prompts
  and other user-controlled arguments would then be reinterpreted as shell syntax. The helper fails
  closed for `.bat`/`.ps1`, CR/LF/NUL inside argv, and command lines above cmd's real 8,191-character
  ceiling. stdin stays a byte stream directly into the shim; routing it through an npm `.ps1` shim's
  `$input | & node` text pipeline corrupts Unicode and line endings under Windows PowerShell 5.1.
  Interactive terminal agent launches keep using `agent-launch.ts`'s separately tested shell plan.

**Direct Windows agent messaging:** `core/native-windows-pane.ts` owns a headless screen for
non-persistent native PTYs. Lookup uses the runtime node index, and the console identity probe
uses `GetConsoleProcessList` plus OS executable paths/birth times. A single process reached
through an unambiguous shell chain is required; detached or ambiguous candidates refuse. This
is not a POSIX foreground-process-group claim. **An interpreter (`node`, `bun`, `python`, …) is
named by its script, never by its own executable**: every npm-installed agent CLI on Windows is
`cmd` → `node <package>\bin\<cli>.js`, and naming that pane `node` made Codex and every npx
custom agent `not-agent`. The probe keeps only the interpreter's FIRST positional argument
(`CommandLineToArgvW`, inside PowerShell; the rest of the command line, prompt text included, never
leaves the probe) and `scriptCommandName` maps it to the key of its package's `bin` map, which is
the table npm generated the `.cmd` shim from, falling back to the script basename exactly as the
POSIX predicate does. The interpreter is the leaf, never a hop, so a CLI's own children (Codex's
native `codex.exe`, MCP servers) cannot make the pane ambiguous.
**A RELEASED session is still a messaging target.** Park expiry and the offscreen release drop the
`Session`, but the host keeps it running, so `targetLive` asks `PtyManager.sessionExists` (attached,
else tmux, else the host, with a failed read answering "exists") and the owner/paste/envelope probes
route through `sessionHostOwns`, which falls back to the release record. Asking only for an attached
client answered `targetGone`, terminal and never queued, about a live agent in another project. The project/verified-hook/idle/receipt gates still
apply, paste mode must be observed, and the exact generation/process is checked before writing.
`PtyManager.sendText` (the confirmed `write` verb, rename, note push, dictation) also routes a
direct native PTY through `NativeWindowsPane.sendText` — framed only when paste mode was requested,
no process attestation. It used to fall through to the session-host backend, which has no entry for
a direct PTY, so every `write` to such a pane failed.
Do not route the persistent session-host backend through this direct-PTY adapter. Its independently
versioned `messageOwnerV1` / `messagePasteReadyV1` / `messageEnvelopeV1` extension runs in the host:
the OS probe is bound to `HostSession.generation`, the session registry is rechecked after every
await, and the emulator's paste mode is checked again immediately before the synchronous write.
**The Enter is a SECOND write, sent only once the pane shows the envelope** — every backend
(Server Edition tmux, session host, direct PTY) runs the one `core/settled-submit.ts`. Measured on
the installed build (2026-09-14): with the `\r` in the same write as the paste, Codex rendered the
whole envelope in its composer and never submitted it, so the delivery reported `stalled`; a
separate Enter moments later sent it. A pane that never shows the envelope gets no Enter at all.
**Both Windows owner reads get a longer budget than the 2 s `PANE_PROBE_TIMEOUT_MS`.** The session
host's `messageOwnerV1` and `NativeWindowsPane.owner()` run the same PowerShell console/CIM probe
(`readWindowsConsoleOwner`), measured at ~2.4 s one-shot on a loaded Windows 11 machine — so under
the 2 s bound every Windows target read `unknown` and refused as `targetPaneUnreadable`, behind an
error that invites a retry (#1211). The #1206 probe worker is fast only once WARM and exits after
60 s idle, so a message sent minutes after the last meets its 6 s first-request deadline plus the 4 s
one-shot fallback. `PtyManager.paneProbeTimeoutMs` answers `WINDOWS_PANE_PROBE_TIMEOUT_MS` — DERIVED
from those two deadlines + 1 s (`session-host/windows-probe-budget.ts`; never a literal) — for exactly the backends
`paneOwner` routes to that probe, and both shells forward it as the optional
`AgentMessagingDeps.paneProbeTimeoutMs` through ONE helper, `ptyPaneProbeDeps`, which binds the read
and its budget together (an optional dep that is not forwarded fails silently). SSH and tmux keep 2 s: that bound exists because
a lapsed ssh probe leaves a child alive that can turn into a full login against a dead master, a
hazard a local `powershell.exe` does not have. The verdict rules are unchanged; only the deadline
moves.
An older live host refuses these unknown commands while keeping the v1/v2 terminal contract intact;
never replace it automatically or fall back to name-only input to enable messaging. Windows OpenCode
context exports go through `directExecutableInvocation` like every other app-owned subprocess (see
Platform support), never a bare `execFile('opencode')`, which cannot execute the npm shim.

Windows messaging final-submit checks cross a second OS identity probe and emulator barrier:
`NativeWindowsPane.sendEnvelope` and `hostMessagePane.send` retain accepted-paste semantics when
the child has changed or paste mode is off, but withhold Enter. The root PTY can outlive the CLI.
`SessionHostClient.sendKeys` tracks whether its V2 frame was handed to the socket separately
from an explicit negative host reply; loss of the reply after transmission returns conservative
partial/unknown delivery, with no resend. The SessionStart idle rescue latch stores its session,
agent and receive time; foreign/missing idle identity never creates proof or changes the
renderer-visible session. These boundaries have behavioral regressions in
`core/windows-delivery-safety.test.ts` and the mirror/client suites.
