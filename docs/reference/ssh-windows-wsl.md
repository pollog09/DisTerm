# SSH on Windows and WSL

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## SSH projects on Windows: the in-process transport

Windows' own OpenSSH cannot multiplex, and that is measured, not assumed (windows-latest,
`OpenSSH_for_Windows_9.5p2`): `ssh -M` fails with `getsockname failed: Not a socket`, and a child
carrying `ControlPath` FAILS rather than falling back — so every remote command, terminal and
tunnel of an SSH project failed on a stock Windows machine. Git for Windows' ssh (10.5p1) starts a
master but every session over it is reset and falls back to a full login per command. So on
Windows the app does not run the ssh binary for SSH projects at all: `src/core/remote-ssh/native/`
holds ONE `ssh2` connection per ControlPath and carries every exec, pty, SFTP session, reverse
unix-socket forward and dev-server `-L` forward over it. POSIX keeps OpenSSH untouched.

- **One switch:** `useNativeSsh()` — always on win32; `NODETERM_NATIVE_SSH=1` turns it on anywhere
  (how it is tested live from macOS against a real host), `=0` forces it off. Decided once per app
  run for the SshProjectManager runners.
- **Call sites do not change.** They keep building OpenSSH argv (`control-master.ts`);
  `ssh-argv.ts` is a STRICT parser that reads it back and refuses (by name) any option it does not
  know. A builder that grows a flag must teach the parser, or the native path fails loudly —
  `ssh-argv.test.ts` parses every builder's output.
- **Seams wired:** SshProjectManager's runners (`initSshProject`), pty-manager's
  `runAsync`/`runWithStdin` and the remote terminal itself (`NativeSshPty`, a pty channel shaped
  like `IPty`), remote-git, the setup runner (`spawnSshArgvStream`), the workspace poll's
  master check. A new ssh call site owes the same routing.
- **Semantics are OpenSSH's:** ControlMaster auto/no, `-O check|exit|forward|cancel`,
  `StrictHostKeyChecking=accept-new` over the user's own known_hosts (hashed entries included —
  that is why HMAC-SHA1 appears; CodeQL's alert on it is dismissed with the reason) — with the
  recorded host key TYPE pinned: the types on record lead ssh2's `algorithms.serverHostKey`
  (OpenSSH's order_hostkeyalgs, `hostKeyAlgorithmsFor`), and a host that HAS a recorded key but
  presents another type is refused like a changed key, naming both types and `ssh-keygen -R`
  (stricter than OpenSSH's accept-new, which records the new type; type-blind, a MITM holding only
  an ed25519 key against a host recorded under ECDSA was silently recorded and trusted). The
  list handed to ssh2 is always a reordering of `SSH2_DEFAULT_SERVER_HOST_KEY`, pinned to the
  package by test, because an exact list naming anything ssh2 lacks makes `connect()` throw; publickey
  only (agent, then key files, passphrase through the existing dialog, never in BatchMode), the
  user's `~/.ssh/config` via `ssh -G` (never a second parser of it), a dropped connection ends
  every channel with 255 (what `SshReconnector` reads).
- **Channels past the server's MaxSessions spill onto more connections** (10 on a stock sshd; a
  live 89-terminal project left 25 terminals blank before this). A refusal marks that connection
  full until one of its channels closes; overflow connections are bounded
  (`MAX_OVERFLOW_CONNECTIONS`) and live and die with the primary. A key unlocked with a passphrase
  is held in memory while any connection is alive so overflow connections do not prompt again —
  the Windows tradeoff for having no app-private ssh-agent.
