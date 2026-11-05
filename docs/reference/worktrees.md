# Worktrees

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Worktrees

- **Worktrees** (bound to **group frames**) — a git worktree binds to a group node
  (`data.worktree: GroupWorktree {repoPath, branch, baseRef, path, createdByApp}`, persisted), and
  every node created inside that frame inherits the worktree path as its `cwd`
  (`cwdForNewNodeIn`) — the frame *is* the binding, so an agent per branch is just a group per
  branch. Creation is **one step** — **"New worktree…"** from the pane menu / command palette /
  Source Control — with the repo resolved from the project cwd via `git.repoRoot()` and existing
  worktrees listed for adoption. (Both git IPCs existed before this feature and had **zero**
  renderer callers, which is why it was unusable: the dialog's repo field was always empty and had
  to be typed by hand. Don't re-strand them.)
  - **Default location** — `settings.worktreePathTemplate` is a machine-global Behavior setting,
    expanded only by `shared/worktree.computeWorktreePath` for both the dialog and canvas-control
    CLI. It is relative to the repo root and supports `$repoName` (`$reponame` /
    `$defaultFolderName` aliases) and `$branch` in bare or `${…}` form. If branch is omitted, its
    safe slug is appended automatically. The shipped `../${repoName}.worktrees/${branch}` keeps
    worktrees beside — not nested inside — the main checkout. There is no general project-settings
    surface today, so the setting is intentionally global rather than hidden in a one-off menu.
  - **One create-and-bind** (`renderer/lib/worktreeCreate.ts`, `createBoundWorktree`) — the New
    worktree dialog, the `open-worktree` verb and the issue card's "Start with agent in a new
    worktree" all create through it: `git worktree add` (a REJECTED call becomes a failure, never a
    throw out of the caller), then `attachWorktree`. The frame's place is asked only once git
    succeeded. `projectId` opts in to the "the canvas moved on during the await" refusal: the dialog
    and the issue action pass it; `open-worktree` does not, and still binds to whatever is on screen
    when git returns (unchanged, and a known gap). `git worktree add` is reached from ONE place
    (`worktreeCreateDeps`), pinned by `canvas/issue-worktree.source.test.ts`. Three same-tick rules
    the issue action rests on: `attachWorktree` writes the new frame into `nodesRef` beside its
    `setNodes`, so a caller can open a node INTO a frame it just made; it closes the frame's setup
    gate from the bind (`markGroupPending` before the `sharedPaths` materialize, released in a
    `finally` once `startWorktreeSetup` took its own count), so a node opened into it at once holds
    its launch — the hold is ONE rule, `setupHoldGroup`, shared with the control opens' `armAfter`;
    and `addAgentNode` parents the node BEFORE `setNodes`, never inside the updater, because the
    updater runs at render time and a zustand-flushed SyncLane render may already have mirrored
    `nodesRef` back to a list without the fresh frame (the `nodesEpoch` lesson).
  - **Where a worktree may land** (`@shared/worktree-location`) — `worktree.basePath` can come from
    `.nodeterm/settings.json`, the git-SHARED project settings file, i.e. written by anyone who can
    commit to the repository, and `git worktree add` writes the whole tree there. Pointed at
    `../../.claude/skills`, the issue card's one click checked the repo out into
    `~/.claude/skills/issue-N-…/` and a root `SKILL.md` became a skill in every Claude session. Two
    layers, both for ALL create paths (dialog, `open-worktree`, issue card):
    `sharedWorktreeLocationRefusal` (renderer) refuses a location the SHARED file produced unless it
    stays inside the folder holding the repository — a sibling that is not hidden, or anywhere in
    the repository but its `.git` — and names the fix (a local override in Project Settings). It
    judges only the path that setting derives for the branch: a path the person typed in the dialog
    or passed as `--path` is theirs. `sharedBasePathOf` is the one reading of provenance (`source:
    'shared'`). `open-worktree` refuses before its dry run. The core backstop
    (`core/worktree-target.ts`, in `GitService.worktreeAdd`, so relay and browser clients pass it
    too) works on REAL paths, because a symlink committed into the repository defeats any lexical
    rule: never inside the repository's `.git`, and never REDIRECTED into a hidden folder directly
    under the home directory — a location that names such a folder outright (a person's own
    `/home/me/.worktrees`) is allowed, so the backstop is not a blanket refusal.
  - **A worktree per GitHub issue** (`@shared/issue-worktree`) — "Start with agent in a new
    worktree ▸" on an issue card and its summary modal: branch `issue-<N>-<slug>` at the templated
    path, off the SAME base the New worktree dialog defaults to (`effectiveWorktreeBaseRef`: the
    project's base-ref override, else the MAIN CHECKOUT's current branch — not `origin/HEAD`; a main
    checkout parked on a feature branch forks from it, so the success notice names the base), a
    frame titled `Issue #N`, and the agent opened inside it with the same ref-only prompt and
    `issueRef` as "Start with agent" (one `issueStartPrompt`, one `fileIssueSession` for both). The
    frame's binding is what links a pull request from that branch to the session card. Whatever
    `addAgentNode` would refuse (canvas not the active project's, an unusable Codex account) is asked
    BEFORE git runs (`agentCreateRefusal`, same functions and wording) — a refusal after it would
    leave a fresh worktree with no agent. The agent's launch rides `pendingLaunch` held on the
    frame's setup gate, so it shows QUEUED for the moment the setup ack takes even when the project
    has no setup script. **The title is attacker-controlled**: the slug is
    an allowlist `[a-z0-9-]` (lower-cased, NFKD with marks stripped so `café` → `cafe`; every other
    script, lookalike, bidi or zero-width character is dropped), capped at `ISSUE_BRANCH_SLUG_MAX`
    (40) and cut back to a word boundary, and `issue-<N>` alone when nothing survives; the name only
    ever reaches git as one argv element, and the tests run the real `git check-ref-format --branch`
    over the hostile set. **Nothing on disk is overwritten**: `planIssueWorktree` (filesystem only
    through an injected probe; a probe that REJECTS reads as "taken" — the app's `fs.exists` folds a
    stat error into `false`, and git refusing a non-empty folder is the backstop there) offers REUSE
    of what the issue already has — a frame on this canvas bound to `issue-<N>` / `issue-<N>-…` (open
    the agent in it), an unbound worktree of the issue (adopt it, `createdByApp: false`), or the exact
    branch existing but checked out nowhere (check it out, under the branch's OWN spelling — the
    match is case-insensitive, git's lookup is not; the new folder is the app's, so `createdByApp`
    is true exactly as the dialog's "Existing branch" mode sets it) — beside the next free `-2` …
    `-20`; a name or folder that is merely taken moves to the next suffix and the notice says why.
    Never the main checkout, never a prunable registration, and never a frame bound to ANOTHER
    repository (`issueWorktreeFrames` filters by `worktree.repoPath`, as the worktree store does — a
    foreign or hostile frame on an `issue-<N>-…` branch would otherwise be the preselected "Reuse").
    A branch that exists only on a REMOTE (`status.remoteBranches`, as fresh as the last fetch) is
    TAKEN, never checked out: a same-named local branch would diverge from it, its push would be
    rejected, and #1008's branch link could point at someone else's pull request. Reuse is
    re-checked at the dialog's click (a frame of this repo on that folder now, else a worktree git
    still lists), and one `runExclusive` key per issue covers the planning AND a dialog-confirmed
    create, so a second click cannot race the first for the same `-2`. The reuse-or-new dialog is a
    tracked confirm (`confirmFlags.issueWorktree`, read by `confirmBusy()`): it never opens over
    another confirm, and an agent's destructive verb is refused while it is up. Disabled WITH its reason on a relay tab, an SSH project, a cwd-less
    project and a folder with no repository (`issueWorktreeRefusal`). **There is no `--worktree`
    flag**: an agent composes `open-worktree --branch issue-<N>-<slug>` then `open-agent --group
    <groupId> --issue #N`, and both agent bodies render that convention from `issueWorktreeBranch`.
    A flag was judged not worth it: the two calls already reach the identical end state; the
    "worktree already exists" question needs a person's answer, which an agent gets from `list`
    instead; the slug needs the issue title, which the control dispatch does not hold reliably (only
    a subscribed board does), so the flag would name one issue's branch two ways; and a second copy
    of `open-worktree`'s surface (`--base`, `--path`, dry run, setup holds, refusals) inside
    `open-agent` is the drift this file warns about. Surfaces: Desktop and Server Edition (the
    whole path is renderer + the existing git/fs/worktree bridges); a relay tab is refused (above);
    the Omni board has no issue lanes; Mobile N/A like every worktree affordance.
  - **One store, one poller** — `renderer/state/worktrees.ts` is the **only** caller of the worktree
    /status *read* IPCs (`git.repoRoot`, `git.worktreeList`, `git.status`); the group chip, the
    creation dialog and the Source Control panel all read that store. Three independent pollers would
    triple the `git` subprocess load and drift out of sync. It is **epoch-guarded** (a project switch
    bumps the epoch, so a stale in-flight refresh can never overwrite the newer project's
    `repoRoot`/orphans — worktrees are *created* under `repoRoot` and orphans are offered for
    *deletion*) and **fails open**. Exactly **two** direct `git.status` reads live outside it, both in
    `Canvas.tsx` and both deliberate: the one-shot probes on the **Remove** confirm (the dirty-file
    count in the warning) and on **↪ Move into worktree** (staleness only arrives by poll, so the
    directory is re-checked immediately before an irreversible session kill). Two more one-shot
    reads take only the local BRANCH list: the New worktree dialog's dropdown and the issue action's
    planner (so a taken name is seen before git refuses it). Anything recurring belongs in the store.
  - **Scoped Source Control** — the panel operates on a selected `ScmScope` (the main checkout or a
    bound worktree). A worktree scope's **id is its group node id**, which is what lets the canvas
    selection preselect it. `scmScopes` / `defaultScmScope` / `selectedScmGroupId`
    (`shared/scm-scope.ts`) decide the list and the default. The panel derives its `cwd` **once** so
    its ~49 call sites follow — and every Canvas callback it invokes (`onOpenDiff`,
    `onOpenCommitDiff`, `onExplainCommit`, `onRunInTerminal`) must take the **scope's** cwd, never
    the project's.
  - **Reconciliation** (`shared/worktree-reconcile.ts`) — bindings are reconciled against `git
    worktree list`: a worktree deleted outside the app makes its group **stale** (chip reads
    "· missing", Merge/Remove hide, ↪ hides, and nothing spawns into the dead path — Unbind is the
    only action, and it takes the dead cwd off the children with it); a worktree bound to no group
    is an **orphan**, recoverable from the creation dialog.
  - **Two non-obvious facts the code depends on — do not "simplify" these away:**
    1. `git worktree list --porcelain` **keeps listing a worktree whose directory was deleted
       behind git's back**, tagging it `prunable` — and that tag only exists on **git ≥ 2.36**. So
       `worktreeList` additionally **stats** each path through an injected `pathExists` seam
       (`prunable: e.prunable || !pathExists(path)`; `git-service` wires `fs.existsSync`), or the
       whole stale/orphan story silently fails on the Server Edition's own target platform (Debian 11
       / Ubuntu 20.04 ship git 2.30).
    2. **A failed git read is never evidence of absence.** `listWorktrees` returns `{ok, entries}`
       so "git failed" (spawn EAGAIN, NFS hiccup, corrupt index) stays distinguishable from "git
       listed nothing" — a transient failure must never be read as "the worktree is gone", at any
       layer (`ok:false` changes no facts). Staleness from the status poll likewise needs **two
       consecutive** failed reads (`WORKTREE_STALE_STRIKES`), and the streak is scoped per project
       so a there-and-back tab switch cannot forget it.
  - **Path identity** — compare worktree/repo paths through `worktreePathKey` (`shared/worktree.ts`),
    never by string: git prints `C:/r/wt` on Windows while a typed binding says `C:\r\wt` or `c:/…`.
    The key folds separators + case only for a Windows-SHAPED path (backslash, drive letter, UNC);
    a POSIX path keeps exact case — keyed on shape because this module runs in the renderer, whose
    platform is not the core's. The removal guard also refuses a bare drive root.
  - **Destructive safety** — `createdByApp` gates removal: nodeterm deletes only worktrees it
    created; one the user merely **adopted** unbinds by default, and deleting its directory is an
    explicit opt-in that **defaults to off** (its branch is kept either way).
    `isDangerousWorktreeRemovalPath` refuses a path that is the repo, `$HOME`, `/`, or an ancestor
    of any of them, on **every** removal path. **Merge** always confirms — it merges into the base's
    *working tree* (`decideMergeStrategy`: merge in the base's checkout when it is clean, else a
    `fetch . branch:base` when the base is checked out nowhere, else blocked) — and its push to
    `origin/<base>` is disclosed in that dialog and **opt-in, default off**: a push to origin cannot
    be politely undone.
  - **Every path that drops a bound group goes through unbind** — Unbind, Remove, **Ungroup** and
    **Delete** all route through `releaseWorktreeBinding`, the one place that knows what a dropped
    binding owes: `displacedByWorktree`'s descendants (terminals whose cwd sits inside the
    worktree) get that cwd taken off them, and git's registration gets a `pruneOnly` prune. Ungroup
    and group-delete *keep* the children, so skipping this left a **dead cwd persisted in
    `project.json`** — invisible until a reboot cold-starts the terminal into a directory that is not
    there — and left a stale registration that makes a later `worktree add` at the same path fail.
  - **SSH projects: not supported in v1** — every affordance is shown **disabled with that reason**
    (a silently-missing row teaches nothing). The gate asks whether the node is a **remote session**
    (`data.ssh` / `data.sshRemoteTmux`) or the project is an SSH project — **not** `data.remote`,
    which only *relay* nodes carry: guarding the wrong field let a live remote tmux session be
    killed into a local path that does not exist on the host (`isRemoteSessionNode` asks about all
    three). The ops themselves **refuse** a remote repo (`git-service.isRemoteRepo`, via
    `resolveGitRemote`) rather than guess: the `git` executor routes over the project's ControlMaster
    while `pathExists` is a **local** `fs.existsSync`, so answering would stat the wrong machine and
    report *everything is gone* — a refusal is a plain failed op and, crucially, never `worktreeGone`,
    so nothing is destroyed on a bad guess. Real support needs the worktree path to derive from the
    connection's cached `remoteHome` and `pathExists` to stat the **remote** fs (a `test -e` over the
    ControlMaster).
  - **Mobile companion: not applicable in v1** (the three-surfaces call, made deliberately). A
    worktree binds to a **group frame** on the canvas, and *nodeterm mobile* (separate repo, `nodeterm-ios`)
    has no canvas — it attaches to tmux sessions over the `TerminalTransport` protocol, which carries
    no group/binding concept at all. So there is nothing to degrade gracefully: a worktree's terminals
    are ordinary tmux sessions and mobile already reaches them, it simply cannot see that they belong
    to a worktree. Surfacing the binding (a read-only "worktree: <branch>" label per session, say)
    would mean extending the transport protocol — a **follow-up in the iOS repo**, not this branch.
    Creation/merge/remove stay desktop+server only: they are destructive git operations, and a phone
    is the last place to confirm one.
  - **Known follow-up** — the Explorer tree and the ⌘K file index stay scoped to the **project cwd**,
    so a bound worktree's files are not browsable/searchable from them (its terminals and editor
    nodes work fine). Deliberately out of scope here: both index a single root, and making them
    scope-aware is the same "which checkout am I looking at?" question Source Control already answers
    with `ScmScope` — that is the seam to reuse when it is built.
