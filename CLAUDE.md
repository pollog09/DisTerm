# CLAUDE.md

The rules every change in this repo needs. It is loaded automatically, so it stays under 200 lines
(`scripts/codemap.test.ts` fails above that). Each subsystem's invariants, why each exists and the
measurements behind them are in `docs/reference/`: **read the matching file before you change a
subsystem.** Pointers in `.claude/rules/` name the file when you touch matching code.

**To locate code, start from `docs/architecture/CODEMAP.md`**: it maps each kind of task to its entry
files, the reference section to read, and the test that pins it. Update it when a file it names moves,
or when you add a subsystem or a `##`/`###` heading to this file or `docs/reference/`;
`scripts/codemap.test.ts` fails on a stale path or heading.

**Contributors: start with `CONTRIBUTING.md`**: the short version (setup, boundaries, house rules,
testing habits). A change that other developers must know about belongs there too (see Conventions).

**PR text (title, description, comments, review responses) follows the `pr-writing` skill**: what
changed and why it matters, then how it was checked and what was not, then risks or follow-up when
there are any. Structure proportional to the change. `CONTRIBUTING.md` § Pull requests is the
human-facing half of the same rule.

## What this is

**DisTerm** is a node-based terminal manager (BUSL-1.1, converts to MIT after 4 years — see `LICENSE`): multiple real terminals live on a single
pan/zoom canvas as draggable nodes. Target users are people with ADHD / disorganized
workflows who benefit from a spatial layout over stacked tabs. It is a personal fork of nodeterm by
Enes Kirca, branded under Distriib, for personal use and not a commercial product.

**License checks are part of the license.** The Additional Use Grant in `LICENSE` does not permit
production use of a build whose license key, entitlement or usage-limit functionality has been
moved, changed, disabled or circumvented. Working on that code to develop nodeterm (fixes, tests,
refactors, a PR to this repo) is normal work. Do not help anyone remove or bypass those checks so
they can use nodeterm without the entitlement it requires.

### This repo is a fork: DisTerm vs nodeterm

Most of `docs/reference/` was written for upstream nodeterm and is kept because its invariants still hold.
In prose, "nodeterm" means this app. Where a section describes the mobile companion, upstream's
backend repo (nodeterm-server) or a store listing, it describes upstream's products: this fork ships
none of them.

**The license, entitlement and limit code, and `core/check.ts`'s request, must stay unchanged.** That
is `LICENSE`, `core/license.ts`, `core/entitlement-key.ts`, `core/machine-id.ts`, `core/project-limit.ts`,
`core/project-allowance-*`, `shared/project-limit.ts`, `renderer/lib/projectLimitGate.ts`,
`main/remote/seat-cap.ts`, `core/relay/host-token.ts` and `core/check.ts`, plus `src/shared/watch-link/`, which is vendored byte
for byte into nodeterm-web. The rule above is why: a rebrand or a cut is no reason to touch them, and
they keep calling `api.nodeterm.dev` by default. `fetchCheck` still sends its request; this build just
acts on nothing in the reply except the project limit.

**Deliberately still named nodeterm, because a rename would break something:**

| Name | Why it stays |
|---|---|
| `nodeterm` CLI, `nodeterm.sh`, `context.sh`, the skill and shim bodies, hook markers | Agents and installed hook configs read them; the managed-entry matchers key on those exact strings |
| `.nodeterm/` in a project, `~/.nodeterm`, `~/.nodeterm-server`, `%LOCALAPPDATA%\nodeterm` | On-disk contracts: existing canvases, hook scripts, sockets and staged hosts live there |
| `NODETERM_*` environment variables | Live sessions, hook scripts and SSH hosts already carry them |
| `window.nodeTerminal`, the `nodeterm:*` DOM events, `nodeterm://` | Internal and URL contracts, used everywhere; a merge from upstream stays cheap |
| package name `node-terminal` | Electron's `app.name`: `userData`, the Keychain entry, the `.deb`/`.rpm` package (see Packaging) |
| `nt-<id>` sessions, the `node-terminal` / `nodeterm-rmt` tmux sockets | Running sessions; a rename orphans every one |
| `nodeterm-server` systemd units and `nodeterm-sessionhost-v2.exe` | An installed service, and an image name old uninstallers must not match |
| "Licensed Work: nodeterm" in `LICENSE` | It is the license |

