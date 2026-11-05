# Atomic writes and test isolation

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Atomic writes (never a bare `fs.rename`)

Every store persists temp-file-then-rename. That is correct on POSIX and **silently lossy on
Windows**: `MoveFileEx` fails with `EPERM` whenever the destination is open by anyone at that
instant, and what opens a file you just wrote is Defender's real-time scanner, the search indexer,
OneDrive over a synced profile, or two of our own concurrent writers racing one destination. The
save throws and the data is gone — intermittently, unreproducibly, and **more often on the machines
that are best protected**.

`renameAtomic` / `writeFileAtomic` (`src/core/fs-atomic.ts`) retry briefly. Each attempt is still
one indivisible rename, so a retry cannot tear a write. They deliberately do NOT retry forever
(several callers report a failed save as `persisted:false`, and that contract outranks a save that
eventually lands), do not retry `ENOENT`/`ENOSPC`, do not branch on platform (or the behaviour under
test on a Mac is not the behaviour shipped to Windows), and never swallow the final error.

**Nothing in the toolchain catches the bare version.** 28 files had it, across three spellings — the user's canvas, their
settings, their sealed credentials, their pinned devices — and every one of them reads as a correct
atomic write, because on the platform most of this was written on it is one. The only signal in a
6,000-test suite was one store's overlapping-saves test, red on Windows for that store's whole life.
So it is enforced by scan: `src/core/fs-atomic.guard.test.ts` fails on any bare `fs.rename` outside
the helper. Full write-up, including the separate shared-temp-name bug at the same sites:
**`docs/atomic-writes.md`**.

SSH/scp staging follows the same ownership rule outside direct `fs` calls. Atomic remote stdin
writes use `src/main/remote-atomic-write.ts`: a bounded `.nodeterm-<uuid>.tmp` leaf is placed beside
the target BEFORE both complete paths are quoted, then the shell preserves the write/move status
while cleaning that exact temp. The temp leaf must stay independent of the target leaf — appending
`.uuid.tmp` to a valid `NAME_MAX` target makes the write impossible.

