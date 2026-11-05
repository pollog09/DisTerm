# Agent hooks and integration consent

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Agent hooks and integration consent

- **Hook server (loopback HTTP)** — `src/core/agents/hook-server.ts` is a main-process
  loopback HTTP server (per-session bearer token, fail-open) that the installed hook scripts
  POST to; it replaced the old `fs.watch` signal-log mechanism. `buildPtyEnv` injects the
  node id + endpoint/token into each spawned session's env; because tmux sessions **outlive
  the app**, the server also writes `<userData>/hook-endpoint.env` so a relaunched main
  process re-advertises the same endpoint (restart handoff). A `setRawListener` channel feeds
  the per-node context-window meter (`context-tail.ts` — **one tail per agent**, each with its own
  `parse` dep: claude's usage records, `codexContextParse`, `geminiContextParse`) and the subagent
  live-transcript (`subagent-tail.ts` — claude via meta-dir `track`, codex via `trackFile` with the
  stateful `codex-subagent-format.ts` formatter). The same events feed the **agent-status mirror**
  (`core/agent-status-mirror.ts`) the mobile companion reads; the mirror carries an optional
  `settings` block (`claudePermissionMode`/`autoSupported`/`claudeAccounts`) so the phone can
  launch agents with the desktop's permission mode + managed accounts, and SSH slices get their
  **per-host** settings (remote CLI caps + host-matched accounts) injected via
  `remote-status-push`'s `settingsFor` dep. `settings.customAgents` (`[{id, label, baseAgent?,
  binaries}]`) lets the phone chat with a custom agent: built ONLY by `core/mirror-custom-agents.ts`
  (one definition for all three providers — local file, which relay `projects.list` also serves,
  SSH slices, Server Edition), `binaries` = `binariesFor` from the pane-owner predicate, published
  only when every name fits the plain alphabet `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (else `[]`) —
  the builder enforces it because the tokenizer can "name" a slice of a secret (`oauth2:ghp_…` out
  of a git URL, a quoted env value, a `${env:…}` template). **Never put a custom agent's raw
  `launchCmd`/`args`/`env` in the mirror** — they carry API keys and the file lands on every SSH
  host. `binariesFor` resolves a BLANK launch command with a *builtin* `baseAgent` to the base's
  binaries (what `resolveAgentConfig` actually launches).