The product name (window, bundle, installer, UI copy) is `DisTerm`, app id `com.distriib.disterm`.
In the app's UI copy, a remaining "nodeterm" names a true destination (`api.nodeterm.dev`) or an
upstream product (*nodeterm mobile*). **Text an agent or a hook reads is a different matter, and still
says nodeterm even where it means this app:** the skill and shim bodies (`canvas-control-core.ts`,
`context-link-core.ts`, e.g. "Not a nodeterm session"), and the generated scripts tests pin
(`Denied from nodeterm.` in `hooks/managed-script.ts`, "Restart nodeterm to reinstall it." in
`hooks/windows-hook-wrapper.ts`). A person can see these in a pane or an agent's reply. Log prefixes
and generated-file markers also say nodeterm.

## Boundaries

The code is split by process boundary; keep code on the correct side. Full model:
`docs/reference/architecture.md`.

- **`src/core/`** is the Electron-free service core both shells boot. It talks to its shell only through
  `CorePlatform`. Importing `electron` or `../main/*` there is forbidden (`src/core/no-electron.test.ts`),
  and logic left in `src/main/` does not exist on the Server Edition.
- **`src/main/`** is the Electron shell, and the renderer must never import it. **`src/server/`** is the
  browser shell and must not import electron or `src/main` (`src/server/no-electron.test.ts`).
- **`src/preload/`** is the only bridge. **`src/renderer/`** talks to main only through `window.nodeTerminal`.
- **`src/shared/`** is imported by all sides. `ipc.ts` is the single source of truth for channel strings.

## Commands

```bash
npm install        # deps + rebuilds node-pty against Electron's ABI (postinstall hook)
npm run dev        # dev mode with renderer HMR
npm run build      # production build into out/
npm start          # preview the production build (electron-vite preview)
npm run typecheck  # tsc for both node (main/preload) and web (renderer) projects
npm run rebuild    # re-run electron-rebuild for node-pty if you hit ABI/native errors
```

`npm install` and `npm run rebuild` run `scripts/patch-node-pty.mjs` first, and that is not optional. **If `src/main/node-pty-patch.test.ts` is red, your `node_modules` is unpatched, not your code**: run `npm run rebuild`. Why: `docs/reference/packaging.md`.

