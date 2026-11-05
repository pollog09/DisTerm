# Code map: where to start

"I need to change X: where do I start?" Hand-written, and checked by `scripts/codemap.test.ts`.

**Markup, which that test reads.** A backticked token starting `src/`, `test/`, `docs/`, `scripts/`, `build/`
or `.github/`, and the root files `CLAUDE.md`, `LICENSE` and `package.json`, is a repo path and must exist. Double
square brackets hold a `##` or `###` heading of `CLAUDE.md` or `docs/reference/`, verbatim: `git grep -n` it there.
Double brackets starting `grep: ` hold a literal string in those files, usually the start of a long bullet in a
section with no sub-headings. There are no line numbers because they drift.

## Orientation

Seven process contexts live under `src/`. `src/main/` is the Electron shell, `src/server/` the Server
Edition shell (Linux, browser), and `src/core/` the Electron-free services both shells boot through the
`CorePlatform` interface in `src/core/platform.ts`. `src/preload/` is the only bridge into
`src/renderer/`, the React UI, which talks only through `window.nodeTerminal`. `src/shared/` holds the
types and channel names all of them import, and `src/session-host/` is the standalone process that keeps
terminals alive where there is no tmux (Windows). Import rules: core and server must not import electron
or `src/main/`, and the renderer must not import `src/main/`. Logic left in `src/main/` does not exist on
the Server Edition. Sizes, subsystems, fan-in and boundary crossings are in
[GRAPH.md](GRAPH.md); which process talks to which, and where state lives, is in [README.md](README.md).

**DisTerm is a fork of nodeterm.** "nodeterm" in prose and in many names still means this app. Off by
default here: the relay (so phone access, Team Access, hosted teams and live links), push, and the update
feed. Read [[This repo is a fork: DisTerm vs nodeterm]] before renaming anything.

## Do not change

Per [[This repo is a fork: DisTerm vs nodeterm]], the license, entitlement and limit code must stay
unchanged, and `src/shared/watch-link/` is vendored byte for byte into nodeterm-web:

- `LICENSE` (root), `src/core/license.ts`, `src/core/entitlement-key.ts`, `src/core/machine-id.ts`
- `src/core/project-limit.ts`, and everything CLAUDE.md's `core/project-allowance-*` matches:
  `src/core/project-allowance-key.ts`, `src/core/project-allowance-token.ts`, `src/core/project-allowance-token.test.ts`
- `src/shared/project-limit.ts`, `src/renderer/lib/projectLimitGate.ts`
- `src/main/remote/seat-cap.ts`, `src/core/relay/host-token.ts`, `src/core/check.ts`
- `src/shared/watch-link/`

Context: [[Free-tier open-project limit (shipped dormant; the server switches it on)]], `docs/project-limit.md`.

## By task

### Terminals

| To change | Start in | Read in CLAUDE.md | Pinned by |
|---|---|---|---|
| tmux sessions, spawn, attach, kill | `src/core/pty-manager.ts`, `src/core/tmux-naming.ts`, `src/core/session-budget.ts` | [[Terminal session continuity (tmux)]] | `src/core/pty-exact-target.realtmux.test.ts`, `src/core/pty-tmux-wedged.realtmux.test.ts` |
| The terminal node, xterm, parking | `src/renderer/nodes/TerminalNode.tsx`, `src/renderer/terminal/terminal-config.ts`, `src/renderer/terminal/park-budget.ts`, `src/renderer/terminal/webgl-budget.ts` | [[Terminal node lifecycle (gotchas)]], [[Seeding a fresh xterm (`attachReplay` / `seedPaint` in `terminal/terminal-config.ts`)]] | `src/renderer/terminal/terminal-key-handler-parity.test.ts` |
| Terminal I/O seen by the renderer | `src/renderer/terminal/transport.ts`, `src/renderer/terminal/local-transport.ts` | [[Key abstraction: TerminalTransport]] | |
| Reboot recovery, scrollback replay | `src/renderer/terminal/cold-resume-session.ts`, `src/renderer/terminal/cold-self-heal.ts`, `src/core/scrollback-store.ts` | [[Cold restore (machine reboot)]], [[When a freshness verdict was a GUESS: the late cold-start check]] | `src/renderer/nodes/cold-resume-wiring.test.ts` |
| Zellij backend | `src/core/zellij-backend.ts`, `docs/session-backends.md` | [[Zellij as an optional local backend (`settings.sessionBackend`)]] | `src/core/zellij-backend.test.ts`, `src/core/pty-zellij-fold.test.ts` |
| Windows session host, ConPTY | `src/session-host/host.ts`, `src/session-host/protocol.ts`, `src/core/session-host-client.ts`, `src/core/session-host-runtime.ts`, `docs/windows-session-host.md` | [[Platform support]] | `src/core/session-host-client.test.ts`, `src/core/session-host-runtime.test.ts` |
| Session memory pill and panel | `src/core/session-memory.ts`, `src/core/session-memory-service.ts`, `src/renderer/components/SessionMemoryPanel.tsx` | [[Session memory (the RAM pill + the per-session panel)]] | `src/core/session-memory.test.ts`, `test/server/session-memory-e2e.test.ts` |
| Dev-server ports chip, forwarding | `src/core/dev-ports.ts`, `src/core/dev-ports-service.ts`, `src/core/remote-ssh/port-forward.ts`, `src/renderer/components/PortsChip.tsx` | [[Dev-server ports (the Ports chip + same-port SSH forwarding)]] | `src/core/dev-ports.realsh.test.ts`, `src/main/dev-ports-wiring.test.ts` |