- **Agent-integration consent (#744)** — `core/agent-integrations.ts` (booted by BOTH shells) is the
  ONE writer of user-owned agent config; consent is `settings.agentIntegrations`
  (`@shared/agent-integrations`, sanitized on every read). Per agent: **enabled** = hook + both skills
  in the agent's own skills dir + strip older builds' AGENTS.md/GEMINI.md blocks (they were 17 KB of
  codex's 32 KiB `project_doc_max_bytes`); **declined** = remove exactly what we wrote (hooks by exact
  command, skills by exact-content receipt in `<userData>/integration-receipts.json` — a user-edited
  file is KEPT and listed in Settings, bounded at 20 — legacy blocks, our hook scripts);
  **undecided** = nothing either way. Server `installHooks: false` is a hard veto. Rules a refactor
  must not undo:
  - **Grandfathering is decided at boot from OUR files only** (a non-empty `~/.nodeterm/agent-hooks/`),
    before `settingsStore.registerIpc()` and before any install: an existing install gets every
    agent + `hostDefault` enabled and a one-time notice; a new install gets NO record and a banner
    (Enable all / Choose… / Not now — "Not now" declines all, so it asks once). **Evidence must be a
    file only a pre-consent build wrote** — the userData canvas/context shims are written on EVERY
    boot, consent or not, and counting them grandfathered every fresh install on its second boot
    (issue #1149: a systemd restart, the update timer, a desktop quit before the banner was
    answered — 11 hook entries in `~/.claude/settings.json`, Codex `trusted_hash` pre-approvals).
    And the decision is made ONCE: the first boot that finds no evidence writes
    `<userData>/integration-consent-fresh-install` (`FRESH_INSTALL_MARKER`), after which no boot of
    that install grandfathers — so a sibling install sharing `~/.nodeterm` (desktop + Server Edition)
    enabling ITS hooks cannot grandfather this one either. A marker FILE, not a settings key:
    `SettingsStore.init` reads an unreadable settings.json as the defaults, and a boot-time save of
    a "not answered yet" record would overwrite the user's file. Same function, same call, both
    shells.
  - **No caller reaches an installer by omission.** `installManagedAgentHooks(agents)` takes a
    REQUIRED set; `RemoteHooks` takes a REQUIRED plan (`NO_REMOTE_INTEGRATION` = fail-closed);
    account add/link asks `currentIntegrationLifecycle()` and writes nothing when none is registered.
    `agent-integrations-wiring.test.ts` pins every call site of the global installers.
  - **SSH consent is per HOST (`sshHostKey`, never identity file / port / args).** A host installs an
    agent only when the host AND the agent are enabled; an unanswered host is not touched at all
    (no clean-up, no ssh); removals run on connect and when the plan changes
    (`SshProjectManager.onIntegrationConsentChanged`). A removal never creates a missing config
    file (`stripRemoteSettingsFile`).
  - **`$CLAUDE_CONFIG_DIR` decides the system Claude dir** (`claudeSystemConfigDir`), never a
    hardcoded `~/.claude`; a decline also cleans the legacy `~/.claude` when they differ.
  - The fullscreen-TUI write is part of the claude integration and follows its consent.
  Measurements, the device checklist and the open product question: `docs/agent-integration-consent.md`.
- **Hook installers** — `src/core/agents/hooks/` holds per-agent hook services + an installer
  registry `MANAGED_HOOK_INSTALLERS`. `managed-script.ts` builds the POSIX hook script that
  POSTs to the server (env-gated: a no-op in the user's normal terminals, active only in
  sessions nodeterm spawns; the `claude-signals` string is kept as the idempotency marker that
  migrates users off the old hook). claude → `~/.claude/settings.json` and gemini →
  `~/.gemini/settings.json` (shared `install-helper.ts`, merged/idempotent, preserving other
  tools' hooks); codex → `~/.codex/hooks.json` + `~/.codex/config.toml` trust entries
  (`codex-trust.ts` — the hash gates whether codex runs the hook); **grok → our OWN file
  `$GROK_HOME/hooks/nodeterm-status.json`** (its hook config is a directory whose files are all
  merged, so there is nothing of the user's inside ours — which is also why a malformed copy is
  *healed*, not preserved, on both the local and the SSH path). The per-event **`matcher`** the grok
  installer needs is why events are typed `ManagedHookEvent` (`string | {event, matcher}`): grok's
  tool matcher is a REGEX and must be `.*` — a bare `*` is invalid and silently stops tool events
  firing. Plain-string events keep their byte-identical output for every other agent.
  **opencode gets TWO plugin files, because no single module loads on both of its generations**
  (issue #1136, `hooks/opencode.ts`, measured 2026-10-16 on @opencode/cli 2.0.30 and opencode-ai
  1.1.4 / 1.2.10 / 1.18.28 / 1.18.33). 2.x accepts only a default export OBJECT `{ id, setup }` (a
  function default is refused) and loads `plugins/*.js` and plugin DIRECTORIES; 1.x loads only
  `{plugin,plugins}/*.{ts,js}` files, and up to **1.2.10 calls every export as a function** — an
  object default there throws and kills every opencode command on the machine, inside nodeterm or
  not (bisected: 1.2.10 crashes, 1.2.11 does not). So `plugins/nodeterm-status.js` keeps ONLY the
  named 1.x export (2.x logs a harmless "failed to load plugin" WARN for it at every start) and 2.x
  gets `plugins/nodeterm-status-v2/index.js`, a directory no 1.x glob matches. **Never add a default
  export to the 1.x file**, and never "simplify" the pair back into one dual-shape file. A
  process-wide latch (`Symbol.for('nodeterm.opencode.status.api')`, keyed by API, not by call)
  keeps a process that runs both from posting twice. The 2.x plugin translates its event stream to
  the 1.x wire names (`session.execution.started` → user `message.updated`, `…succeeded|interrupted`
  → `session.idle`, `…failed` → `session.error`, `form.*` → `question.*`), so `normalizeOpencode` has
  one dialect, and it drops a subagent child session's turn events (forwarding its permission/form
  under the root session). **It refuses to run inside 2.x's shared background server**
  (`serve --service`, argv): by default every 2.x CLI talks to ONE server that keeps the env of
  whichever pane started it and outlives it — measured, a second pane's events carried the first
  pane's `NODETERM_NODE_ID` — so posting from it would paint one node's status on another (the
  codex `--no-daemon` problem). Only a `--standalone` server (the pane's own `serve --stdio` child)
  reports, so **2.x status needs `opencode --standalone`**; nodeterm does not pass it yet (1.x exits
  on the unknown flag, so it needs a codex-style `--help` probe — follow-up), and until then the
  Launch commands override (`opencode --standalone`) is the user's switch.
  **Codex is the one agent whose hook command is NOT a POSIX one-liner on Windows** (issue #567):
  it builds the command as `cmd.exe /C <string>` (`codex-rs/hooks/src/engine/command_runner.rs`,
  rust-v0.151.0) unless the session has a shell configured, which a default Windows install has
  not — so `if [ -x '…' ]; then …; fi` answered `-x was unexpected at this time.` and **exit 1 on
  every event**, for the life of the node. Claude is fine there only because Claude Code runs its
  hooks through Git Bash. The fix is a batch entry point (`codex-hook.cmd`,
  `codex-windows-wrapper.ts`) written beside `codex.sh` and named by `buildManagedCommand`'s win32
  branch; it **locates a POSIX shell and runs the same script** — deliberately not a second
  implementation of the hook protocol, which would be two copies of the POST/failover/token/
  permission-poll to drift. Three rules it must keep: pass stdin through, DRAIN stdin on every bail
  (codex writes the payload there; #186/#187), and exit 0 when there is no shell or no script.
  Two traps around it: `buildManagedCommand`'s `platform` is the platform of the machine that will
  RUN codex, so `RemoteHooks.installCodexRemote` passes POSIX explicitly (a Windows desktop must not
  put a `.cmd` command on a Linux host); and `isManagedCommand` matches **both** leaves
  (`codex.sh` AND `codex-hook.cmd`) on every platform — matching only the local one would leave a
  pre-fix entry unrecognized, so the fresh one is appended beside it, which is #558 on a second
  file. Matching both is what REPAIRS an existing Windows install at the next launch.
  **Codex hook trust is re-checked at every LOCAL Codex spawn, not only at boot, in the HOME that
  session runs under** (`ensureCodexHooksCurrent(home)` in `core/agents/hooks/codex.ts`, called
  from `PtyManager.spawnSession` inside the local codex-scope block with the same
  `codexScope.CODEX_HOME` it puts in the pane's env — a managed account's private home or the
  system one). Codex reads hooks.json and the config.toml `trusted_hash` blocks from its
  CODEX_HOME at SESSION START and silently skips an untrusted hook; boot was the only install, so a
  config.toml rewritten while the app ran (codex's own /hooks flow, another tool, a test run on the
  real home) left every Codex session started afterwards dark — measured on a Windows desktop:
  every message to those nodes queued as `targetStatusStale` and expired. `codexHookDrift(home)`
  is read-only (script + Windows wrapper bytes, our hooks.json entries via the same
  `buildCodexHooksAndTrust`, and each trust key's hash); only drift re-runs
  `installCodexHooks(home)`, with a warning naming the home and what was repaired, so a current
  install never rewrites config.toml (codex writes it too). It never throws into the spawn, never
  creates a missing home, and an `accountId` that is not a known Codex account gets no repair
  (never a fallback to `~/.codex`). **Both repairs are consent-gated (issue #744):** the spawn
  check is reached only through `currentIntegrationLifecycle()?.ensureCodexHooksForLaunch(home)`
  and the account-home pass only inside `reconcile()` — both in `core/agent-integrations.ts`, both
  a no-op unless codex is `enabled` (declined, undecided, the Server Edition veto, or no lifecycle
  registered ⇒ nothing is written). Calling `ensureCodexHooksCurrent` from anywhere else would
  re-install hooks for a user who declined them. **Managed account homes symlink hooks.json + config.toml to
  `~/.codex`** (`initializeAccountHome`), so every write goes through the link (`writeTarget`,
  realpath) — a temp+rename onto the link would replace it with a private copy no later system
  install reaches. A home whose links were never made or were replaced by real files is repaired in
  place; boot now covers those homes too (`ensureCodexHooksForAccounts`, from the lifecycle's reconcile in both shells), where before
  it installed only `~/.codex` and relied on the links. Not covered: SSH hosts (RemoteHooks owns
  those files) and an in-pane restart/resume that types `codex` without a new spawn.
  **A trust table is found by its DECODED key, never by spelling** (`tableHeaderPath`,
  `codex-trust.ts`): bare, `"basic"` (escapes, `\u`) and `'literal'` segments name the same TOML
  key. Measured live on a Windows desktop (2026-10-07): config.toml held our tables as
  `[hooks.state.'C:\…']`, the matcher only knew our `"C:\\…"` spelling, the repair APPENDED a second
  table per key, and Codex refused to start ("duplicate key") — every Codex node dead. The boot
  install had the same flaw before the launch repair existed; the launch repair just ran it more
  often. A repair now REWRITES the existing table whatever its quoting (keeping `enabled = false`),
  and **an edit that would leave any `[table]` defined twice is refused** (`assertTomlTablesUnique`,
  run inside `upsertHookTrustEntriesInContent` whenever it changed the text): the local installer
  computes the config.toml edit BEFORE writing hooks.json, so a refusal writes nothing and warns; the
  SSH installer throws inside its update and writes no config.toml. No TOML parser is in our deps, so
  the guard is the duplicate-table check, not full validation. **A managed hook command is matched
  only under our own directories** (`OWN_HOOK_DIRS`: `/.nodeterm`, `/node-terminal`,
  `/.nodeterm-server` + `/agent-hooks/<leaf>`), never a bare `agent-hooks/<leaf>` tail: another tool keeps
  `~/.other/agent-hooks/codex-hook.cmd` and the tail match stripped it on every repair (and that tool
  did the same to ours). A stale entry from a Server Edition run with a custom `--data-dir` is no
  longer swept — **by repair OR by a declined codex's cleanup** (`removeCodexHooks` shares the
  matcher). Decided, not overlooked: a decline removes exactly what we wrote, and a tail match cannot
  tell our legacy entry from another tool's live one, so the inert legacy entry is left. install-helper's matcher for the other agents still matches by tail (not changed here). **Both
  sides of the managed-entry match go through `normalizeHookCommand`** — the marker used to be
  folded to `/` while the stored command was compared raw, so on Windows nodeterm never recognized
  its OWN entry and appended a fresh set every launch (#558: nine copies of nine events, nine
  `claude.sh` processes per Stop, nine 45 s `PermissionRequest` waits racing one prompt). Because
  `mergeManagedHook` drops every managed entry before pushing one fresh, the corrected match IS the
  repair for a file already ruined — it runs at boot via `installManagedAgentHooks` and, being the
  ONE shared merge, heals claude/gemini/grok, every managed Claude account dir and all three SSH
  remote installers at once; a second repair mechanism would be exactly the duplicated rule this
  file warns about. It strips only OUR handler out of a definition, so a hook a user hand-merged
  beside ours survives.
  **Every agent except claude gets a Windows wrapper** (2026-10): gemini (PowerShell, its
  `getShellConfiguration`), grok (PowerShell per its docs — unmeasured) and copilot (its
  `powershell` key) cannot parse the POSIX line either, so `windows-hook-wrapper.ts` is the ONE
  template (`buildWindowsHookWrapper`, codex's bytes pinned) and `buildManagedHookCommand(sp, {},
  'win32')` names `<agent>-hook.cmd` through the codex invocation. Its `platform` defaults to POSIX,
  NOT `process.platform` — the SSH installers call it bare. `installHooksInto({windowsWrapper})`
  writes the wrapper BEFORE the config; the managed-entry matcher pairs `<agent>.sh` with
  `<agent>-hook.cmd` (`managedMarkersFor`) so an upgrade replaces the POSIX entry. Claude stays
  POSIX (Git Bash).
- **A reused ControlMaster is not evidence of a live hook tunnel** (issue #735 — remote sessions
  stuck on **Unknown**, no completion notifications, no unread dots). `connect()`'s reuse branch
  returned the cached `hookEndpointPath` whenever `ssh -O check` answered, on the written-down
  assumption that *"a master that answered `-O check` never lost its tunnel"*. That is false, and
  the mechanism is **our own self-heal**: `childArgs` uses `ControlMaster=auto` + `ControlPersist`
  precisely so a dead master is rebuilt by the next child command (a status poll, a mirror push, a
  remote git call) on the same ControlPath. The rebuilt master answers `-O check` — and carries no
  `-R`, because `RemoteHooks.setup()` is the only caller of `hookForwardArgs` and it runs only on
  the branch where a master has just come up. The 45 s watchdog then parks on the reuse branch
  forever. Nothing reports it: the project says `connected`, terminals work, the mirror pushes, and
  only the hook POSTs die — into a socket file that still EXISTS with nobody listening.
  **MEASURED on the host that prompted the fix**: 10 per-project hook sockets on disk, exactly ONE
  with a listener (`ss -lxp`); the dead project's socket answered `curl` exit 7 while that same
  project's status mirror was being written the same second; **107 of 128** live `nodeterm-rmt`
  tmux sessions were pinned to that dead endpoint. Sessions are pinned for life
  (`new-session -A -e …` — tmux ignores `-e` on an existing session), so every one of them stayed
  dark until the app restarted. The reuse branch now probes the tunnel (`RemoteHooks.tunnelAlive`,
  one `curl` over the already-multiplexed master) and re-runs the idempotent `setup()` when it does
  not answer, firing `onTunnelVerified` so the working agents resync. **The retry is backed off**
  (`tunnel-repair.ts`, pure + tested): the FIRST failure repairs immediately — that is the common
  case — while a host that can never forward (`AllowStreamLocalForwarding no`, no `curl`, a `$HOME`
  the validator refuses) settles at one attempt per 15 minutes instead of rewriting every agent's
  hook config every 45 s. A missing spec answers "not alive" rather than "unknown": nothing of ours
  is bound, which is a tunnel that cannot deliver.
- **An SSH host's agent tools are CHECKED, not assumed** (since #744 the plan holds only what the
  host's consent installs — shims + skills, no instruction blocks; an unanswered host is skipped)
  (`RemoteHooks.refreshAgentTools`,
  `main/remote-ssh/agent-tools-freshness.ts`). The canvas/context shims, both SKILL.md files and our
  blocks in the codex/gemini/copilot/opencode instruction files used to be written only by the
  establish path, blind, and never looked at again, so a host could keep another build's text for
  a whole run: a fire-and-forget install that failed open was never retried; a tunnel that failed
  verification at connect and was repaired later on the reuse branch (#735, above) never got them
  at all; and a managed account's skill was written ONCE, when the account was added, so after
  every update each remote account session read the verb docs of the build that created the
  account. (The obvious suspect is not one: an app update never lands on the reuse branch. `conns`
  is in memory, so the first connect after a relaunch adopts the ControlPersist orphan on the
  ESTABLISH path, which always wrote. `ssh-project.test.ts` pins that it checks there too.)
  - **The stamp is the bytes.** One generated probe (one round trip, a few hundred bytes back)
    runs POSIX `cksum` over every file the host holds and, for an instruction file, over exactly
    the span `merge*Block` would replace (awk under `LC_ALL=C`: the first start marker through the
    first end marker, only when the end follows the start). That is compared with `posixCksum` of
    the exact bytes this build would write (`core/remote-ssh/posix-cksum.ts`, pinned against the
    real binary), and only what differs is rewritten, through the same appliers as the install. A
    current host costs the probe and no write. Nothing is embedded in the artifacts: a stamp line
    would be noise in every agent's context, would need a migration for hosts written by older
    builds, and would trust a file's claim about itself. `cksum` because it is the one checksum POSIX
    requires; CRC-32 + length is not collision resistant and does not need to be, because this
    detects drift and is not a security check. Ubuntu's own BusyBox build omits `cksum`, so such a
    host exists: missing, unreadable and gated files are still told apart there, the files it can
    read are written without comparison (what every connect did before) and the blocks merged. An
    awk that fails on a block is reported (`X`, through fd 3 — `awk | cksum` exits with cksum's
    status) and that block is merged, which writes only on a change. Only files ACTUALLY written
    are logged as "rewrote" or make the outcome `refreshed`. The permanent suite runs the probe
    under every shell × awk the machine has (what the CI image has); a one-off manual run added
    BusyBox sh, zsh 5.9 and the one-true awk 20231127 (`NT_PROBE_EXTRA_AWK` / `_SH`). macOS's own
    awk (20200816) and BSD `cksum` have never been run — that is on the PR's Mac checklist.
  - **The end marker is searched AFTER the start marker** — in both `merge*Block` functions and in
    the probe's awk alike. Taking the first end marker anywhere read a hand-deleted block's leftover
    end line as "no block": the merge appended a fresh copy every time, and with an hourly check a
    host's AGENTS.md grew by one block an hour (measured in review: 41,693 → 81,279 → 120,865 →
    160,451 bytes). The same merges run at boot for the desktop's and the Server Edition's own local
    instruction files (`initCanvasControl`, `initContextLink`), which grew by one block per launch.
  - **Refusals.** A file that is not a readable regular file (a directory, a dangling dotfile link,
    no permission) is NEVER written over, and the host is not called confirmed. A managed account's
    skill is refreshed only when its dir ALREADY exists — checked by the probe and again on the host
    in the write itself (`remoteAtomicWrite`'s `requireDir`), so a dir removed in between is not
    brought back by the parent `mkdir -p`. A report that does not
    parse changes nothing. Account ids from settings are re-validated (`isSafeAccountId`) before
    they become paths. The copilot block is judged at the host's `$COPILOT_HOME` only when the
    installer's validator would accept that value.
  - **Cadence.** A connect (establish, including the post-relaunch orphan adoption) and a tunnel
    repair always check. The 45 s reuse branch costs nothing once this run has confirmed the host
    for the current expected set (content + account list). An unconfirmed host is retried there on
    the tunnel-repair backoff (1/5/15 min). A confirmed host is looked at again hourly
    (`AGENT_TOOLS_RECHECK_MS`), because within a run only a writer outside it (another desktop,
    possibly an older build, on the same host account; a hand edit) can change the files. One check
    per host at a time: projects sharing a host share it.
  - **A new agent-facing doc on a host goes into the artifact plan in `remote-hooks.ts`**
    (`canvasControlArtifacts` / `contextLinkArtifacts` / `accountSkillArtifacts`) — shims, skills,
    instruction blocks. The installers and the probe both read it, so a file added there is written
    AND kept current. NOT the rest of what connect writes: the hook scripts and the agents' hook
    config belong to `setup()`'s ordered chain (after the verified tunnel and the endpoint file),
    and the endpoint file and node tokens carry credentials — none of those may be rewritten on a
    freshness cadence.
  - **What a running agent sees.** The shim's `help` is answered by the shim itself (baked from the
    verb registry), so it is current the moment the file is. Claude reads a SKILL.md body when the
    skill is invoked; codex, gemini and opencode read their instruction files at session start, so
    a session started before a rewrite keeps the old text until it restarts. Nothing is typed into
    a pane to announce it.
  - Surfaces: Desktop only (SSH projects are a desktop concept). The Server Edition runs ON its host
    and rewrites its local shims at every boot. Mobile: N/A.
- **The per-agent hook installs run CONCURRENTLY, and the order that still matters is the one above
  them.** `RemoteHooks.setup()` is the chain `connectOnce` awaits before a project reports
  `connected`, so every terminal of a switched-to project waits through it. Its shape was: resolve
  `$HOME`, open + VERIFY the reverse tunnel, write the endpoint file — and then install five agents'
  hooks strictly one after another, ~16 more remote round trips in a row. MEASURED against a real
  sshd through a 25 ms one-way delay proxy (50 ms RTT), 5 runs each: **3281 ms serial → 1471 ms
  concurrent** over the same 22–24 ssh children. The installers are independent by construction —
  each writes its own script under `<remoteDir>/agent-hooks/` and merges its own agent's config; no
  two touch the same remote path, and the only shared statement is an idempotent `mkdir -p` — and
  the `SshChildGate` (cap 6 per ControlMaster) is what makes the fan-out safe against a stock host's
  `MaxSessions`, which is the whole reason it exists.
  - **The tunnel and the endpoint file stay strictly BEFORE the fan-out**: that file is what every
    hook this installs POSTs through, and it is written only once the tunnel has verified end to
    end. `remote-hooks.test.ts` pins that ordering AND the overlap (a gated fake runner, so
    concurrency is observed rather than inferred from wall-clock; the overlap test fails on the
    serial version, checked by mutation).
  - **`allSettled`, not `all`.** By the fan-out the tunnel is verified and the endpoint written, so
    one installer failing must cost that agent its hooks and nothing else — not discard a working
    setup for every other agent, which is what a rejection propagating to `setup`'s outer catch
    would do (`return null` ⇒ no hooks at all, and post-#735 a repair retried on backoff forever).
    Every installer catches its own errors today; this is the guard for the next one that forgets.
  - The claude/gemini loop body became `installJsonAgentRemote`, with the same fail-open try/catch
    its three siblings already had. Its three steps stay strictly ordered inside: the merge reads
    the file the write then replaces.

**Command-bearing terminal opens (issue #653):** the shared hook-server route requires verified
node identity whenever `open-terminal` carries `cmd`, including an empty value or a dry run.
The strict-policy override and foreign-instance fallback cannot release this gate. Desktop plain
terminal opens keep their existing identity policy; Server Edition still requires verification
for every control verb. Legacy mobile/SSH callers must present this instance’s node token for
command-bearing opens; this does not add a human-confirm dialog or change mobile transport APIs.

- **Hook-reply answers: plans and questions** (`core/agents/permission-decision.ts`, full write-up in
  **`docs/hook-reply-approvals.md`**) — the managed hook holds a Claude `PermissionRequest` and polls an
  answer file. For `ExitPlanMode` / `AskUserQuestion` (`requiresUserInteraction`) Claude **DROPS a bare
  allow**, so the answer must carry `updatedInput`: plan = `{}` (+ optional session `setMode
  acceptEdits|default`, never `auto`), question = the request's own `questions` + `answers`. Rules a
  refactor must not undo: (1) **only core builds decision JSON**, from the pending request file on the
  agent's host (never renderer-echoed questions), validating every field; (2) the script prints only the
  fixed words' decisions or a file that passes the strict prefix/size/one-line bound
  (`isBoundedAnswerContent` is the TS twin — both writers refuse anything the script would ignore);
  (3) answer content never rides an argv (the answered POST carries the decoded verb; SSH writes go on
  stdin); (4) a plain `allow` maps to `updatedInput:{}` for a plan and is swallowed (hook keeps
  holding) for a question — core refuses to write it and the header hides ✓ Approve for that ticket;
  (5) these two tools hold 540 s (`PERM_WAIT_SECS_INTERACTIVE`) under the explicit `timeout: 600` we
  write on the PermissionRequest handler — except a subagent's request (payload carries `agent_id`),
  whose dialog awaits the hook; (6) structured answers are gated on the SCRIPT REVISION: an old script on
  an SSH host (rewritten only at connect) silently ignores JSON while the write succeeds, so the hook
  server keeps `held` only for `clientRevision >= MIN_STRUCTURED_ANSWER_REVISION` and core refuses a
  structured answer (or a plain plan allow) for a ticket it did not record as capable — never a false
  "answered". The renderer gets `held: {pendingId, toolName, questions?}` on the event/store (kept while blocked
  OR waiting), separate from the approve/deny `pendingId` the mirror strips from a question;
  `questions` (a held AskUserQuestion's exact question texts, from the one `readQuestions`) is what
  the ⌘M answer controls match their card by — absent = unreadable input = no controls. Desktop local + SSH, Server Edition local;
  relay unchanged; phone keeps `allow`/`deny` (its plan approve now works via the script mapping).
- **A hook event's node id is INHERITED, so only the pane's foreground claude speaks for a node**
  (issues #1112, #1153; `core/agents/claude-pane-origin.ts`). `NODETERM_NODE_ID` (and the per-node
  token, looked up by that id) reaches every process the node's claude starts: a background script's
  `claude -p` took over the node's session id, model, meter and context-link transcript (#1112), and
  Claude's daemon (`claude daemon run` → `--bg-pty-host` → the `--fork-session` claude) posted a
  fork's hooks as the node that spawned it, so `/rename` retitled the wrong node (#1153). The rule is
  keyed on the PROCESS, not the session: the managed claude script runs one
  `ps -o stat= -o tty= -p $CLAUDE_PID` WHILE claude waits on the hook and posts
  `nodeterm_claude_{pid,fg,tty}`; the hook server sends every claude event through a per-node
  ordered gate BEFORE either listener, and drops it when the claude is not in the foreground group
  of any terminal, or is foreground on a tty that is not the node's pane tty (`PtyManager.paneOwner`,
  wired in BOTH shells by `wireClaudePaneOrigin`, cached 5 min, re-read on disagreement at most every
  10 s, forgotten on destroy/recycle). MEASURED on Claude Code 2.1.301 in a private tmux server:
  `CLAUDE_PID` is in every hook's env (and in the binary from at least 2.1.220, absent from 2.1.200);
  the pane's interactive claude has `+` on the pane tty; a `claude -p` run from claude's Bash tool
  (a setsid'd shell) has tty `?`; a `&` job of the pane shell has no `+`. Every legitimate change —
  `/clear`, `/resume`, `/compact`, Branch, cold-restore resume, in-place restart, a new `claude`
  after the old one quit — happens in the pane's foreground and needs no rule of its own; a claude
  that died without `SessionEnd` blocks nothing (there is no binding to release). Rejected:
  session-source allowlists (a detached `claude -p --resume` also says `resume`; a missing
  `SessionEnd` locks the next session out — both found in the #1112 prototype) and "first session
  wins until its pid dies" (needs a remote liveness probe, and a daemon fork outliving its spawner
  would take the node over). **Fails OPEN** wherever a fact is missing — no `CLAUDE_PID` (older
  claude), Git Bash / BusyBox `ps`, a pane tty this core cannot read (Zellij, plain-shell fallback,
  an SSH node with no live client here), a probe over 2 s — because dropping the pane's OWN events
  strands a node on RUNNING. The script also never arms the approval wait for a non-foreground
  claude. Known residuals: a claude wrapped in its own pty inside the pane (`script`, `unbuffer`) is
  foreground on that pty and reads as foreign; a node whose TUI attaches to a daemon-hosted session
  gets no hook events at all (they were never posted under its id). Mobile: N/A (the mirror simply
  stops receiving foreign events).
- **Per-node hook identity** (`src/core/agents/node-auth-*.ts`, `node-token-*.ts`,
  `node-identity-policy.ts` — full write-up in **`docs/node-identity.md`**) — the shared bearer proves
  "a session on this machine", never *which* session, so every node also gets a capability derived
  from one restart-stable secret (`kid.mac`, domain-separated HMAC over the node id), handed to the
  client as a 0600 file and verified three ways: `verified` / `legacy` / `forged`. `legacy` is "we
  cannot judge this", not a failure. Two invariants come out of this series and both cost real
  incidents to learn:
  - **A credential never rides argv — local or SSH.** Measured 2026-08-13: `buildPtyEnv` put the hook
    bearer in the tmux `-e` argv, which lands in a long-lived tmux client's `/proc/<pid>/cmdline`
    at **mode 444** on a stock Linux with no `hidepid`; combined with `open-terminal --cmd` not being
    in the confirm-gated `DESTRUCTIVE` set, that was arbitrary command execution as the victim from
    any account on the box. A remote command line is argv on **both** ends, so the same rule binds
    every `ssh`/`curl` we generate. Credentials travel by 0600 file or by **stdin**
    (`curl --config -`, already house style in `usage/remote-claude-usage.ts` and
    `codex-identity-proxy.ts`). Never add an argv fallback "for old curl" — that undoes the fix.
  - **Both raw listeners change together** — `src/main/index.ts` and `src/server/agent-status.ts`.
    A new field on the hook event (the `verified` flag was one) that reaches only the desktop leaves
    the Server Edition silently without the feature; the boundary tests cannot tell you a field is
    *missing*. `hook-verified-parity.test.ts` asserts it at source level because this repo has
    shipped a one-shell hook-server change three times.
  - **Every generated sh client reads the token through ONE resolver** (`nt_read_node_token`,
    `core/agents/node-token-sh.ts`) — the managed hook script, `nodeterm.sh` and `context.sh`. The
    token dir is advertised only by the endpoint FILE, and a session is pinned for life to the
    endpoint PATH it got at tmux creation, so a client that reads only what that file advertises
    presents nothing forever when the file is pre-v2 (SSH hosts' shared `~/.nodeterm/hook-
    endpoint.env`, whose per-project socket path is re-bound on every connect, so it stays LIVE) or
    unreadable (a phone-spawned session). Issue #384: the hook script FAILS OVER and re-reads the
    token from the endpoint it adopts, the two shims did neither — so the same node proved itself
    through one client and was refused through the other by the trust-on-first-proof latch, for the
    life of the session. The resolver falls back to `<dir of the endpoint file>/node-tokens` (the
    layout by construction on all three surfaces) and then the well-known data dirs; it is monotone
    — advertised dir first, keyed by node-id filename in every candidate, and a foreign instance's
    dir yields a foreign `kid` = `legacy` = exactly what presenting nothing already gave.
  - **A Codex HOOK under the shared app-server is identified by its PAYLOAD, not its env** (#1150,
    #1175). MEASURED on codex-cli 0.162.0 (private CODEX_HOME + tmux socket, a hook dumping env and
    stdin): a hook process is the DAEMON's child, carries the daemon's env and NEVER
    `CODEX_THREAD_ID` (only tool shells get that), and its stdin starts `{"session_id":"<thread>"`.
    So a scrubbed daemon ran every managed node's hooks with no node id (silent exit, #1150), and a
    daemon a plain `codex` pane started ran them under THAT pane's long-gone `NODETERM_NODE_ID`
    (#1175). The codex managed script (local only — remote scripts carry no prelude) now reads stdin
    FIRST, takes the LEADING `session_id` with builtins (anchored, so a nested one in tool input
    never matches), and hands it to the prelude (`hookPayloadThread`), where a record for that thread
    wins over an INHERITED node id and the stale endpoint vars are unset before the record's
    endpoint file is sourced. The one exception is a pane our launcher ran in-process
    (`nt_exec_plain` exports `NODETERM_CODEX_PLAIN=1`; never on a `--remote` exit): its env is its
    own and stands. Tool shells and both shims keep the old rule (a set id is never touched). The
    event is still verified against the bound node's 0600 token, so a forged payload buys nothing a
    same-user process could not already do. Residuals: a node launched with a bare `codex` (shared
    identity off) whose thread has ANOTHER node's record reports as that node; and a codex typed
    inside a marked plain pane's tool shell starts a daemon that carries the marker.
  - **Every LOCAL generated sh client recovers shared-Codex identity before its env gate.** A tool
    shell forked by the account-scoped app-server carries `CODEX_THREAD_ID`, not the pane's
    `NODETERM_*`. Managed hooks, local `nodeterm.sh`, and local `context.sh` therefore prepend
    `codexThreadIdentityResolverSh(codexThreadIdentityRoot())` before testing
    `NODETERM_NODE_ID`/`NODETERM_CANVAS_CONTROL`. Before this was shared, status hooks recovered the
    node while both user-facing shims declared that same first-class Codex session outside
    nodeterm. The SSH constants remain machine-neutral: the local record root is not valid on a
    remote host and must never be baked into its copy — enforced by
    `main/remote-ssh/remote-shim-neutrality.guard.test.ts`, two legs (the exported neutral bodies
    carry no record root or prelude, and `remote-hooks.ts` cannot even NAME a parameterised
    builder), because the failure is silent and one-sided: a remote shim carrying the prelude keeps
    working, and the only symptom is this machine's userData layout sitting in a file on someone
    else's server. **The prelude is shared; the RECORD it reads is desktop-only.** Those writers are
    the two hook-server handlers `src/main/index.ts` registers — and, since the daemon-reset work,
    the ones `wireServerCodexSharedIdentity` (`src/server/codex-shared-identity.ts`) registers at
    Server Edition boot as well. That shell used to answer a flat `shared: false`
    (`UNKNOWN_CODEX_IDENTITY_CAPS`) as a DELIBERATE degrade: its Codex nodes ran their own
    app-server, so no tool shell needed recovering. It no longer does. The Server Edition has the
    same local app-server, the same signed node tokens and the same persistent canvas store, so it
    wires the shared-thread spine **after** those secrets exist and its panes get the same
    supervisor. The registration is deliberately late for that reason, and `registerCodexIdentityIpc()`
    now answers from the live resolver instead of a constant — an early browser caller waits for the
    refresh rather than being pinned to a false "plain Codex" answer for the whole app run. What
    remains desktop-only is the record's REMOTE leg (SSH shims carry no record root or prelude, the
    paragraph above).
  - **That prelude EXPORTS WHAT THE RECORD SAYS — it never decides.** `NODETERM_AGENT_ID` and
    `NODETERM_CANVAS_CONTROL` were once constants there (`codex`, granted); both are
    `buildPtyEnv`'s answers about the PANE, which labels a node with its OWN agent id
    (`custom:<uuid>` for a custom agent whose `baseAgent` is codex, not `codex`) and gates the grant
    on `canControlCanvas`. The constants therefore mislabelled every custom codex-based node and
    asserted a grant that agrees with the pane only because
    `SHARED_IDENTITY_CAPABLE ⊆ CANVAS_CONTROL_CAPABLE` — a coincidence that list's own comment
    invites the next shared-identity agent to break, and breaking it hands a tool shell a capability
    its pane was denied. So the record carries `agentId` + `canvasControl` INSIDE the 6-tuple HMAC,
    and the prelude reads them; the grant is exported only when the record grants it and is left
    UNSET otherwise (absent, never `0` — the shape both shims' `[ -z … ]` gates expect). The **pane
    echoes its own label** on `/codex-thread/{start,bind}` (a tmux session outlives the app, so
    after a restart nothing server-side still knows what agent a node runs), but the **grant is
    never echoed**: the route derives it with `canControlCanvas`, so there is ONE decider and a
    forged id cannot manufacture a grant the table refuses. The three preimage generations are
    **selected by the record's shape, never tried in turn** — a record naming an agent must not
    verify under a preimage that ignores one — and a pre-agent record's implied `codex` + grant is
    keyed on the LINE being absent, never on the value being empty, so nothing that names an agent
    falls back to the guess. The env vars were never a security boundary in any case (anyone who can
    run the shim can `export` them by hand); the per-node token is, and
    `docs/shared-codex-node-identity.md` states that argument in full.
  - **A shell that forwards this identity cannot be type-checked into correctness.** A handler that
    destructures the request without `agent`, and a record write that omits its optional trailing
    argument, are BOTH well-typed — so the whole dimension can be plumbed through core, the route,
    the launcher and the prelude, pass `npm run typecheck` and every unit test, and ship INERT.
    `main/codex-identity-record-wiring.test.ts` pins it at source level, the same remedy
    `hook-verified-parity.test.ts` uses for the same class of hole.
  - Control/context endpoint discovery keeps a known node capability as a **routing rule, not an
    ownership proof**. A dead Desktop SSH tunnel must not redirect a command to a local Server
    Edition: its unsupported-edition response describes the wrong instance. The two shims use
    `nt_adopt_for_node` (`core/agents/hook-endpoint-failover-sh.ts`). The reference value is read
    from the PRIMARY endpoint's own token dir only — the one it advertises, else the adjacent
    `node-tokens` — never from the global search `nt_read_node_token` walks (that search exists to
    PRESENT a capability, #384; as a reference it let a Server Edition that opened the same
    project.json supply the "owner's" token whenever the desktop's token write had failed). Once
    that dir EXISTS, a candidate must hold the same value in its own dir — and when the reference
    is EMPTY (the write failed), a value proves nothing (a Server Edition that never heard of the
    node holds nothing too, and `"" = ""` relayed its permanent refusal, measured in review), so the
    candidate's token dir must be the same REAL directory (`pwd -P`) instead. Only a session with no
    such dir at all keeps legacy discovery. What a match shows is
    that the candidate reads the same token file for this node — on an SSH host that file is shared
    per unix ACCOUNT (`remote-hooks.ts`, KNOWN LIMITATION), so two desktops driving one account are
    indistinguishable here, and the receiving server still authorizes every request. Actual
    owning-endpoint refusals remain final. Skipped foreign candidates do not consume the
    three-attempt budget, and a skipped candidate restores the previous endpoint vars (the codex
    sandbox hint names `$NODETERM_HOOK_SOCK` as the socket to allow). Hook event delivery retains
    its existing independent failover policy.
    **Every FALLBACK candidate is probed before the real POST** (`nt_probe_endpoint`: `/hook/verify`,
    204 on the bearer alone on every server build, `--connect-timeout 0.5 --max-time 1.5`). A reverse
    tunnel whose sshd outlived the desktop's connection ACCEPTS and never answers, and once the
    foreign Server Edition stopped absorbing the walk, a call posted straight into such a socket
    hung. The bound is on the probe only: the primary is never probed and every real POST stays
    unbounded, because a confirm-gated verb waits for a human (see "two canvases cannot raise two
    dialogs" below). The probe writes into `$nt_out` like the POST would, so a 421 at the probe
    still prints its body (into /dev/null it left the control shim exiting 1 with an EMPTY stderr),
    and the control shim names a final 421 with `CONTROL_UNREACHABLE_MSG` as the context shim does.
    Consequence to know: while sshd still holds the session's OWN tunnel socket, the primary POST
    itself still hangs — unbounded by design, for the dialogs.
    **Measured on an SSH host (2026-09-28/29):** the desktop slept, the session's tunnel socket
    stayed on disk with no listener, and the walk reached an unrelated Server Edition whose
    `control-unsupported-on-this-edition … permanent … do not retry` (and, for context reads,
    "No linked nodes") was true about that server and false about the session; the tunnel came
    back minutes later. When a foreign candidate was skipped and no owner answered, the shims now
    print `FOREIGN_ENDPOINT_HINT` — the owning connection is unreachable, the state is temporary,
    the usual cause for an SSH project is the tunnel — INSTEAD OF `STALE_ENDPOINT_HINT`, so a failure
    carries one retry advice, not two. With nothing foreign skipped, a primary that is an SSH tunnel
    file (`~/.nodeterm/hook-endpoint*.env`, the only files the desktop writes there) gets
    `TUNNEL_DOWN_HINT` (reconnect) instead of the stale-endpoint advice (app restart); both hints
    open with the lead the bodies quote. All four agent-facing bodies quote its lead via
    `ownerUnreachableGuidanceLines`, because their other refusal lines rightly say "do not retry".
    `src/server/control-owner-tunnel-down.test.ts` rebuilds that host under real `/bin/sh` with the
    real Server Edition handlers as the foreign endpoint; `src/core/owned-endpoint-walk.test.ts`
    pins the probe (hanging sockets), the owner reference, the single advice and the restore, each
    mutation-checked.
  - **Every generated sh client walks the SAME endpoint failover** (`nt_candidates`/`nt_adopt`,
    `core/agents/hook-endpoint-failover-sh.ts`) — issue #445, the endpoint-level twin of #384: a
    session is pinned for life to the endpoint PATH it got at tmux creation, so an app
    quit/restart (or a retired project id) leaves it POSTing at a dead port while a live endpoint
    file sits right next to it. The managed hook script had the bounded candidate walk (locals
    before tunnels, `nt_fallback_max` 3, token re-read from the ADOPTED endpoint's dir); the two
    shims did not, so hook events healed themselves while every canvas-control verb died with
    "control endpoint unreachable" — in the field, a reviewer launch silently dropped. Now shared,
    one definition. Two server-side halves in `hook-server.ts`: a FAILED `listen()` un-wedges the
    singleton (it used to leave `this.server` set, making every retry a silent no-op at port 0)
    and `stop()` deletes only the endpoint contents this run published — a failed start cannot
    erase another owner's advertisement. A crash skips cleanup, which is why clients still walk
    the candidates.
    HTTP 421 means the bearer belongs to a different endpoint and is rejected BEFORE dispatch;
    it joins dead transport (curl 000/'') in the bounded discovery walk. A node-identity 403/400
    remains final and is never re-sent to another instance. The walk is skipped under
    `CODEX_SANDBOX_NETWORK_DISABLED` for transport failures (#367); an explicit 421 proves
    transport worked and still permits discovery. The final error distinguishes "no endpoint
    anywhere" from "an
    advertised endpoint that is not listening" (`STALE_ENDPOINT_HINT`). Desktop quit calls
    `hookServer.stop()` on the second before-quit pass, after the flush window.

  - **Hook endpoint ownership (#826):** startup first probes every transport in an existing
    endpoint advertisement and preserves a live or uncertain owner. The local Unix listener probes its socket before
    cleanup. Only `ECONNREFUSED` plus the same device/inode permits removal; a live listener,
    non-socket, symlink or uncertain probe disables hooks without replacing its endpoint.
    Both shells use `startForApp`: Desktop creates its window and then shows an actionable warning;
    Server Edition logs the same warning and continues boot. An authenticated owner must answer
    `/verify` with 204 for the advertised bearer AND reject a random bearer (403/421); unrelated
    HTTP responses are uncertain listeners, not authenticated nodeterm. Probes have a hard deadline.
    Endpoint writes are atomic and stop removes only the run's own advertised contents. SSH setup
    never removes a socket before binding: every forward gets a fresh random path, while discovery
    is stable per project + installation identity hash. Only a verified replacement is advertised;
    then this run cancels its previous forward. A legacy project endpoint is migrated only when its
    bearer matches the current run, the previous installation-qualified advertisement, or a stale
    conventional local advertisement retained at boot. Publication rechecks the snapshot digest,
    refuses symlinks, uses a migration lock and a private temp, and never places credentials in argv.
    Without ownership proof (including a first upgrade after the old local advertisement was deleted),
    it preserves the file and logs instructions to restart affected agent sessions; discovery still
    works but may incur the old dead-tunnel delay until then. No real-host upgrade is claimed by unit tests. A reused tunnel that loses bearer verification
    emits hook-only health updates: the desktop shows a warning and clears it after repair, without
    reconnecting terminals. These changes share the core listener in Desktop and Server Edition;
    the mobile wire protocol and node-identity rules are unchanged.

  - **A browser is refused before the bearer is looked at** (`core/agents/hook-browser-guard.ts`).
    The bearer stays the real gate; this is the belt beside it, against the one caller that can
    reach a loopback port without being a process of ours. A request carrying ANY `Origin` header,
    or a `Host` that is not `127.0.0.1` / `localhost` / `[::1]` (any port), gets 403 on both
    listeners, before the 403-vs-421 bearer distinction, so a DNS-rebound page learns nothing.
    MEASURED, every shipped client passes: curl over the socket sends `Host: localhost` (the codex
    launcher's socket URL sends `localhost:0`), curl over TCP `127.0.0.1:<port>` (the SSH TCP
    fallback arrives with the HOST's port — hence any port), Node's `http` over the socket
    `localhost`, Node's fetch no Origin (but `sec-fetch-mode: cors` — never refuse on that), Bun's
    fetch (opencode's runtime) no Origin. The SSH reverse tunnel forwards bytes, so a host-side
    curl's Host arrives unchanged. A request with no Host is let through (Node already 400s an
    HTTP/1.1 one; no browser sends one). **A new client must send no Origin and a loopback Host** —
    `hook-server.browser-guard.test.ts` drives the real transports and goes red otherwise.
  - **`~/.nodeterm` on an SSH host is 0700** (`privateRemoteDirCommand`, run by `setup()` on every
    connect and tunnel repair): created under `umask 077` and an existing one tightened, never
    through a symlink, never a directory the login user does not own (`-O`, which only a root login
    needs). The secrets inside were already 0600 one by one; the umbrella is so a future file written
    there without a mode is not born world-readable in a traversable directory.

  - **No keyring is not "no identity" (#1088).** Electron 42 on a Linux session without Secret
    Service/kwallet picks `basic_text` and `safeStorage.encryptString` THROWS (measured under xvfb).
    The desktop secret load used to reject on every boot ⇒ no node token was ever written ⇒ `send` /
    `settings` refused forever with no visible cause. The loader now falls back to the Server
    Edition's raw 0600 `node-auth-key.bin` when it cannot seal and no sealed key exists (a sealed key
    it merely cannot unseal still rejects — rotating it orphans codex thread records), and both shells
    record a failed arming via `hookServer.setNodeIdentityUnavailable`, which a verified-only refusal
    then names. A secret that cannot be stored must degrade to the weaker store, never to a feature
    that is silently off.

  Enforcement is dated (`NODE_IDENTITY_STRICT_AFTER`, 2026-10-13, read through `isStrictInstant` so a
  clock years ahead cannot enter strict mode early) with a `settings.hookIdentityStrict` escape hatch
  in Settings → Agents. **Trust on first proof latches a node the moment it authenticates, so it
  refuses TODAY, not on the cutoff** — which is why every token sweep must also call
  `hookServer.forgetProvenNode`. `/hook/*` never 403s a missing token: the phone, the cross-instance
  failover and every pre-token session legitimately have none.
- **Shared Claude/Gemini settings are user data (issue #851).** The local hook install/remove
  and Claude fullscreen writers share `core/agents/hooks/settings-file.ts`; SSH system/account
  hook installs and fullscreen writes share `remote-settings-file.ts`. Only ENOENT / the remote
  explicit missing-file status or a successfully read empty/whitespace file starts from `{}`.
  Malformed/non-object/read-error settings are preserved. Each transaction stages the complete output, takes a `.nodeterm-lock` directory,
  compares its original bytes before rename, and preserves the file mode. Remote snapshots and
  replacements travel on stdin, with a byte-count check against truncated transport; the shell
  needs no Python/Node/jq. Local profiles resolve symlinks and lock/update the shared target,
  rechecking resolution before publication. SSH does the same with plain readlink + cd -P
  (macOS-compatible, no GNU -f), bounding cycles and refusing dangling links/newline paths.
  Grok's owned file heals malformed JSON and hook shapes by rebuilding its managed config.
  A held or crash-left lock skips the update with a diagnostic naming the lock and instructing
  the user to stop writers before inspecting/removing a stale lock; it never gets stolen. External editors need not honor our lock: the final comparison detects edits
  during merge/staging, but cannot eliminate an external write between comparison and rename.
  No claim that the reporter's historical wipe was proven to take this path: the catch-to-empty
  writer and its data loss were reproduced in fixture homes.
- **Fullscreen TUI (Claude)** — through the SAME `settings.json` seam the hook installer uses,
  nodeterm ensures Claude's `"tui": "fullscreen"` so a session takes the alternate screen + mouse
  and behaves natively in tmux (else a drag falls into copy-mode). Two guardrails: **write-if-absent**
  (any existing `tui` value — e.g. a user's `/tui default` — is never touched;
  `core/agents/hooks/claude-tui.ts` `ensureFullscreenTui`) and **version-gated** to CLI ≥ 2.1.89
  (`supportsFullscreenTui` / `claudeCliCaps().fullscreenTui`; unknown ⇒ don't write). Runs
  everywhere the hook seam does: local `~/.claude` + managed account dirs at launch/add-account
  (`ensureClaudeFullscreenTui{,Into}`), and the remote host + account dirs on SSH connect
  (`RemoteHooks.ensureFullscreenTui{,InAccountDir}`, gated on the connection's cached remote probe).
  **Grok has no analogue** — it runs full-screen by default, so there is nothing to write.