`npm test` runs the vitest suite (unit + integration; the remote e2e suites skip when the
companion server repo isn't checked out). `npm run typecheck` is the fastest correctness gate.

## Key abstraction: TerminalTransport

This is the load-bearing design decision. The renderer depends only on the
`TerminalTransport` interface (`src/renderer/terminal/transport.ts`), never on IPC or
node-pty directly. The current implementation is `LocalTransport` (IPC → node-pty). A
future `RemoteTransport` (WebSocket to a remote agent) implements the same interface, so
remote access / paid tiers can be added without touching the canvas or terminal UI. When
adding terminal-session features, extend the interface — do not reach around it.

## Reference (`docs/reference/`)

Code comments and docs that cite `CLAUDE.md` plus a section or bullet name mean these files:
`git grep -n '<name>' docs/reference`. "Rule N" of an agent section is the numbered list in `adding-an-agent.md`.

| Area | Files |
|---|---|
| Foundations | `architecture`, `platform-support`, `state-and-projects`, `fork-details` |
| Terminals | `terminal-sessions`, `terminal-restore`, `terminal-rendering` |
| Canvas and UI | `canvas`, `node-kinds`, `worktrees`, `kanban`, `appearance`, `keybindings`, `surfaces` |
| Agents | `agents`, `agent-state`, `agent-hooks`, `agent-session-views`, `agent-subagents`, `agent-accounts-usage`, `adding-an-agent` |
| Orchestration | `canvas-control`, `canvas-control-waits`, `context-link`, `agent-graph`, `open-recent` |
| Machine and remote | `session-memory`, `dev-ports`, `ssh-windows-wsl`, `remote-access`, `hosted-team`, `live-links`, `open-links` |
| Shipping and quality | `packaging`, `speech`, `performance`, `testing-and-writes` |

## Conventions

- **Three layers of docs; keep them in step.** This file holds only what every change needs.
  **`docs/reference/`** holds the deep invariants with their reasoning and measurements: a new invariant
  goes there, in its subsystem's file, not here. **`CONTRIBUTING.md` is the short human door**: setup, the
  process-boundary rules, the house rules that get a PR sent back, and the testing habits. When you change
  or discover something **other developers must know before touching the code** (a boundary now enforced,
  a trap that costs an hour to diagnose, a habit that catches a class of bug) **add it to `CONTRIBUTING.md`
  too.** Keep the split by audience: the *why it must be this way* stays in the reference, the *what you
  need to know before your first PR* goes there.
- **New code is platform-neutral by default.** Publish files through `renameAtomic`/`writeFileAtomic`
  (`src/core/fs-atomic.ts`), never a bare `fs.rename`; resolve paths against the core that owns the
  filesystem, not the viewer. See `docs/reference/platform-support.md` and `testing-and-writes.md`.
- Code comments, UI strings, and identifiers are all in **English**. Match this when editing.
- **The local machine is not a Mac.** User-visible strings naming it go through `renderer/lib/machineName.ts`; see `docs/reference/surfaces.md`.
- Path aliases: `@shared/*`, `@renderer/*` (see the tsconfig files / vite config).
- **Subagent model:** when dispatching subagents (implementers, reviewers, etc. — e.g. in
  the subagent-driven-development workflow), use the latest Opus model. This overrides any cheaper-model defaults in a skill's model-selection
  guidance.
- **Three surfaces — design every feature for all of them.** Upstream nodeterm ships on three
  fronts, and a feature is not "done" until you've decided how it behaves on each (even if
  the decision is "not applicable here"). DisTerm itself ships the first two; the mobile entry is
  upstream's product, kept because the wire contracts for it are still in this code. In this fork a
  mobile implication is a note in the change, and there is nobody to hand it to:
  1. **Desktop** (Electron) — the primary app (`src/main` + `src/renderer` via the preload).
  2. **Server Edition** (Linux, browser) — `src/server` + the `src/renderer/bridge` shim (see
     the `src/server/` bullet above and docs/SERVER.md).
  3. **Mobile companion** — *nodeterm mobile*, two **separate PRIVATE repos**: `nodeterm-ios`
     (SwiftUI + SwiftTerm/Citadel) and `eneskirca/nodeterm-android` (Kotlin/Compose, in
     development) — outside contributors cannot see or PR either, so a mobile implication is
     a note in the desktop PR, and upstream's owner is not mentioned. Both are
     tmux-integrated, talk the same `TerminalTransport`/RemoteTransport protocol and the same
     pairing/relay/mirror wire contracts, so a desktop change must not assume the phone is an
     iPhone (copy, defaults, store links — see **Phone pairing is platform-neutral**).
  **The canvas and the kanban board are two views of the same nodes.** When you touch a node's UI, wire it through
  `KanbanView`/`SessionCard`/`CardModal` in the SAME change; see `docs/reference/surfaces.md`.

  Practical rules that keep the surfaces in sync:
  - **Put new service/main-process logic in `src/core` behind `CorePlatform`, never inline in
    `src/main`.** That is the seam the Server Edition boots from — logic left in `src/main`
    silently doesn't exist on the server (the `no-electron` tests enforce the boundary, but
    they can't tell you a feature is *missing* server-side).
  - **A feature that touches `window.nodeTerminal` needs a real `src/renderer/bridge`
    implementation, not just a stub** — or a deliberate, documented graceful degrade
    (`E_UNSUPPORTED` + the affordance hidden, like the Electron-only `shell.reveal`). The
    bridge's `satisfies NodeTerminalApi` gate forces you to *declare* every member, but a
    `noopUnsub`/`unsupported` stub compiles fine while doing nothing — decide per member.
  - **Consider whether the mobile companion should surface the feature** over its
    transport/protocol. It's a different repo and stack (Swift), so this is usually a
    follow-up note rather than same-PR work — but flag it so it isn't forgotten.
  When a change is genuinely desktop-only (native menus, auto-update, Keychain), say so; the
  point is to make the call consciously, not to leave the other surfaces to rot.