- **Channel races — keep these, each was a real bug:** open-confirmation, exit-status and close can
  arrive in ONE read, so the exit status is recorded inside ssh2's callback (`recordExit`) and exec
  consumers attach there too (`openOn`'s `onOpen`); late consumers check `channelExit(ch).closed`.
  A killed streaming child must never write to its ended pipes (an uncaught
  `ERR_STREAM_WRITE_AFTER_END` in main). A stream nobody reads never emits `close` — tests must
  `resume()` the channels they hold.
- **ssh2 is loaded on first use, never at module scope** (`ssh2()` in `native-mux.ts`; every other
  shipped import of it is `import type`). native-runtime → native-mux is on main's module-scope
  graph, which runs before Chromium's `ready`; a top-level import cost every launch 14–25 ms warm
  (~680 ms in one cold-cache sample) on machines that never open an SSH project.
  Pinned by `native-mux.lazy.test.ts` (import does not evaluate ssh2) and
  `src/main/lazy-deps.source.test.ts` (no shipped value import).
- **Tests run on every OS** against ssh2's own in-process `Server` (loopback, no sshd); the
  directory is in the `windows-latest` CI job. Live numbers (macOS, `NODETERM_NATIVE_SSH=1`,
  89-terminal project): 89/89 attached, 0 ssh processes, ~1 login per connect, main CPU 3–5% idle.
- **ProxyJump** (#1078) follows OpenSSH: each hop is resolved by ITS OWN `ssh -G` and gets its own
  host-key check and publickey auth; the chain is ssh2 `forwardOut` streams used as the next hop's
  socket. `ssh -J a,b t` means `ssh -J a -W t b`, so only the FIRST hop's own ProxyJump is followed
  (recursively); loops and chains deeper than 8 are refused by name. Jump connections belong to
  the target connection and die with it (a dropped jump → 255 on the target's channels). MaxSessions
  overflow connections REUSE the primary's chain (one bastion login; direct-tcpip does not count
  against the bastion's MaxSessions); one-off connections build their own. Known hosts are checked
  under `HostName` (or `HostKeyAlias`), as OpenSSH does — not under the alias as typed.
  **ProxyCommand** (`proxy-command.ts`) runs on the target or the FIRST hop, as OpenSSH does:
  `%h %p %r %n %k %%` expanded (an unknown `%x` is an error by name), POSIX `sh -c 'exec …'`,
  Windows `cmd.exe /d /s /c`, the child's stdio is the socket, its stderr is in the connect error,
  ConnectTimeout covers the wait for its first byte, and it is killed with the connection (on
  Windows as a TREE, `taskkill /t /f` — the proxy is cmd.exe's child, and killing cmd.exe alone
  orphans it). Every substituted VALUE (`%h %r %n %k`) is refused if it carries a shell/cmd
  metacharacter or a leading `-`: the line goes to `sh -c` / `cmd.exe /c`, and Windows' OpenSSH
  (9.5) predates the CVE-2023-51385 host/user check.
  `ProxyUseFdpass yes` is refused by name. ProxyJump wins when `ssh -G` prints both.
- **Other honored `~/.ssh/config` options:** `ForwardAgent` (yes / path / `$VAR`) — requested on
  the TARGET connection's PTY channels only, never on a hop or a background exec/SFTP channel, and
  a server that refuses it costs one log line, not the terminal. Note what that does NOT buy: sshd
  creates the agent socket once per CONNECTION, so after the first terminal asks, later sessions on
  that shared connection (background execs included) also see `SSH_AUTH_SOCK` — exactly what an
  OpenSSH ControlMaster does. Do not document it as "background calls never get the agent". Options it does NOT honor (`certificatefile`, config `Local/Remote/DynamicForward`)
  are named in ONE warning per connection (`UNSUPPORTED_OPTIONS`), never silently dropped; user and
  `@cert-authority` certificates are a later phase.
- **`-L` dev-server forwards** (`NativeMux.forwardLocal`): the parser accepts ONLY the loopback spec
  `localFwdSpec` emits; a duplicate spec is re-acknowledged (the port registry's `maybe-ours`
  adoption depends on it), a busy port is OpenSSH's "Port forwarding failed", and listeners close
  on `-O cancel`, `-O exit`, `exitAll` and a dropped connection.
- **No ssh.exe needed.** `resolveSshProgram()` (native-runtime.ts) is the one ssh lookup: the
  binary (Windows adds `System32\OpenSSH\ssh.exe`), else — under the native transport only — the
  bare `ssh` sentinel every runner routes to NativeMux. `findSshBinary()` is for the two callers
  that exec `ssh -G` themselves. Without a binary, `ssh -G` falls back to OpenSSH's no-config
  defaults (`defaultHostFromQuery`) and logs once per host that `~/.ssh/config` was not read.
- **Agents on Windows:** the default is the OpenSSH agent service's pipe, else the user's
  Pageant / KeeAgent pipe (`pageant.<user>.<hash>`, PuTTY ≥ 0.75); `IdentityAgent pageant` maps to
  that pipe — NEVER to ssh2's `'pageant'` string, which spawns a 32-bit `pagent.exe` we would have
  to ship and sign (`windows-agent-discovery.ts`).
- **Recursive downloads** rename children Windows cannot create (`a:b`, `CON`, trailing dots, and
  case-only collisions) per directory with `localChildName` / `uniqueChildName`
  (download-name.ts — the ONE rule, also used for the top-level name) and log how many changed.
- **The Windows ssh-agent only on the user's say-so** (#1080). MEASURED on windows-latest
  (OpenSSH_for_Windows_9.5p2): the agent service REFUSES any lifetime or confirm constraint
  (`ssh-add -t` / `-c` and our `ADD_ID_CONSTRAINED` alike), and an unconstrained key is stored in
  `HKCU\Software\OpenSSH\Agent\Keys` (DPAPI) and survives service restarts — "until removed" is
  the only add Windows offers. So a passphrase-unlocked key is added (`agent-add.ts`, our own
  agent-protocol writer; ssh2 only lists and signs) ONLY when the host's own config says
  `AddKeysToAgent yes` (what Windows' ssh.exe would do) or the user turned on Settings → Remote
  (SSH) → "Keep unlocked keys in the Windows ssh-agent" (`settings.windowsSshAgentAddKeys`, default
  OFF, copy says Windows keeps it until `ssh-add -d`). A config lifetime is sent as a constraint and
  Windows' refusal stands: a refused constrained add is NEVER retried unconstrained. Fail-open: an
  agent error never affects the connection. Reboot persistence is inferred from the registry hive,
  not measured.
- **A proxy's EOF closes the socket** (`allowHalfOpen: false` in `proxy-command.ts`). ssh2 marks a
  connection dead on the socket's `close`, so a half-open stream left a dead proxy looking alive:
  `-O check` answered 0 and nothing reconnected (measured, no status event in 70 s; ~1.1 s now).
- **Not done yet:** sleep/wake verification on the native transport, a like-for-like timing against
  OpenSSH on the same project, and any run on a real Windows desktop (all evidence so far is CI plus
  the macOS run of the same code path).

### Claude hooks in a plain WSL terminal (`core/wsl-hooks.ts`)

A `wsl:<distro>` pane reports Claude's status, so its badges, unread dot, agent graph box and subagents
work with no sshd. Three things stood in the way, each MEASURED from Ubuntu on Windows 11 (NAT mode):
the hook server is on Windows loopback (`127.0.0.1` from WSL refuses, the gateway address times out),
the pane's env stops at `wsl.exe`, and Claude reads the distro's `~/.claude`, not the Windows one.
- **Transport:** Windows' `curl.exe` through WSL interop reaches loopback (~20 ms a call, a UNC payload
  path readable, `--config -` on stdin intact, so the bearer stays off argv). `WSL_INTEROP_CURL_SH`
  shadows `curl` with a function and rewrites `/dev/null` and the `payload@` path. It is in the one
  script generator, because a WSL project on the same distro writes that same file. Claude's script
  only; inert without `NODETERM_WSL_CURL`, and that value must end in `/curl.exe`.
- **Env:** `wslHookEnv` lists exact names in WSLENV (only listed names cross, they survive the login
  shell, `/p` converts). **Never forward `NODETERM_PERM_WAIT_SECS`:** core writes approval answers on
  Windows and the script polls the distro's own `~/.nodeterm`, so a hold could only time out. A held
  prompt there is answered in the terminal.
- **Install:** on a new terminal, under the machine's Claude consent (enabled installs, declined
  removes, unanswered touches nothing, not even a read). It needs `~/.claude` to exist, so a distro that
  never ran Claude gets no config dir. It waits at most 4 s, then the terminal opens anyway, and it is
  never a spawn failure. A declined machine's distro is cleaned when its next WSL terminal opens.
- **The pane-origin gate lets these events through:** a session-host pane's tty is
  `win32-console:<pid>`, which `normalizeTty` refuses, so the pane reads as unknown and a WSL claude's
  `pts/N` is never compared with it (pinned in `claude-pane-origin.test.ts`). A backgrounded claude
  (`foreground: false`) is still foreign.
- **Limits:** Claude only. A pane opened before this build, or attached warm, has no env: it needs a new
  session. Interop off or `/mnt/c` unmounted fails open (no status). `CLAUDE_CONFIG_DIR` set inside the
  distro is not honoured by the install. Transcript paths are Linux paths, so the local jail refuses them:
  no context meter, ⌘M chat or live subagent activity. Subagent CARDS come from hooks and do work.
- **NOT measured:** the whole path in a packaged Windows app. The install commands went through real
  `wsl.exe` under interop, where argv quoting differs from Windows `node.exe`; the real script reached the
  real hook server through real `curl.exe` only as far as its 403, since no real credential was used.

### Claude in a WSL pane: its usage, its launch, what it cannot do

A project can sit in a distribution with no sshd: a `\\wsl.localhost\Ubuntu\...` folder and `wsl:` panes. Its
Claude's login is the distro's `~/.claude`, and the Windows one is a different, usually stale file (on the
machine that prompted this, expired for months, with no `claude` on Windows at all). The app read only
the Windows one, got nothing, and the pill vanished.
- **Which shell a pane has, in one order:** the node's own, then the project's `terminal.shell` (a shared value
  only once this machine trusts it, `trustedProjectShell`), then the default. `paneRunsInWsl` and
  `wslShellForNewAgent` read it the way the spawn does, and neither ever reads this machine's settings for an SSH
  or relay node. A node with no shell of its own is read from today's settings, which can differ from what its
  live pane was spawned with; nodes this app creates in a distribution are stamped, so that takes a setting
  changed under an older node.
- **Usage scope (`projectWslShell`, `renderer/lib/usageScope.ts`):** the project's own shell says first, either way.
  Next a managed default account keeps the project on this machine, but only when the default shell is not WSL,
  since those dirs are Windows-side and a WSL pane would not use them. Then the folder's distro, a Claude node
  stamped with a `wsl:` shell, and the default shell. **This key is the pill's alone** (`usagePillScopeKey`):
  `usageScopeKey` also scopes session memory, which would read `wsl:Ubuntu` as an SSH host. Only Claude's rows are
  replaced; the other providers' logins are this machine's. The row answers to the Claude switch in Settings → Usage.
- **The read (`core/usage/wsl-usage.ts`):** the SSH command run through `wsl.exe -d <distro> --exec sh -c`, so the
  token stays in the distro. Both shells get it from `usage-service`. **It never boots one**: `--list --running`
  first, with a hard timeout (`wslProfileExec`), and a stopped distro keeps its last numbers. While a distro has
  given no row it is usually still booting, so the pill retries every 5 s for 2 minutes; after that a focused
  window re-asks every 15 min and on focus. Claude only: Codex keeps its Windows row, because a distro read needs
  Node in there and failing would warn everyone who does not use Codex.
- **Login expired:** HTTP 401 with a token present sets `loginExpired` beside status `unavailable`, and the pill says
  so instead of hiding. The CLI renews its own token and we never do, so an idle one reads this way until Claude
  runs. 403 stays hidden. **NOT measured:** that this endpoint answers 401 for an expired token.
- **"New Claude: WSL: <distro>"** (canvas menus, Dock, ⌘K, both boards), from the same list as the terminal rows. A
  plain New Claude whose project or default shell is `wsl:` lands in the same place: the node is stamped, so a later
  settings change cannot move it from the CLI its line was built for. Builtin Claude only. Before the line is built
  it asks THAT CLI (`claude-cli.ts` `wslClaudeCliCaps`, one probe at a time per distro, bounded at 5 s, falling
  through to `sh` for a login shell that cannot read the body): the Windows probe knows nothing about it, and with no
  Windows Claude it mints no session id and drops `auto`. A plain New Claude cannot wait, so the default shell's
  distro is asked at startup if it is already running. No gateway model and no account: neither's env crosses
  `wsl.exe` (WSLENV is an allowlist). Picking a managed account for a pane that would land in WSL is refused by name
  (`WSL_ACCOUNT_REFUSED`); a project's default account simply does not apply there. Not on "Start with agent": a long
  prompt spills to a Windows file the distro's shell cannot read.
- **What a pane in a distribution cannot do.** The pane probes see `wsl.exe` whatever runs inside, so Restart, Pause,
  Restart on subscription and Switch account are disabled with the reason (they poll for a shell taking back over,
  so the CLI would quit and nothing would resume it), and the session memory panel offers no Pause. Its transcript is
  on the far side of `wsl.exe`, so a cold restore skips the local check, whose `absent` would drop a live resume, and
  trusts the CLI's own "no conversation" line. ⌘M shows the output view. The meter's rehydration and the find bar's
  transcript search are off too: Claude's resolver would miss the id and answer with the newest local transcript
  for that folder, another conversation's. Canvas control and agent messaging are also unavailable there.
- **Surfaces.** Desktop on Windows is the case this is for. A Server Edition on Windows gets the same rows and reads
  from its own distributions, through the real bridge legs; never run. Relay tabs get no rows, and the channel is
  host-only. Mac and Linux list no distributions, so there is nothing to offer. Mobile: N/A.
- **Measured** (Windows node v26 through real `wsl.exe`, Ubuntu, Claude 2.1.318, code bundled from these modules):
  running list 38-83 ms, caps probe 244 ms, usage read 867 ms returning real limits, a nonexistent distro reads as
  not running. **NOT measured:** a packaged app: the rows, the typed line, a cold restore after a reboot, or a cold
  boot's wait. A fish login shell is covered only by a stand-in that fails the way fish is expected to.

### WSL projects: a distribution as an SSH project

A WSL project is an SSH project whose host is a distribution on this machine, so agents in WSL get
everything SSH projects have: status, hooks, messaging, subagent cards, tmux persistence. A WSL
terminal profile (`wsl:<distro>`) is a shell plus Claude status hooks (`core/wsl-hooks.ts`, below). It
has no messaging, canvas control, tmux persistence or transcript reads, because pane probes see
`wsl.exe` and the transcript is on the other side of the boundary.

- **Transport:** `wsl.exe -d <distro> --exec sh -c <launch>` runs an unprivileged `sshd -i` on the
  child's stdio, and the native transport speaks SSH over it. No port is opened and no root is needed.
  `core/remote-ssh/native/wsl-endpoint.ts` owns all of it; every call site is the ordinary SSH path.
- **The host name is only a handle:** `<slug>-<random hex>.wsl.nodeterm.invalid`. A project file, relay
  peer or canvas frame can carry that name, so the name selects nothing. The distro, keys and pin are
  read from `~/.nodeterm/wsl-projects/<handle>/`, which only this module writes, and `conn.wslDistro` is
  for display.
- **`ResolvedHost.trustedTransport` is the one way in.** `parseSshG` never sets it. It replaces
  ProxyCommand, ProxyJump and known_hosts, and `NativeMux.connect` drops the argv's identity and agent
  when it is present.
- **Two gates, both needed:** `authorize` (run by `connectOnce` before anything starts) refuses a
  project id the user did not create on this endpoint. The id list is written only by
  `wsl-project:bind`, a host-only channel called from the create step. `resolve` then refuses a
  ControlPath `authorize` did not pass, which also covers a spawn naming the route directly and a
  ProxyJump hop. An editor's `pty:create` has `sshRemote` removed for a WSL host in any spelling
  (`access-policy.ts`); a peer attaches through the host's own connection instead.
- **The gates do not cover a live connection, so the transport does.** NativeMux picks a connection by
  ControlPath alone, and neither gate runs once it is up. So on a trusted connection any request whose
  target host differs is refused (`NativeMux.refusal`): exec, pty, SFTP and every `-O` op. A WSL name
  never rides an ordinary connection either. `isWslHost` is case-insensitive for the same reason.
- **An argv, never a command line.** `trustedProxySocket` skips the `cmd.exe /c` route on purpose:
  cmd.exe expands `%VAR%` in a command line and that cannot be escaped there. A distro name is one argv
  element, so spaces and metacharacters need no quoting. It is validated as `wsl:` profiles are, must
  be listed by `wsl.exe --list`, and is re-validated at the exec site.
- **Keys:** generated by core per distro with ssh2. Keep the parse-back retry in `keyPair()`: ssh2 1.17
  writes an unreadable Ed25519 key about 1 time in 300. Key bodies go over stdin through
  `remoteAtomicWrite`, never on an argv. The client's private key stays on Windows. Modes are 0600/0700.
  POSIX modes do not apply on Windows, so each key directory gets an explicit ACL for this user with
  inheritance removed, through a fixed-path `icacls` before a key lands in it (`windowsPrivateDirArgs`).
  The grant is by SID from a fixed-path `whoami /user /fo csv /nh`, never by name: on a domain machine with
  a same-named local account, a name could grant the local account while `/inheritance:r` removes the real
  user. If the SID cannot be read strictly, or either step fails, the directory is left unchanged on the
  profile folder's own ACLs, it is logged, and setup continues. **SYSTEM and Administrators lose access to
  this folder**, which system-level backup tools may notice. A lost key heals: the
  public half is derived from the private key, and a lost private key gets a new pair.
- **The host key pin is exact.** A different key in the distro is refused by name, and no key is
  adopted: with nothing to compare (first connect, reinstalled distro, lost local records) core
  generates a new one and only then moves the pin. The new key is recorded as `pendingHostKey` before
  the write, so a run that stops partway completes the move next time instead of reporting a changed
  key. `authorized_keys` is compared by checksum of the whole file, so a planted extra line is removed.
- **Never installs and never runs sudo.** Missing `sshd` is a connect failure naming the install
  command. Missing `tmux` or `curl` is a warning (`endpointWarnings` on the status event, a banner, and
  the dialog) and the project still opens. An empty list clears a warning the user has fixed.
- **Only the distro the user chose is started.** Listing does not start one and the pre-warm skips WSL
  hosts. A cold start gets 60 s (`CONNECT_TIMEOUT_S`) rather than the argv's 15.
- **Every `wsl.exe` call has a HARD timeout** (`wslRunner`), because a stuck distro was measured hanging
  for over 2 minutes. `close` is not a bound: it waits for the pipes, and a process that inherited them
  held one open 26.5 s against a 10 s limit. So the timer answers by itself and destroys the pipes.
- **`wsl.exe` output:** its own text is UTF-16LE and Linux output is raw bytes, possibly mixed on one
  stream. The probe's lines carry an `NTWSL` marker the parser keys on. The transport drops what precedes
  the SSH banner, bounded by `MAX_PRE_BANNER_BYTES` and for a trusted transport only, because ssh2 fails
  a UTF-16 notice with `Invalid header: expected newline`. A failure printed there ends up in the error.
- **The keepalive (`settings.wslKeepDistroRunning`, machine-local, on by default).** Community reports and
  a Microsoft thread say WSL stops a distro with no client attached and that tmux does not count; that
  is NOT measured here. While the app runs, the sshd's `wsl.exe` is a client. The keepalive is a second
  one that outlives the app: `wsl.exe -d <distro> --exec sh -c <WSL_KEEPALIVE_SCRIPT> nodeterm-wsl-keepalive-<handle>`,
  detached, hidden, with `stdio: 'ignore'`, by argv. The VM keeps using memory after quit, and the row in
  Settings → Remote (SSH) says so. Off, nothing outlives the app, and one left by an earlier run is stopped
  on the next connect.
  - **Only for a project the user created on the endpoint,** on its connect (`WslEndpoints.connected`).
    Never for a folder browse, a listing or a `wsl:` profile.
  - **Exactly one per DISTRO, recognized inside it.** `WSL_KEEPALIVE_OPS` reports a process only if this
    user owns it and its arguments after argv[0] are EXACTLY `-c <script> nodeterm-wsl-keepalive-<16 hex>`.
    Any handle counts, because a lost or corrupt `endpoint.json` mints a new one, and the old keepalive
    must still be reused and stoppable. A process that merely mentions the marker is neither trusted nor
    stopped, which `wsl-keepalive.test.ts` proves with real decoy processes. `trim` keeps one and stops any
    extra. **Two valid records on one distro** share that one keepalive: whichever connects reuses it, and
    deleting a project stops it only when no record on that distro still has a project.
  - **Stopping:** deleting a distro's last project (`wsl-project:unbind`), or turning the setting off,
    stops it by the same match. Turning it off looks in every distro `wsl.exe --list --running` reports,
    including ones with no readable record, because a lost record leaves nothing saying which distro it
    was. It runs one read of `/proc` there and starts nothing. Closing a tab does not stop it: closing means
    "not now".
  - **If it cannot start:** a named `keepalive` warning, and the project still works.
  - The `distro-restarted` warning (boot id + init start time) remains for when the distro stopped anyway.
- **Stopping a distro, combined behavior.** The keepalive has no restart loop and the service has no timer,
  so a `wsl --shutdown` or `wsl --terminate` ends it and nothing it owns starts the distro again. But an
  OPEN project reconnects: its dropped channels fire the renderer's `SshReconnector` right away, and the
  45 s `revalidateAll` watchdog follows. Either one re-establishes the master, which boots the distro and
  starts a new keepalive. **So a distro cannot stay stopped while one of its projects is open.** To keep it
  stopped, close its project tabs first, then run `wsl --terminate <distro>`. Closing a WSL tab keeps its
  master down (`dropClosedWslConnection`, unlike an ordinary SSH project, whose master stays). That takes
  three things together, because ending the master alone starts a reconnect: the parked PTY's channel
  exits 255, which reports a drop, which dials a second later and registers the project with the watchdog
  again. So the close cancels a pending reconnect, `SshReconnector` dials nothing for a closed WSL project
  (`createProjectReconnector`), and the terminals' parks are disposed, since a park on the ended master is
  dead and reopening would adopt it. A drop on a closed project is still REMEMBERED: closing the last open
  tab leaves its nodes mounted (the load effect bails with no active project), so a DIRECT reopen keeps the
  same ids, nothing remounts, and those dead terminals come back only through a respawn. The coordinator
  holds them and, on reopen, resumes the ordinary loop, whichever comes first: a `connected` status or its
  own 1 s timer (a connect that reuses a live master reports no status). Each respawn's `new-session -A`
  reattaches to the live tmux session, and reopening starts the distro if it stopped. **Once another project
  is active the hold is dropped** (`nodesMayBeMounted`): its load replaced those nodes, so reopening mounts
  them fresh and they attach by themselves, and a respawn would only kill a terminal that just attached. A
  close also ends that project's `RESPAWN_REFUSE_MS` windows, because the exit it causes says nothing about
  a broken spawn, and refusing one that lands just after a quick reopen would strand the terminal. An
  ordinary SSH project keeps its window. Closing alone leaves the distro running on its keepalive; to
  stop that too, turn the setting off or delete the project. A setting change never starts a distro: it
  only touches distros `wsl.exe --list --running` reports.
- **Testing:** `wsl-endpoint.test.ts` and `wsl-keepalive.test.ts` run the real NativeMux against ssh2's
  Server behind a scripted `wsl.exe` on any OS, and the real scripts under `/bin/sh` on POSIX. For a live
  run off Windows set `NODETERM_NATIVE_SSH=1` and `NODETERM_WSL_PROJECTS=1`, which resolves the bare
  `wsl.exe` on PATH (never read on Windows). sshd takes HOME from passwd, so `HOME=` alone does NOT
  sandbox a session: use a mount namespace over the real home.
- **What has been measured, and how.**
  - From real Windows `node.exe` v25 through real `wsl.exe` with an extracted sshd: the launcher's quoting
    survives; with the generated `sshd_config`, ssh2 connected in 77 ms; exec, PTY size, SFTP and a reverse
    unix-socket forward to a listener on Windows all worked, with the socket at mode 600; `taskkill /t /f`
    left no sshd running and tmux survived. In that run `$HOME` in the launcher was replaced by a sandbox
    path. Separately, `wsl.exe --exec` ignored a `HOME` passed by WSLENV: the probe reported the real home.
  - The running Electron app under Xvfb with a real sshd, tmux and hooks, but a stand-in for `wsl.exe` that
    exec'd the Linux side directly: project creation, tmux, a dropped connection (~1.1 s to reconnect),
    an app restart keeping the same pane, hooks through the tunnel. This predates the keepalive.
  - NOT measured anywhere: the keepalive on real `wsl.exe` (that it survives the app quitting, that
    `detached` with no console works, that argv[0]-independent matching holds), and WSL's idle stop itself.
