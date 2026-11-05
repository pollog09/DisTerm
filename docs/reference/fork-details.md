# Fork details and the project limit

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Fork details: what was cut and what turns it back on

**Help menu and issue reports.** Help → Report a bug and Documentation stay visible, disabled with a
reason (`renderer/lib/bugReport.ts`), and `BugReportDialog` has no route left to it. GitHub repository
opens `https://github.com/pollog09/GrafoTerm`. The `report-issue` verb refuses a project whose own
repository is upstream's (`report-upstream-repo`, `core/github/report-issue-service.ts`), so a clone of
upstream cannot file there. `canvas/help-menu.source.test.ts` pins the menu.

**What the fork cut:** the default update feed, the telemetry ping (`main/telemetry.ts`), announcement
banners and popups, the mandatory-update policy, the mobile launch card and the onboarding phone step,
the default relay and API base (so phone access, Team Access, hosted teams, Live Links and push are
off), store links (`mobileStoreLinks()` answers `[]`), the install and download infrastructure
(`scripts/install.sh`, curl one-liners, site feeds, `.github/FUNDING.yml`, the download badge), and
the automatic release trigger and feed verification in `release.yml`.

**The env vars that turn things back on, none with a default:** `NODETERM_RELAY_URL` (relay features),
`NODETERM_API_BASE` (relay tokens and push), `NODETERM_SERVER_INSTALL_URL` (Share with team's
installer), `NODETERM_REPO_URL` (`scripts/install-server.sh`, required on a first install; before any
fetch that script checks this and the checkout's real origin, case-insensitively, replacing an upstream
origin with this value when set and refusing otherwise). Note that
`core/license.ts`, `core/project-limit.ts` and `core/check.ts` read `NODETERM_API_BASE` too, so setting
it also moves those calls to that server, whatever else it is set for, and a check-shaped reply with
no `limits` key reads as "off" (`sanitizeLimits`). `LICENSE` clause (b) does not permit production use
of a copy whose license or usage-limit functionality was moved, changed, disabled or circumvented, and
permits changing it for non-production purposes such as developing and testing. A working relay needs
both variables. The README's "Off by default: anything that needs a relay" section carries this warning,
and the app's relay and push messages may point at it, so keep that heading stable.

## Free-tier open-project limit (shipped dormant; the server switches it on)

A non-Pro desktop install may keep FREE (a server value) projects open, a pre-cutoff install its
signed allowance; Pro is unlimited. Design, runbook, checklist: **`docs/project-limit.md`**.
- **One count**: `countOpenProjects` (`shared/project-limit.ts`) / `WorkspaceStore.openProjectCount`
  — in the workspace, not `closed`, not a relay tab. Never write a second one.
- **Never force-close.** The gate refuses a NEW open and nothing else; no project, node or tmux
  session is ever closed, deleted or detached because of the limit, even above the allowance.
- **Placement**: a human open calls `gateProjectOpen` (`renderer/lib/projectLimitGate.ts`) as the
  LAST await before its synchronous store mutation, skipped when `opensProject(...)` is false;
  allowed returns the literal `true` in the same tick, so while the limit is off every path stays
  synchronous with no network, dialog or write. The agent `open-project` verb decides and writes in
  one tick (`finishAgentProjectOpen`).
- **Relay tabs are never gated or counted**; `projectLimit:*` is host-only and `projectLimit:changed`
  reaches this machine's windows only. **The Server Edition has no gate** (stub answers inactive).
- `PROJECT_LIMIT_DEADLINE_MS` is bumped every release until the flip — release.yml refuses < 30 days.