**A remote write is only complete if the host checked the byte count, and a rename alone does not
check it.** `cat` cannot tell "the body ended" from "the ssh channel ended": when the channel dies
before the body arrives (the ControlMaster killed or rebuilt on a reconnect, the runner's 15 s
timeout SIGTERMing the child, a dropped link) it reads EOF and EXITS 0. Measured against OpenSSH 9.6
with the master SIGKILLed and with the child SIGTERMed, both before the body: a bare
`cat > f && chmod 755 f` left `f` at 0 bytes and flipped 644 → 755, and the temp + `mv` shape
published the empty temp over a good file just the same. That is how, on 2026-09-28, a host's
`~/.nodeterm/nodeterm.sh` and `context.sh` were 0 bytes after a reconnect and every agent's canvas
call exited 0 with no output. So `remoteAtomicWrite(path, body, options)` takes the BODY, checks
`[ "$(wc -c < temp)" -eq <utf-8 bytes> ]` before the rename (a short temp exits
`REMOTE_WRITE_SHORT_BODY` = 65 with the target untouched), returns the `stdin` it was built for,
and refuses an empty body unless `allowEmpty` (only the generic `ssh-fs` write passes it — an editor
may save an empty file; nothing we GENERATE is ever empty). `runRemoteAtomicWrite` also THROWS on a
non-zero exit: the runners resolve on failure, and awaiting them and moving on is what made the
failure silent. Every remote write goes through it — filesystem API writes, tmux.conf, the hook
endpoint, node tokens, agent status, pending answers, session env files, the Codex relay and
launcher, every agent hook script, the canvas/context shims and skills, and our own grok/copilot
hook configs. The USER's files — Claude/Gemini `settings.json`, codex `hooks.json` and
`config.toml`, and the AGENTS.md / GEMINI.md / copilot-instructions.md instruction blocks — go
through `updateRemoteTextFile` / `updateRemoteSettingsFile` (`core/agents/hooks/remote-settings-file.ts`)
instead: the same byte check plus our lock, symlink resolution (a dotfile link stays a link),
mode preservation, and a compare-before-publish; a read that fails is never treated as an empty
file (the old `cat f || true` then `cat > f` replaced an unreadable AGENTS.md with our block alone).
The local installers for the same files use `writeManagedHookFileAtomic` / `mergeInstructionFile`.
`src/main/remote-ssh/remote-write.guard.test.ts` fails on any new bare `cat > <file>` in
src/{core,main,server}, and `remote-write-truncation.test.ts` runs every installer under a real
`/bin/sh` with the body cut off.
**Never `chmod <mode> -- <file>` in a remote command.** BSD/macOS chmod does not permute: its
getopt stops at the MODE operand, so the `--` after it is a FILE named `--` ("No such file or
directory", exit 1) and the `&&` chain never publishes. `mkdir -p --`, `mv -f --` and `rm -f --` are
fine (their `--` comes before any operand). That spelling shipped from v0.3.3 (fbc65ad8) for the
hook endpoint and node tokens, so `setup()` returned null on every macOS SSH host — no status
hooks, canvas control or context link there. The real-shell tests put a non-permuting chmod
(`POSIXLY_CORRECT=1` GNU chmod) first on PATH for every mode-bearing caller.
**Canvas control and context link install as ONE chain** (`RemoteHooks.installAgentTools`): they
merge different blocks into the same AGENTS.md / GEMINI.md, and the transaction lets only one of two
racing writers publish a snapshot — fired side by side they lost 16–19 of 48 blocks over 8 fresh
hosts. Upload directories use UUIDs across app
processes. Downloads and media-cache copies use hidden UUID `.part` names; user-visible downloads
also hold an exclusive candidate lock until the rename and cleanup finish. Never simplify any of
those back to `<target>.tmp` / `<target>.part` or a read-only "does the destination exist?" check —
the overlap tests exercise the resulting race.

## The test suite never touches a live tmux server

This repo is developed from inside nodeterm, so `tmux -L node-terminal` and `-L nodeterm-rmt` are
not fixture names on a contributor's machine — they are the servers holding every terminal they have
open. A test that binds one shares a process with the user's whole canvas, and the failure mode is
not a red test: it is every pane printing `[server exited unexpectedly]` (issue #629).

**Every vitest run gets a private `TMUX_TMPDIR`.** tmux resolves `-L <socket>` to
`$TMUX_TMPDIR/tmux-<uid>/<socket>` and falls back to `/tmp` when the variable is unset, so
re-pointing the variable re-points every socket name at once — including the real ones, including
in a suite nobody thought about. `test/setup/tmux-sandbox.ts` (`globalSetup`) creates the directory,
kills whatever is still bound inside it and removes it; `test/setup/tmux-worker-env.ts`
(`setupFiles`) re-asserts it inside each worker and **refuses to run** if it is missing, because
vitest's env inheritance into workers is an implementation detail and a silent fallback would put
every test back on the live server. `enterSandbox` also strips `TMUX`/`TMUX_PANE` — a suite run from
inside a nodeterm terminal inherits a live client's, and production strips both for the same reason.

Two suites deliberately name a real socket, and both are allowlisted with their reason in
`src/core/tmux-socket-isolation.guard.test.ts`: `agents/pane-owner.test.ts` (the production bytes
hardcode `-L nodeterm-rmt`; re-spelling it would judge different bytes) and
`main/remote/host-destroy-tmux.test.ts` (`PtyManager` binds `TMUX_SOCKET` itself). The latter was
the one file that reached the live server by construction — measured, not inferred — and it now
refuses to start unless the sandbox is in effect.

**What the sandbox does NOT do:** two suites naming the same socket inside it still share one tmux
server, so a `kill-server` there is still a shared-server kill — it has just been moved somewhere
harmless. Measured on CI the day this landed: the guard test's own `kill-server` on
`node-terminal` ended `host-destroy-tmux.test.ts`'s session mid-assertion. A suite kills its OWN
sessions by exact target (`-t =<name>`, since a miss falls through to prefix matching), or it owns
a socket name nothing else uses.

The guard has three legs on purpose, and the weakest one is the scan: a test can still escape by
handing a real tmux an `env` object it built from scratch with no `TMUX_TMPDIR` in it, which no
regex sees. So the structural leg is the sandbox, the behavioural leg actually **starts a server on
the real socket name and proves the socket file landed inside the sandbox** (asserting the env var
would only prove we set a variable — the resolution rule is a property of tmux), and the scan exists
to make a third allowlist entry a decision somebody signs for. Same shape as the `fs.rename` guard,
for the same reason: nobody reading one file can see this.

**What this does not claim.** #629's server death was not traced to a test — the reporter's evidence
points at tmux's `server_accept()` calling `fatal()` under the suite's process/fd burst on a
memory-starved machine, and two identical runs finished clean. Sharing a server with the user's live
sessions is a hazard whatever kills it; this removes the hazard, not a proven cause.

**`fakePlatform()`'s directories live exactly as long as the run** (`test/setup/fake-platform-root.ts`,
the same per-RUN `globalSetup` shape as the tmux sandbox). Each call used to `mkdtemp` in the system
temp dir at construction and nothing removed it: a development server running the suite repeatedly
collected ~395,000 `nodeterm-fake-*` directories, `/tmp` ran out of inodes while still showing GBs
free, and full runs failed in 1,201 of 1,207 files with ENOSPC. Measured on 40 suites that use it:
271 directories left behind before, 0 after. Two halves, both needed: the directory is made on first
READ of `userDataDir` (a test that passes its own, or never reads it, makes none), and it is made
under a run root that teardown removes once every test file has finished (vitest tears global setup
down BEFORE it waits for its workers to exit, so a late timer is not ruled out — a per-file
`afterAll` would be strictly worse, sweeping while that file's debounced writes are still due). The
teardown never throws and is listed first so it runs last: vitest's teardown loop has no catch per
file, and a throw there would silently skip the tmux sandbox's teardown. The leaf under the root is a
bare `u-`, because every byte added is closer to the macOS unix-socket path budget
(`hook-sock-path.ts`) for anything a test binds under `userDataDir`. A run killed before teardown
leaves ONE directory. A test that builds its own `CorePlatform` takes its `userDataDir` from
`makeFakeUserDataDir()` (same root, removed with it) — never a bare `mkdtemp` in the system temp
dir and never a fixed `/tmp/...` literal.
`platform-fake.test.ts` fails if the root is not in effect, so dropping the `globalSetup` entry is loud.

## The test suite leaves nothing in the OS temp dir

Measured 2026-09-29 on a shared dev box: `/tmp` held ~41k top-level entries, and one full run of this
suite added ~1,560 of them (`nodeterm-fake-*` alone was 1,412 — see the `fakePlatform()` paragraph
above for that half). The filesystem ran out of INODES and every session's builds and tests broke.
For every OTHER test dir, two layers, both needed:

- **Every test dir is removed where it is made.** `testTmpDir(prefix)` (`src/core/test-tmp.ts`) is
  a tracked `mkdtemp` whose removal is an `afterAll` in the setup file `test/setup/tmp-worker-env.ts`
  — a setup file's hooks sit on the file's root suite and, with vitest's default stacked hook order,
  run AFTER the file's own `afterAll` hooks, i.e. after the suite stopped whatever was writing there.
- **The run is sandboxed and FAILS on a leak.** `test/setup/tmp-sandbox.ts` (`globalSetup`, listed
  AFTER the tmux sandbox so that one keeps its short base path) points `TMPDIR` (and `TEMP`/`TMP` on
  Windows) at one private directory; teardown lists what is left, removes the sandbox anyway, and
  sets `process.exitCode = 1` naming each prefix. **Not `throw`**: vitest only LOGS a teardown error
  (`error during close`) and still exits 0, and a throw skips the other globalSetup teardowns — the
  tmux sandbox's, measured. Windows warns instead of failing (a just-exited child's file can be
  EBUSY for a moment after a correct cleanup). `NODETERM_TEST_KEEP_TMP=1` keeps it for inspection.
  `FOREIGN_TMP_ENTRIES` is the short allowlist of names nothing in this repo creates (Chrome's own
  scratch files from the headless layout tests), each with its reason.
- **Two leaks were production memos, not test bugs**: `contextLinkDir()` and
  `HookServer.endpointFilePath()` cached the FIRST platform's `userDataDir` for the life of the
  process, so a process that booted a second core (the server e2e suites) wrote `context.sh` and
  `hook-endpoint.env` into the first core's already-removed directory. `initContextLink` and
  `hookServer.stop()` now drop the memo. Found with `strace -f -e trace=mkdir,rename` — an EMPTY
  leftover dir is the signature of a late writer, not of a missing `rm`.

## The test suite never touches the real home

The hook installers write the user's real agent config — `~/.codex/hooks.json` plus the
`[hooks.state."…"]` trust blocks in `~/.codex/config.toml`, `~/.claude/settings.json`,
`~/.gemini/settings.json`, grok's and copilot's hook files — and they resolve home through
`import { homedir } from 'os'`. **A `vi.spyOn(os, 'homedir')` does not reach that binding**:
measured on a Windows dev box, running `src/core/agents/hooks/index.test.ts` alone (which
"isolated" home with exactly that spy) rewrote the developer's real `~/.codex/config.toml` and
`hooks.json`. Runs from several worktrees then raced each other, and the user's own Codex, on those
files; a Codex session started inside that window had no trust entries for nodeterm's hooks, so its
hooks never fired and every agent message to it expired as `targetStatusStale`.

- **Every run gets a private home** (`test/setup/home-sandbox.ts` + `home-worker-env.ts`,
  `src/core/test-home.ts`): HOME and USERPROFILE point at one directory created and removed by
  `globalSetup`, re-asserted per worker (refusing to run without it), and the agents' relocation
  variables (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `COPILOT_HOME`, `GEMINI_CLI_HOME`,
  `KIMI_CODE_HOME`, `XDG_*`) are cleared. On Windows APPDATA/LOCALAPPDATA move inside it too.
  `os.homedir()` reads the variable on every call, so every installer and every child process lands
  in the sandbox whatever its import style. Registered BEFORE the temp sandbox (it lives in the real
  temp dir and is never counted as a leak there).
- A test that needs its own home uses a MODULE mock (`vi.mock('os', …)` returning `homedir`, as
  `install-helper.fs.test.ts` and `codex.ensure.test.ts` do), never the spy.
- `src/core/test-home.guard.test.ts` runs the real `installCodexHooks()` and proves it wrote the
  sandbox while the real `~/.codex` (read from `os.userInfo().homedir`, which ignores HOME) kept its
  size and mtime.