### Canvas and nodes

| To change | Start in | Read in CLAUDE.md | Pinned by |
|---|---|---|---|
| Canvas behavior, menus, gestures | `src/renderer/canvas/Canvas.tsx` (the hub, ~20k lines; grep it), `src/renderer/lib/nodeActionItems.tsx`, `src/renderer/lib/addMenuSpec.tsx`, `src/renderer/components/ContextMenu.tsx` | [[Canvas interaction & panels (`Canvas.tsx` is the hub)]], [[grep: - **Context menus**]], [[grep: - **Add menu**]] | `src/renderer/canvas/canvas-wiring.test.tsx`, `src/renderer/lib/nodeActionItems.guard.test.ts`, `src/renderer/lib/addMenuSpec.surfaces.test.ts` |
| A node kind (add one: type, factory, renderer, reopen, add menu) | `src/shared/types.ts` (`NodeKind`), `src/renderer/state/workspace.ts` (factories, serializers), `src/renderer/nodes/`, `src/renderer/lib/reopenNode.ts`, `src/renderer/canvas/toKanbanSession.ts` | [[Node kinds (all rendered by React Flow custom nodes)]] | `src/renderer/lib/reopenNode.test.ts`, `src/renderer/lib/addMenuSpec.test.tsx` |
| Edges, ropes, context bridges | `src/renderer/lib/edgeModel.ts`, `src/renderer/lib/floatingEdge.ts`, `src/renderer/canvas/FloatingEdge.tsx`, `src/renderer/lib/noteLink.ts`, `src/shared/canvas-link.ts` | [[grep: - **Edges**]] | `src/renderer/canvas/edge-model.source.test.ts` |
| Layout: tidy, arrange, zoom, go to node | `src/renderer/state/workspace.ts`, `src/renderer/lib/nodeFocus.ts`, `src/renderer/lib/canvasLayout.ts` | [[grep: - **Tidy canvas keeps the orchestrator**]], [[grep: **"Go to node" (`goToNode` → `frameNode`)**]], [[grep: - **Canvas layouts**]] | `src/renderer/canvas/arrange-group.source.test.ts`, `src/renderer/lib/nodeFocus.policy.test.ts` |
| Browser and web nodes, webview keep-alive | `src/renderer/nodes/BrowserNode.tsx`, `src/renderer/nodes/BrowserSurface.tsx`, `src/renderer/lib/webviewKeepAlive.ts`, `src/main/browser-drive.ts` | [[Webview keep-alive across project switches (browser/web nodes)]], [[Browser control geometry (#539)]] | `src/renderer/nodes/browser-partition-parity.test.tsx`, `src/main/browser-ownership-source.test.ts` |
| Triggers, run nodes, simulator, whiteboard | `src/core/trigger-service.ts`, `src/core/run-service.ts`, `src/core/simulator/simulator-service.ts`, `src/core/whiteboards.ts` | [[grep: - **trigger**]], [[grep: - **Run node**]], [[grep: - **simulator**]], [[grep: - **whiteboard**]] | `src/core/trigger-service.test.ts`, `src/core/run-service.test.ts`, `src/core/simulator/simulator-service.test.ts`, `src/core/whiteboards.test.ts` |
| Colors, icons | `src/shared/node-colors.ts`, `src/renderer/components/NodeColorSwatches.tsx`, `src/shared/node-icon.ts`, `src/renderer/components/NodeIcon.tsx` | [[Node colors (one palette, two sections)]], [[Semantic colours (one role per meaning)]], [[Node icons (emoji, glyph or picture)]] | `src/renderer/components/NodeColorSwatches.guard.test.ts`, `src/renderer/styles.palette.test.ts`, `src/shared/node-icon.test.ts` |
| Theme, wallpaper, Liquid Glass | `src/renderer/styles.css`, `src/renderer/lib/glassContrast.ts`, `src/core/wallpaper.ts`, `src/renderer/terminal/glass-cell-backgrounds.ts` | [[Desktop wallpaper + Liquid Glass (Settings → Appearance)]] | `src/renderer/styles.liquid-glass.test.ts`, `src/renderer/styles.glass-traps.test.ts` |
| An animation, idle CPU | `src/renderer/styles.css`, `src/renderer/lib/canvasCovered.ts`, `src/renderer/terminal/board-render-pause.ts` | [[Idle energy: an animation is a frame loop, not a decoration]], [[Performance: measure it, then fix what the measurement names]] | `src/renderer/styles.animation-gate.test.ts`, `src/renderer/canvas/canvas-empty-changes.test.ts` |

### Agents

| To change | Start in | Read in CLAUDE.md | Pinned by |
|---|---|---|---|
| Agent status from hooks | `src/shared/agents/normalize.ts`, `src/core/agents/hook-server.ts`, `src/main/index.ts` + `src/server/agent-status.ts` (raw listeners), `src/renderer/state/applyAgentEvent.ts`, `src/core/agent-status-mirror.ts` | [[Agent support (Claude / Codex / Antigravity / Gemini / Copilot / opencode / Grok / custom)]], [[grep: - **State via each agent's hooks]], [[grep: - **Hook server (loopback HTTP)**]] | `src/core/agents/hook-verified-parity.test.ts`, `src/shared/agents/normalize.test.ts` |
| Hook installers, consent | `src/core/agents/hooks/index.ts`, `src/core/agents/hooks/managed-script.ts`, `src/core/agent-integrations.ts` | [[grep: - **Hook installers**]], [[grep: - **Agent-integration consent (#744)**]] | `src/core/agents/hooks/managed-script.test.ts`, `src/core/agents/hooks/install-helper.test.ts`, `src/core/agent-integrations-wiring.test.ts` |
| Per-node hook identity | `src/core/agents/node-identity-policy.ts`, `src/core/agents/node-token-service.ts`, `docs/node-identity.md` | [[grep: - **Per-node hook identity**]] | `src/core/agents/node-token-service.test.ts` |
| Capability lists, permission mode, model switch | `src/shared/agents/config.ts`, `src/shared/agents/approval-mode.ts`, `src/shared/agents/model-gateway.ts` | [[grep: - **Agent registry + capabilities**]], [[grep: - **Permission mode**]], [[grep: - **Model gateway / switcher**]] | `src/shared/agents/config.capabilities.test.ts`, `src/shared/agents/approval-mode.test.ts` |
| ⌘M chat view, transcripts | `src/renderer/nodes/ChatPanel.tsx`, `src/renderer/nodes/ChatComposer.tsx`, `src/core/transcript-ipc.ts`, `src/core/transcript-reader.ts`, one reader per agent (`src/core/codex-chat.ts`, `src/core/grok-chat.ts`, `src/core/gemini-chat.ts`) | [[grep: - **⌘M transcript view]] | `src/core/transcript-ipc.test.ts`, `src/renderer/nodes/chat-session-fallback-wiring.test.ts` |
| Subagent cards | `src/core/claude-subagent-lifecycle.ts`, `src/core/subagent-tail.ts`, `src/renderer/state/agentNodes.ts`, `src/renderer/nodes/SubagentNode.tsx` | [[grep: - **Subagent visualization**]], [[Subagent reload replay (#680)]] | `src/renderer/canvas/claude-subagent-wiring.source.test.ts` |
| Managed accounts | `src/core/claude-accounts-service.ts`, `src/core/codex-accounts-core.ts`, `src/main/codex-accounts.ts`, `src/shared/agents/account-binding.ts`, `src/renderer/components/settings/sections/AccountsSection.tsx` | [[grep: - **Managed Claude accounts**]] | `src/core/claude-accounts-service.test.ts`, `src/main/codex-accounts.test.ts` |
| Usage indicator | `src/core/usage/usage-service.ts`, `src/core/usage/remote-claude-usage.ts`, `src/renderer/components/UsageIndicator.tsx`, `src/renderer/lib/usageScope.ts` | [[grep: - **The usage indicator is scoped to the ACTIVE project**]], [[grep: - **Remote usage**]] | `src/core/usage/usage-service.remote.test.ts` |
| Pause, hibernation (Eco), restart in place | `src/renderer/terminal/agent-restart.ts`, `src/renderer/terminal/hibernation-policy.ts`, `src/renderer/lib/bulkPause.ts`, `src/renderer/terminal/live-work.ts` | [[grep: - **Agent hibernation ("Eco", 2026-08-12, OPT-IN default off)**]], [[grep: - **Bulk pause**]] | `src/renderer/canvas/bulk-pause-wiring.test.ts` |
| Open recent | `src/core/recent-conversations.ts`, `src/renderer/lib/recentConversations.ts`, `src/renderer/components/RecentConversations.tsx` | [[Open recent (resume a past agent conversation from its history)]] | `src/core/recent-conversations.test.ts` |

### Agent coordination

| To change | Start in | Read in CLAUDE.md | Pinned by |
|---|---|---|---|
| Canvas-control verbs (`nodeterm` CLI) | See the recipe below | [[grep: - **Canvas control (manage-nodeterm-canvas)**]], [[grep: **NO VERB MAY ACTIVATE A PROJECT TAB**]] | `test/acceptance/control-verb-disposition.test.ts`, `src/main/canvas-control-core.test.ts`, `src/main/canvas-control-shim.test.ts` |
| Messaging (`send`, `reply`) | `src/core/agents/agent-messaging.ts`, `src/core/agents/agent-message-decide.ts`, `src/core/agents/delivery-queue.ts`, `src/core/agents/pane-ownership.ts`, `src/shared/agents/agent-messaging.ts` | [[grep: **Message scope publication:**]], [[grep: **Direct Windows agent messaging:**]] | `src/main/agent-messaging.test.ts`, `src/core/agents/delivery-queue.test.ts`, `test/acceptance/message-scope-sync.test.ts` |
| `--after` and held launches | `src/renderer/lib/pendingLaunch.ts`, `src/renderer/terminal/launch-command.ts`, `src/core/headless-launch.ts`, `src/core/launch-claim-ledger.ts`, `src/core/station-handover.ts` | [[grep: **Dependency edges (`--after`, 2026-07):**]] | `src/renderer/lib/pendingLaunch.test.ts`, `test/acceptance/after-handover.test.ts`, `src/renderer/canvas/pending-launch-delivery.source.test.ts` |
| Station notices, reports | `src/core/agents/station-notice.ts`, `src/core/station-outcome-store.ts`, `src/shared/station-outcome.ts` | [[grep: **Station-failure notices]], [[grep: **Success waits]] | `src/main/station-notice-wiring.test.ts`, `src/main/station-outcome-wiring.test.ts` |
| State that survives a restart | `src/core/durable-state.ts`, `src/core/control-request-ledger.ts` | [[Durable orchestration state (queue, station reports, hand-over holds, request ledger)]] | `src/core/agents/delivery-queue.persist.test.ts`, `src/core/station-handover.persist.test.ts` |
| Context links | `src/core/context-link.ts`, `src/core/context-link-core.ts`, `src/core/context-link-render.ts`, `src/renderer/canvas/useContextLinkSync.ts` | [[grep: - **Context Link**]] | `src/core/context-link-render.test.ts`, `src/core/context-link.handler.test.ts` |
| Agent graph view, ship process | `src/core/agent-graph/event-log.ts`, `src/core/ship-config/discover.ts`, `src/renderer/lib/agentGraphModel.ts`, `src/renderer/lib/agentGraphLayout.ts`, `src/renderer/components/graph/AgentGraphView.tsx`, `docs/ship-graph.md` | [[Agent graph view and the ship process]] | `test/acceptance/agent-graph-real-hooks.test.ts`, `src/renderer/lib/agentGraphModel.test.ts`, `src/core/relay/agent-graph-policy.test.ts` |

### Project data

| To change | Start in | Read in CLAUDE.md | Pinned by |
|---|---|---|---|
| Workspace persistence, `project.json` | `src/core/workspace-store.ts`, `src/core/workspace-files.ts`, `src/core/workspace-watcher.ts`, `src/renderer/state/workspace.ts` (`nodeStatesToFlow`, `flowToNodeStates`) | [[State & persistence model]] | `src/core/workspace-store.test.ts`, `src/core/workspace-files.test.ts` |
| Project tabs, switching, close | `src/renderer/state/projects.ts`, `src/renderer/components/TabBar.tsx`, `src/renderer/canvas/nodesEpoch.ts`, `src/renderer/canvas/flowStoreOwner.ts` | [[Projects (tabs)]] | `src/renderer/state/projects.test.ts`, `src/renderer/canvas/nodesEpoch.test.tsx`, `src/renderer/canvas/flowStoreOwner.test.tsx` |
| Kanban board, card modal | `src/renderer/components/kanban/KanbanView.tsx`, `src/renderer/components/kanban/GlobalKanbanView.tsx`, `src/renderer/components/kanban/CardModal.tsx`, `src/renderer/components/kanban/ModalTerminal.tsx`, `src/renderer/lib/kanban.ts`, `src/shared/kanban-labels.ts` | [[grep: - **Kanban view**]], [[grep: - **Omni Kanban (global swimlanes)**]], [[grep: **The canvas and the kanban board are TWO VIEWS]] | `src/renderer/components/kanban/board-writers.guard.test.ts`, `src/renderer/lib/kanban.test.ts`, `src/renderer/components/kanban/cardModalSession.test.tsx` |
| GitHub issues and PRs on the board | `src/core/github/service.ts`, `src/core/github/client.ts`, `src/core/github/host.ts`, `src/core/github/integration.ts`, `src/renderer/state/githubIssues.ts`, `docs/github-issues-kanban.md` | [[grep: **Sync foundation]], [[grep: **Pull request CI, mergeability and links**]], [[grep: **Board dispatch]] | `src/core/github/service.test.ts`, `src/core/github/service.pulls.test.ts`, `src/renderer/lib/board-dispatch.guard.test.ts` |
| Worktrees | `src/renderer/state/worktrees.ts`, `src/renderer/lib/worktreeCreate.ts`, `src/shared/worktree.ts`, `src/shared/worktree-ops.ts`, `src/core/worktree-target.ts` | [[grep: - **Worktrees**]] | `src/renderer/state/worktrees.test.ts`, `src/shared/worktree-reconcile.test.ts`, `src/core/worktree-target.test.ts` |
| Source control panel, git | `src/core/git-service.ts`, `src/renderer/components/SourceControlPanel.tsx`, `src/shared/scm-scope.ts`, `src/renderer/state/scmCache.ts`, `src/core/remote-ssh/remote-git.ts`, `src/core/wsl-git.ts` | [[grep: - **Source Control**]] | `src/core/git-service.origin.test.ts`, `src/shared/scm-scope.test.ts`, `src/core/remote-ssh/remote-git.test.ts` |
| Explorer, files node | `src/renderer/components/ExplorerPanel.tsx`, `src/renderer/nodes/FilesNode.tsx`, `src/core/fs-ops.ts`, `src/core/fs-handlers.ts` | [[grep: - **Explorer**]], [[grep: - **files**]] | `src/server/handlers/fs-handlers.test.ts` |

### App shell

| To change | Start in | Read in CLAUDE.md | Pinned by |
|---|---|---|---|
| A setting | `src/shared/types.ts` (`Settings`), `src/core/settings-store.ts`, `src/renderer/state/settings.ts`, `src/renderer/components/settings/SettingsPage.tsx`, `src/renderer/components/settings/sections/`, `src/shared/settings-verb.ts` (what an agent may change) | [[grep: - **Settings**]], [[grep: **Settings (`settings`, 2026-09):**]] | `src/core/settings-store.test.ts`, `src/shared/settings-verb.test.ts` |
| A keybinding | `src/shared/keybindings.ts`, `src/renderer/lib/globalKeybindings.ts`, `src/main/keydown-intercept.ts`, `src/renderer/lib/keybindingOverrides.ts`, `src/renderer/components/ShortcutsPanel.tsx` | [[Keybindings (registry, overrides, dispatch)]] | `src/shared/keybindings.test.ts`, `src/main/keydown-intercept.test.ts`, `src/renderer/canvas/keybindings-handler-parity.test.ts`, `src/renderer/components/ShortcutsPanel.test.tsx` |
| Server Edition, sign-in | `src/server/index.ts`, `src/server/ws.ts`, `src/server/platform-server.ts`, `src/server/auth.ts`, `src/renderer/bridge/ws-bridge.ts`, `docs/SERVER.md` | [[Process model (Electron, three contexts)]], [[Server Edition sign-in (security audit 2026-10)]] | `src/server/no-electron.test.ts`, `src/server/http-auth.test.ts`, `test/server/server-e2e.test.ts` |
| Updater, packaging (no feed by default) | `src/main/updater.ts`, `src/shared/update-platform.ts`, `src/shared/update-gate.ts`, `src/renderer/components/UpdateCard.tsx`, `src/main/update-prep.ts`, `build/installer.nsh`, `.github/workflows/release.yml`, `package.json` (`build`) | [[Packaging & auto-update]] | `src/main/updater.no-channel.test.ts`, `src/shared/update-platform.test.ts`, `src/main/release-win-workflow.test.ts`, `src/main/info-plist.test.ts` |
| Speech, dictation | `src/core/speech/speech-service.ts`, `src/core/speech/register-ipc.ts`, `src/shared/speech.ts`, `src/renderer/components/DictationOverlay.tsx`, `scripts/patch-smart-whisper.mjs` | [[Speech / dictation (desktop + server)]] | `src/core/speech/speech-service.test.ts`, `src/core/speech/smart-whisper-patch.test.ts` |
| `nodeterm://` links | `src/shared/open-link.ts`, `src/main/open-link.ts`, `src/main/open-link-wiring.ts`, `src/renderer/components/OpenLinkSheet.tsx` | [[`nodeterm://` links (another app asks to open a node)]] | `src/shared/open-link.test.ts`, `src/main/open-link.test.ts` |
| Windows and window chrome | `src/main/index.ts`, `src/main/window-state.ts`, `src/main/window-chrome.ts`, `src/shared/window-chrome-metrics.ts` | [[grep: - **Window chrome**]], [[grep: - **Nothing raises the window without a user action**]] | `src/main/window-raise.guard.test.ts`, `src/renderer/styles.tabbar.test.ts` |

### Remote

| To change | Start in | Read in CLAUDE.md | Pinned by |
|---|---|---|---|
| SSH projects | `src/main/remote-ssh/ssh-project.ts`, `src/main/remote-ssh/remote-hooks.ts`, `src/core/remote-ssh/control-master.ts`, `src/shared/ssh.ts`, `src/renderer/state/sshConn.ts` | [[SSH connect: the ControlMaster is published BEFORE its setup chain]] | `src/main/remote-ssh/ssh-project.test.ts`, `src/main/remote-ssh/remote-hooks.test.ts`, `src/main/remote-ssh/remote-write.guard.test.ts` |
| In-process ssh2 transport (Windows) | `src/core/remote-ssh/native/native-mux.ts`, `src/core/remote-ssh/native/ssh-argv.ts`, `src/core/remote-ssh/native/native-runtime.ts`, `src/core/remote-ssh/native/native-pty.ts` | [[SSH projects on Windows: the in-process transport]] | `src/core/remote-ssh/native/native-mux.test.ts`, `src/core/remote-ssh/native/ssh-argv.test.ts` |
| WSL projects and terminals | `src/core/remote-ssh/native/wsl-endpoint.ts`, `src/core/wsl-hooks.ts`, `src/core/usage/wsl-usage.ts`, `src/core/terminal-profiles.ts`, `src/renderer/state/wslTerminals.ts`, `src/shared/wsl-project.ts` | [[WSL projects: a distribution as an SSH project]], [[Claude hooks in a plain WSL terminal (`core/wsl-hooks.ts`)]], [[Claude in a WSL pane: its usage, its launch, what it cannot do]] | `src/main/remote-ssh/wsl-endpoint.test.ts`, `src/main/remote-ssh/wsl-keepalive.test.ts`, `src/core/wsl-hooks.test.ts`, `src/renderer/canvas/wsl-terminal-entry-points.source.test.ts` |
| Relay and roles (off by default) | `src/shared/relay-availability.ts`, `src/core/relay/relay-host.ts`, `src/core/relay/access-policy.ts`, `src/core/relay/scoped-guest-policy.ts`, `src/shared/host-control.ts`, `src/renderer/bridge/relay-api.ts` | [[Remote access (phone relay) — free, not Pro]], [[grep: **In DisTerm the relay is off by default.**]] | `src/core/relay/access-policy.guard.test.ts`, `src/core/relay/scoped-guest-policy.guard.test.ts`, `src/core/relay/relay-host.core.test.ts` |
| Hosted team (off by default) | `src/core/relay/hosted-service.ts`, `src/core/relay/team-admin.ts`, `src/server/team-cli.ts`, `src/main/remote/hosted-join.ts`, `src/renderer/session/relay-tab.ts`, `docs/hosted-team-relay.md` | [[Hosted team relay (Server Edition as a relay host)]], [[grep: **Shared canvas authority**]] | `src/server/hosted-e2e.test.ts`, `src/core/relay/team-admin.test.ts`, `test/acceptance/hosted-relay-agent-status.test.ts` |
| Share with team (off by default) | `src/renderer/lib/shareSshTeam.ts`, `src/main/remote-ssh/share-team.ts`, `src/core/remote-ssh/share-team-remote.ts` | [[grep: **Share with team (SSH → hosted team)**]] | `src/renderer/lib/shareSshTeam.test.ts`, `src/core/remote-ssh/share-team-remote.test.ts` |
| Team presence, canvas sync | `src/core/canvas-sync.ts`, `src/core/canvas-authority.ts`, `src/shared/canvas-mutations.ts`, `src/shared/canvas-content.ts`, `src/renderer/canvas/collab-sync.ts`, `src/core/presence/`, `docs/team-presence.md` | [[grep: **Shared canvas authority**]] | `src/core/canvas-sync.test.ts`, `src/core/canvas-authority.test.ts`, `test/server/presence-e2e.test.ts` |
| Phone pairing and host (off by default; the phone apps are private repos) | `src/main/pairing-service.ts`, `src/main/pairing-core.ts`, `src/main/remote/standing-host.ts`, `src/main/remote/host-service.ts`, `src/main/remote/approved-devices.ts`, `src/shared/pair-qr.ts` | [[grep: - **One relay pin store per ROLE]], [[Standing phone consent lifetime (#819)]] | `src/main/pairing-service.test.ts`, `src/main/remote/host-relay-parity.test.ts`, `src/main/remote/peer-revoke.test.ts` |
| Live links (off by default) | `src/core/watch-link/service.ts`, `src/core/watch-link/link-host.ts`, `src/core/watch-link/watcher-policy.ts`, `docs/live-links.md`; `src/shared/watch-link/` is do not change | [[Live links (Pro browser link to one terminal: watch, chat, or type)]] | `src/core/watch-link/service.test.ts`, `src/renderer/lib/live-link.guard.test.ts` |
| Push webhook (off by default) | `src/core/push-webhook.ts`, `src/shared/push-webhook.ts`, `src/renderer/components/settings/sections/PushWebhookPanel.tsx` | [[Push webhook (a script or CI job rings the paired phone)]] | `src/core/push-webhook.test.ts`, `src/shared/push-webhook.test.ts` |

## Recipes

### Add an IPC channel

Trace `IPC.recentConversationsList` for a complete example.

1. `src/shared/ipc.ts`: the channel string. Never hardcode one elsewhere.
2. `src/shared/types.ts`: the method on `NodeTerminalApi`.
3. Handler: `platform().handle(IPC.x, …)` in a `register…` function in `src/core/`, called from both
   `src/main/index.ts` and `src/server/index.ts`. A desktop-only channel is a raw `ipcMain.handle` in
   `src/main/`; say why, and give the browser a deliberate degrade.
4. `src/preload/index.ts`: the `ipcRenderer.invoke`.
5. `src/renderer/bridge/ws-bridge.ts`: the browser's real implementation, or a documented degrade in
   `src/renderer/bridge/stubs.ts`. `satisfies NodeTerminalApi` only forces the member to exist, so a stub
   compiles while doing nothing.
6. `src/renderer/bridge/relay-api.ts`: does a relay tab reach the host's core, or stay on this machine?
7. Relay policy, deny by default:
   - `src/shared/host-control.ts` if no relay peer may ever call it.
   - `src/core/relay/access-policy.ts` (`VIEW`, `COMMENT`, `EDITOR_ONLY`, `VIEW_EVENTS`) for roles.
     `src/shared/hosted-access.ts` mirrors `VIEW` and `COMMENT`.
   - `src/core/relay/scoped-guest-policy.ts` (`SCOPED`, `SCOPED_REFUSED`) for a one-project guest.
   - `src/core/relay/relay-project-scope.ts` if its name starts `githubIssues:`, `board-log:` or `projects.`.

Guards: `src/core/relay/access-policy.guard.test.ts` and `src/core/relay/scoped-guest-policy.guard.test.ts`
fail on an unclassified channel used by the relay builders, and `src/main/remote/relay-project-scope.test.ts`
on a scoped-class channel with no row. `src/renderer/bridge/ws-bridge.namespaces.test.ts` covers some
namespaces only; nothing catches a channel with no browser implementation in general.

### Add a canvas-control verb

1. `src/core/canvas-control-core.ts`: the verb list and the agent-facing text (`buildCanvasSkillBody`,
   `buildCanvasControlInstructions`), in the same change as the behavior.
2. `src/core/agents/hook-server.ts`: the `/control/` route, identity and ledger are here. Desktop:
   `src/main/index.ts` (`setControlHandler`) and `src/main/control-forward.ts` forward to `Canvas.tsx`.
3. `src/renderer/canvas/Canvas.tsx`: a `case` in the `onAgentControl` switch.
4. `src/renderer/lib/controlRouting.ts` and `src/shared/control-off-screen.ts`: what it does off screen.
   Decide this for every verb; none may activate a project tab.
5. Flags refused for shape go through a gate in `src/shared/`, for example `src/shared/arrange-verb.ts` or
   `src/shared/geometry-verbs.ts`, called from desktop main too, since it does not run `parseControlRequest`.
6. Server Edition: an unlisted verb gets the named refusal by default. To support it, add it to
   `SERVER_V1_VERBS`, a `case` and an action type in `src/server/control-unsupported.ts`, then implement the
   action in `src/server/canvas-control.ts`, usually with `src/server/headless-node-factory.ts`.

Confirm-gated verbs: `src/shared/control-verbs.ts` is only a drift alarm; the confirm is hand-written in the
`case`, and `src/renderer/canvas/control-destructive.test.ts` checks that the two agree.

### Add an agent

Read [[Adding a new agent (or a new model) — what to watch out for]] first; every rule there is a past bug.
`docs/grok-agent.md` and `docs/cursor-agent.md` show the expected write-up.

1. `src/shared/agents/config.ts`: `AGENT_CONFIG` and the capability lists. Grep every consumer of a helper
   before adding an id to its list.
2. `src/shared/agents/normalize.ts`: its native hook events to `NormalizedAgentEvent`.
3. `src/shared/agents/hook-events.ts`: one event list, shared by all installers.
4. `src/core/agents/hooks/index.ts`: the registry entry and an installer, such as `src/core/agents/hooks/grok.ts`.
5. `src/main/remote-ssh/remote-hooks.ts`: the host-side install, or stay in `LOCAL_ONLY_HOOK_AGENTS`.
6. Only if it applies: `src/shared/agents/approval-mode.ts`, `src/core/transcript-ipc.ts` (chat routing).

## Traps

Confirmed repo-wide rules a change most often breaks.

- **Publish files with `renameAtomic` or `writeFileAtomic`, never `fs.rename`** (`src/core/fs-atomic.ts`). Guard: `src/core/fs-atomic.guard.test.ts`. Remote writes go through `src/main/remote-atomic-write.ts`, never a bare `cat >`. Guard: `src/main/remote-ssh/remote-write.guard.test.ts`.
- **Change both raw hook listeners together**: `src/main/index.ts` and `src/server/agent-status.ts`. Guard: `src/core/agents/hook-verified-parity.test.ts`.
- **Service logic goes in `src/core/`, not `src/main/`,** or the Server Edition does not have it. Guards: `src/core/no-electron.test.ts`, `src/server/no-electron.test.ts` (boundary only; neither sees a missing feature).
- **The canvas and the board are two views of one node.** Node menu rows have one builder. Guard: `src/renderer/lib/nodeActionItems.guard.test.ts`. Writers of a board are enumerated, and a turn ending never moves a card: `src/renderer/components/kanban/board-writers.guard.test.ts`.
- **A new relay-reachable channel must be classified.** Guards: the two policy guards in the IPC recipe.
- **No control verb moves the user's view.** Guard: `test/acceptance/control-verb-disposition.test.ts`.
- **A new `nodeterm:*` event needs a listener,** since a dispatch with none is a silent no-op. Guard: `src/renderer/lib/nodeterm-events.test.ts`.
- **A new node kind must be restorable or listed as not.** A kind in neither place makes a dead reopen entry that typechecks (`src/renderer/lib/reopenNode.ts`). Pinned by `src/renderer/lib/reopenNode.test.ts`.
- **A new `CoState` field joins the equality list in `setCo`,** or its banner never renders. Guard: `src/renderer/nodes/cold-resume-wiring.test.ts`.
- **Every tmux target is exact** (`exactPaneTarget`, `exactSessionTarget` in `src/core/tmux-naming.ts`), because a bare name prefix-matches another session. Pinned by `src/core/pty-exact-target.realtmux.test.ts`; nothing scans for a new bare target.
- **Do not rename what must stay nodeterm**: the table in [[This repo is a fork: DisTerm vs nodeterm]]. The package name `node-terminal` is `userData`, the Keychain entry and the Linux package. Pinned in part by `src/main/app-name-labels.source.test.ts` and `scripts/uninstall.test.ts`.
- **User-visible copy does not say "this Mac".** Use `src/renderer/lib/machineName.ts`. Guard: `src/renderer/lib/machineName.guard.test.ts`.
- **Nothing raises the window without a click.** Guard: `src/main/window-raise.guard.test.ts`.
- **Tests stay sandboxed.** Use `src/core/test-tmp.ts`, and mock the `os` module rather than spying on `os.homedir`. Normalize CRLF when slicing a checked-in file. Guards: `src/core/test-tmp.guard.test.ts`, `src/core/test-home.guard.test.ts`, `src/core/tmux-socket-isolation.guard.test.ts`, `src/shared/line-endings.guard.test.ts`.

## Reference index

Every `##` and `###` heading of `CLAUDE.md` and `docs/reference/`, by topic. `scripts/codemap.test.ts` fails if a heading is cited nowhere in this file (a task row counts, not only this index) or a cited one is gone.

**Start here:** [[What this is]], [[This repo is a fork: DisTerm vs nodeterm]], [[Boundaries]], [[Commands]], [[Reference (`docs/reference/`)]], [[Conventions]], [[Fork details: what was cut and what turns it back on]], [[Surfaces: machine naming and board parity]]

**Architecture:** [[Platform support]], [[Process model (Electron, three contexts)]], [[Key abstraction: TerminalTransport]], [[State & persistence model]], [[Projects (tabs)]], [[Durable orchestration state (queue, station reports, hand-over holds, request ledger)]]

**Terminals:** [[Terminal session continuity (tmux)]], [[Cold restore (machine reboot)]], [[When a freshness verdict was a GUESS: the late cold-start check]], [[Zellij as an optional local backend (`settings.sessionBackend`)]], [[We have our own VT emulator — check it before asking tmux]], [[Seeding a fresh xterm (`attachReplay` / `seedPaint` in `terminal/terminal-config.ts`)]], [[Character widths — one table for every emulator (`@shared/terminal-width`)]], [[Terminal node lifecycle (gotchas)]], [[IME mode switching (#680)]], [[Session memory (the RAM pill + the per-session panel)]], [[Dev-server ports (the Ports chip + same-port SSH forwarding)]]

**Canvas and nodes:** [[Worktrees]], [[Kanban board]], [[Node kinds (all rendered by React Flow custom nodes)]], [[Browser control geometry (#539)]], [[Webview keep-alive across project switches (browser/web nodes)]], [[Canvas interaction & panels (`Canvas.tsx` is the hub)]], [[Media playback lifetime (#680)]], [[Node colors (one palette, two sections)]], [[Semantic colours (one role per meaning)]], [[Node icons (emoji, glyph or picture)]], [[Desktop wallpaper + Liquid Glass (Settings → Appearance)]], [[Keybindings (registry, overrides, dispatch)]]

**Agents:** [[Agent support (Claude / Codex / Antigravity / Gemini / Copilot / opencode / Grok / custom)]], [[Agent state, context meter and permission mode]], [[Agent hooks and integration consent]], [[Agent session views: alerts, names, search and the ⌘M chat]], [[Subagents, loops and branching]], [[Canvas control: verbs, routing and confirms]], [[Canvas control: waits, headless start, settings and notices]], [[Context Link]], [[Managed accounts and usage]], [[Adding a new agent (or a new model) — what to watch out for]], [[Open recent (resume a past agent conversation from its history)]], [[Subagent reload replay (#680)]], [[Agent graph view and the ship process]], [[Speech / dictation (desktop + server)]]

**Remote:** [[SSH connect: the ControlMaster is published BEFORE its setup chain]], [[SSH projects on Windows: the in-process transport]], [[Claude hooks in a plain WSL terminal (`core/wsl-hooks.ts`)]], [[Claude in a WSL pane: its usage, its launch, what it cannot do]], [[WSL projects: a distribution as an SSH project]], [[Remote access (phone relay) — free, not Pro]], [[Standing phone consent lifetime (#819)]], [[Hosted team relay (Server Edition as a relay host)]], [[Live links (Pro browser link to one terminal: watch, chat, or type)]], [[Push webhook (a script or CI job rings the paired phone)]], [[`nodeterm://` links (another app asks to open a node)]], [[Server Edition sign-in (security audit 2026-10)]]

**Shipping and limits:** [[Packaging & auto-update]], [[node-pty patches (`scripts/patch-node-pty.mjs`)]], [[Free-tier open-project limit (shipped dormant; the server switches it on)]]

**Quality rules:** [[Atomic writes (never a bare `fs.rename`)]], [[Idle energy: an animation is a frame loop, not a decoration]], [[Performance: measure it, then fix what the measurement names]], [[The test suite never touches a live tmux server]], [[The test suite leaves nothing in the OS temp dir]], [[The test suite never touches the real home]]

### Inside the longest sections

These have few or no sub-headings, so grep the bullet in `docs/reference/`.

- [[Agent support (Claude / Codex / Antigravity / Gemini / Copilot / opencode / Grok / custom)]]: [[grep: - **Agent registry + capabilities**]], [[grep: - **Permission mode**]], [[grep: - **Hook server (loopback HTTP)**]], [[grep: - **Hook installers**]], [[grep: - **Canvas control (manage-nodeterm-canvas)**]], [[grep: - **Context Link**]], [[grep: - **Managed Claude accounts**]], [[grep: - **⌘M transcript view]], [[grep: - **Subagent visualization**]], [[grep: - **Grok**]], [[grep: - **Antigravity**]], [[grep: - **Gemini + codex parity**]]
- [[Canvas interaction & panels (`Canvas.tsx` is the hub)]]: [[grep: - **Context menus**]], [[grep: - **Add menu**]], [[grep: - **Edges**]], [[grep: - **Explorer**]], [[grep: - **Source Control**]], [[grep: - **Worktrees**]], [[grep: - **Kanban view**]], [[grep: - **Omni Kanban (global swimlanes)**]], [[grep: - **Settings**]], [[grep: - **Window chrome**]]

## When to update this file

Update it when a file it names moves, when you add a subsystem or a `##` or `###` heading to `CLAUDE.md` or `docs/reference/`, or when
a new guard pins a rule listed here. `scripts/codemap.test.ts` catches paths and headings that went stale. It
cannot catch a row that has become wrong while still resolving, or a new subsystem with no row.
