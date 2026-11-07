# Kanban board

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Kanban board

- **Kanban view** (`components/kanban/KanbanView.tsx`; toggle is the **Kanban tab**, first in the bar after the brand and outside the
  scrolling strip (`.tab--kanban`, plus ⌘⇧B / ⌘K; it opens the all-projects board, Omni below, and this
  per-project board is that board's "This project" scope; a project tab keeps only its canvas and graph view
  buttons, and clicking the active project's tab while its board is up returns to its canvas; earlier
  homes were the tab-strip end, the controls-cluster, then an icon on the active project tab): per-project
  full-page board OVER the canvas. It is **dual-source** (PR #90): SESSION cards are the project's
  session nodes (React Flow type `terminal`), derived LIVE from the canvas nodes
  (title/color/kind/agentId), with RUNNING / NEEDS YOU badges + unread dot from the default
  `agentStatus` store (click = back to canvas + `focusNodeById`); GITHUB cards are the repo's
  issues (`GitHubIssueCardView` via `state/githubIssues.ts`, opened through
  `GitHubIssueSummaryModal`, a column move that closes/reopens the issue confirms first). A
  **source filter** (`KanbanSourceFilter`: All / Issues / Pull requests / Sessions) and a transient
  per-board **label filter** narrow what shows.
  **PULL REQUEST cards are harvested from the issue poll, not fetched** (2026-09-01, read-only):
  `/repos/{repo}/issues` returns pull requests too — `client.listIssues` used to `continue` past
  them — so keeping them costs ZERO extra requests and inherits the incremental `since` watermark,
  the heartbeat ETag (below), the 60 s poll and the cache snapshot the issue lane already has. The alternative was
  measured and rejected: **`/repos/{repo}/pulls` IGNORES `since`** (a day-old `since` returned the
  same 100 items as none), each item is ~25 KB against ~7 KB, and it would be a second
  ETag/paging/cache lineage — for `head`/`base` and nothing else (mergeable, reviews and checks are
  per-PR legs either way). The harvest's fields are `draft` and `pull_request.merged_at` (**the only
  thing separating merged from closed** — both report `state: 'closed'`), plus the labels/assignees
  the issue shape already carries. There is **no `head`** in that payload: `GitHubPullMeta.head`
  stays undefined until something asks per branch (`/repos/{repo}/pulls?head=owner:branch`), which
  is one request per question rather than a field on every poll.
  Three rules the harvest brought with it: **(1)** one snapshot now holds both kinds, so
  `GitHubIssueQuery.kind` (absent = `'issue'`) is what keeps the issue lane's items and counts
  byte-identical to before — and `moveIssue` refuses a PR by number (`invalid-target`) because the
  two share a number space and its membership check alone would hand one to a write path that
  cannot serve it. **(2)** `MAX_ISSUES` / the 64 MB bound are shared, so an overflow **evicts pull
  requests first, oldest-updated first** (`evictPullsToFit`) and marks the snapshot
  `pullsTruncated`; the existing `incomplete` read-only path fires only if the issues ALONE still
  miss the bound. A repository large enough to overflow degrades in the new half, never in the
  board it already had. An incremental pass carries the flag forward — it never re-fetches what it
  dropped, so only a full reconciliation may clear it. **(3)** the `pulls` source is `readOnly` in
  the registry: no drag, no move control, and its page reports `readOnly: true` on the wire rather
  than trusting every consumer to remember.
  **Sync foundation: what a poll costs, what a failure means, what a write needs** (2026-09-28,
  `core/github/*`; Desktop and Server Edition identical — all of it is core). Seven rules:
  **(1) A poll that finds nothing spends nothing.** Before each pass, `client.issuesHeartbeat` asks
  for the single most recently updated item (`state=all&sort=updated&direction=desc&per_page=1`)
  with `If-None-Match`; a 304 skips the scan. MEASURED against this repo (read-only `gh api`):
  twenty 304s moved `x-ratelimit-used` by **0**, the next 200 by 1; five plain 200s by 5. The `since`
  scan could never do this itself — `since` moves every pass, so its URL (and any ETag) never
  repeats, and the snapshot's `etags` map was declared and always written empty. The validator is
  the one read BEFORE the scan (a change landing mid-scan stays "new"), it is persisted in
  `snapshot.etags.heartbeat` (a restart does not pay a full read), and a 304 NEVER skips a full
  reconciliation (a deletion or transfer does not move the top item) or an incomplete repository.
  It covers pull requests by construction: same endpoint, same `updated_at` the scan filters on.
  **Only a completed scan advances the incremental cursor** (`lastSuccessfulRefreshAt`, the next
  scan's `since`): a board write folds its one confirmed issue into the snapshot and leaves the
  cursor alone. It used to set it to the write's time, so a third party's change landing between the
  last scan and our write fell outside the next `since` window until the daily full pass.
  **A 304 still prompts the board to re-read** (an empty delta, served from the local cache, no
  GitHub cost) exactly as every successful refresh always did: a page is not only issues — read
  only, the mapping approval and the completion column are derived by the host at query time, and
  the first version, which emitted nothing on a 304, left a board read only after its user
  approved the mapping (review of #1001). Approve and revoke also notify the project's open boards
  at once (`service.notifyProject`). **Unknown `state_reason` values decode as no reason**: GitHub
  added `duplicate` (one of cli/cli's last 100 closed issues, measured 2026-09-29), and the strict
  decoder failed that repository's whole scan as malformed — it never synced.
  **The credential check is conditional too** (`createTokenValidator`): every poll re-resolves the
  credential (30 s memo, 60 s poll), and each resolve was an unconditional `GET /user` — one real
  request per poll even after the heartbeat. With `If-None-Match` an unchanged identity is a free
  304 (MEASURED: ten conditional reads, +0), and a bogus token presenting a valid validator still
  gets 401. Idle polling now costs zero quota. **(2) The budget is read from every response and
  acted on before GitHub refuses.** `client.onRateLimit` reports `x-ratelimit-*` from 200, 304 and
  errors alike to `GitHubRequestCoordinator.noteRateSample`, keyed by the credential's identity
  (the host builds the client from token + userId); within one window the LOWEST reading wins. A
  spent `core` budget blocks new requests at once. Below `backgroundFloor(limit)` = max(100, 10%)
  the BACKGROUND poll stops until the window resets — the budget is the whole account's (`gh`, the
  browser, other tools) — while a refresh the user asks for still runs within its own floors.
  **Every wait is capped** (`MAX_RATE_WAIT_MS`, 10 s in TOTAL): past it the request is refused at
  once with its retry time, instead of holding one of four read slots and an IPC call for up to an
  hour. The page and the Settings status carry the `throttle`; both say "held until HH:MM"
  (`lib/githubSyncStatus.ts`), and subscribers are prompted once per deadline, not per skipped
  minute. Do NOT add a `/rate_limit` probe: measured for the same token in the same second it
  answered 5000 left / used 0 with a different reset time than the response headers (4968 / 32) —
  the headers are the truth. **(3) Throttled is not signed out.** `classifyGitHubFailure`
  (`core/github/failure.ts`) is the ONE classifier: only a 401 or a non-rate-limit 403 is
  `unauthorized`; network, timeout, 5xx and malformed bodies are `unreachable`; limits are
  `rate-limited`. Token validation is tri-state (`TokenValidation`); the resolver keeps the last
  credential GitHub vouched for — SAME token only — through an unknown answer, and with none throws
  a `GitHubReachabilityError` rather than returning the null that every caller reads as "sign in".
  Auto does not fall through to the saved token when the CLI's token merely could not be checked
  (that would switch identities for the length of an outage). **`gh auth status` is never run**:
  measured on gh 2.45 with GitHub unreachable it printed "The token in hosts.yml is invalid";
  `gh auth token` only reads the local store and our own classified `/user` check decides.
  Settings says "GitHub could not be reached to check the sign-in" and keeps the last confirmed
  sign-in on screen; `saveToken` refuses an unchecked token without calling it invalid.
  **(4) A close carries its reason.** `UpdateIssueInput.stateReason`: the close confirm offers
  Completed / Not planned (Completed preselected — GitHub's default), a reopen sends `reopened`.
  It rides ONLY with a state change (the "send `state` only when it changes" rule stands), the
  client refuses a reason of the wrong kind, and a close GitHub recorded with a different reason is
  not reported as confirmed. **(5) Writes need an approval that covers the column mapping.** The
  mapping (which label a column applies, which column closes) is in the git-shared project.json,
  so a pulled commit could re-aim writes under an approval given for something else. An approval
  records `githubMappingDigest(repository, completionColumnId, columnMappings)` — column ORDER and
  titles excluded (they change nothing GitHub sees; `config.revision` includes order and would make
  every column drag revoke writes). Moves and "Create missing labels" require the digest to match
  (`context.mappingApproved`); READS stay on the repository approval, since the mapping only decides
  what a write does. A mismatch makes the board read only and says why (`page.mappingNotApproved`);
  Settings offers "Approve column labels". **Upgrade:** an approval from before this change has no
  digest — it keeps reading and must be approved once more before the board writes. Pinning the
  on-disk mapping at first load was rejected: it would silently trust whatever a `git pull`
  delivered between the upgrade and that load. **(6) Revoke deletes the cache.** The plaintext
  issue cache (bodies included) is removed by the same bounded path as "Clear cached data", AFTER
  the revoke is recorded — a failed delete is reported (`revoked-cache-kept`), never left approved.
  The cache file is per (identity, repository), so another project on this machine bound to the
  same repository re-fetches too. **(7) Every client that leaves releases its subscription.** The
  service polls every 60 s per subscribed repository; the desktop window now releases on `closed`,
  `render-process-gone` and `did-navigate` (`main/renderer-client-release.ts` — not
  `did-start-navigation`, which also fires for a navigation the guard blocks), beside the relay
  peers and Server Edition sockets that already did. **Mobile: N/A** — the phone's board carries
  session cards only (the `githubIssues:*` channels are served to relay TABS, never the phone
  dialect), so nothing there can read a throttle as signed out; surfacing GitHub cards on the phone
  would need this whole contract carried over the relay.
  **Pull request CI, mergeability and links** (2026-09-29; core `graphql-pulls.ts` +
  `pull-status-tracker.ts`, shared `github-pull-status.ts` + `kanban-pull-links.ts`, renderer
  `lib/pullLinks.ts` / `lib/pullAutoMove.ts` / `lib/pullChase.ts`). The issues harvest cannot say a
  PR's head, checks or mergeability, so ONE GraphQL read per repository adds them: every open PR's
  `headRefName`/`headRefOid`/`isCrossRepository`/`isDraft`/`mergeable`/`mergeStateStatus`, the head
  commit's `statusCheckRollup`, `closingIssuesReferences`, plus the 30 most recently merged/closed
  PRs (so a branch link survives the merge). MEASURED on this repository (60 open PRs): **1 point**
  of the separate `graphql` budget, ~18 KB; the per-PR checks read (modal open only) is also 1.
  **When it runs:** after a heartbeat that reported a change, on a user refresh, on the first
  heartbeat of an app run, when the last read failed or the budget skipped one (`owed`) — never on a
  304 otherwise. A finished check run does NOT move the heartbeat, so an UNDECIDED PR (mergeable
  UNKNOWN or rollup PENDING/EXPECTED — measured: 40 of 50 open PRs read UNKNOWN on a first read, all
  settled 20 s later, because the first read is what starts GitHub's computation) is CHASED at
  30 s / 1 min / 2 min / 5 min, at most 12 reads per episode, and only while a board is VISIBLE: the
  renderer asks (`githubIssues.chasePulls`) every 15 s while `document.visibilityState` is visible,
  and the host answers from a map — schedule, cap and the synchronous `claimChase` live in core, and
  no context (credential chain) is resolved unless a read is due. A new undecided PR or a new head
  starts a new episode; the same stuck PR does not restart the count. **Semantics, each a shipped
  bug somewhere:** a null rollup is "no checks" and renders NOTHING (never a tick); only
  `mergeStateStatus === 'CLEAN'` is "Ready to merge" (MERGEABLE+BLOCKED is real: 2 of 31 here);
  a rollup counts only at the current `headRefOid`, and a CI result is never carried from an older
  head; a failed read keeps the last snapshot marked stale (`pullStatusFreshness`, greyed after
  15 min); a FORBIDDEN/INSUFFICIENT_SCOPES answer for the rollup or mergeability HIDES that region
  (`access`), which is not the same as a null rollup. Enum values (`mergeable`, rollup `state`,
  `mergeStateStatus`) decode LENIENTLY: a value GitHub adds later claims nothing and is not chased,
  and an unrecognised rollup state is `UNRECOGNIZED`, never `null` ("no checks") — one new value
  must not fail every read of the repository (it happened with `state_reason: duplicate`). **Budget:** GitHub meters `graphql` apart from
  `core`, and so does the coordinator now — `throttle(identity, at, resource)`, a primary limit is
  tagged with its resource (`GitHubClientError.resource`, from `x-ratelimit-resource`, or GraphQL's
  200-with-`RATE_LIMITED`) and holds only that resource; an untagged (secondary) limit still holds
  the identity. A spent graphql budget (the user's own `gh pr list` spends it) must not stall REST
  issue sync. **Links:** PR → issue = GitHub's own `closingIssuesReferences` (same repository only),
  deliberately NOT unlinkable on the board — GitHub closes the issue at merge whatever the board
  shows. PR → session card = the PR's head equals `data.worktree.branch` of the card's nearest bound
  group (`worktreeBranchOf`, no git read; a stale binding still names the branch, which is exactly
  when its PR merges); a FORK PR never links (36 of 50 open PRs here are forks). Unlinking writes a
  git-shared tombstone in `ProjectKanban.pullLinks` — a BOARD-LEVEL field on purpose: every card-meta
  setter rebuilds `meta[]` entries from a fixed field list, so a field added there is erased by the
  next member/due/label edit. On an SSH project NO card carries a worktree branch
  (`kanbanSessionsFrom` leaves it off where the cards are built), so the card face, the move and
  the modal — which states the worktree reason — cannot disagree. PR → issue → session card: a session started on an issue (`data.issueRef`, below) links to
  every PR whose `closingIssuesReferences` name that issue, matched against the pull board's own
  `repository` (a `closes` number means nothing in another repository); here a FORK PR does count —
  GitHub's "Closes #N" is meaningful wherever it comes from. The host memory remembers what a PR
  closed while open, so the link survives the merge that should move the card; the same tombstones
  apply, and an issue-bound card on an SSH project still links this way (only the branch half needs
  a worktree group).
  **What this machine observed lives on the HOST** (`core/github/pull-memory.ts`, persisted beside
  the issue cache per identity + repository, deleted with it): every PR it has seen, its head, its
  lifecycle, whether it was seen open, and `mergedSeenAt` — the first time it was seen merged AFTER
  being seen open (an OBSERVED merge). The read lists only 50 open + 30 recent PRs, so without it a
  closed-unmerged PR's block would expire once 30 newer PRs closed; remembered PRs stay on the pull
  board (closed ones until unlinked, merges for 30 days) and an unlisted one takes its lifecycle
  from the REST harvest. The first version kept a per-card "seen" map in settings.json instead, and
  review found three failures in that shape: the planner's output exceeded the sanitizer's bounds so
  the hook rewrote settings in a loop until React threw; the block expired; and two Server Edition
  tabs both moved the card while a background tab's settings write reverted another tab's changes.
  **Merge-driven move — session cards only, OFF by default.** The switch, the target column and
  `armedAt` are MACHINE-LOCAL (`settings.kanbanPullAutoMove.projects[projectId]`, written ONLY by
  the user's own Settings action): it makes this machine write the shared board on its own, so a
  switch in the project file would make every clone move and commit cards nobody on that machine
  asked for. Per-card opt-out is board content (`pullLinks.noAutoMove`). Guards in order
  (`decidePullAutoMove`): opted out → never; any linked PR open/draft → wait; any closed unmerged →
  blocked until the user unlinks it; already in target → nothing; no linked merge with
  `mergedSeenAt >= armedAt` → no move (arming never sweeps old merges; `armedAt` is taken from the
  HOST's clock via the pull board's `now`, because `mergedSeenAt` is stamped there and a Server
  Edition browser's clock can be off). Each planned move must then win the host's one-time CLAIM
  (`githubIssues:claim-pull-auto-move`, persisted in the same memory) — the first ask across every
  window wins, and a card dragged back is not moved again for the same merges. **Claims are
  recorded PER PR (project + card + PR), never per PR set**: the linked set changes on its own (a
  merged PR ages off the pull board, another PR on the branch joins), and a set-keyed claim read
  every such change as a new transition and moved a dragged-back card again. A claim is granted only
  for a PR that has not moved this card yet; set keys an earlier build wrote are read as a claim on
  each PR they list. The board asks each (card, PR set) ONCE while it is in flight or after it was
  won, and re-asks a REFUSED one only after `REFUSED_CLAIM_RETRY_MS` (60 s: the host also refuses
  transiently, before it is bound to the project or while it clears its cache, and remembering that
  for the board's lifetime lost the move); a failed call is forgotten. It re-plans only when a field
  the planner reads changes — it used to send a claim per canvas change for a dragged-back card. **The claim is refused unless THIS card was
  noted waiting on one of those PRs while it was open** (`githubIssues:note-pull-waits`; the host records a note only for a PR it holds as open
  itself): `mergedSeenAt` is a fact about the PR, and without the per-card note a card that first
  appeared after the merge — a follow-up terminal in the same group, a teammate's card by git pull,
  an issue-bound session started later — would win a fresh claim and jump to Done. It is then
  applied as a compare-and-set on the column
  the decision saw (`applyPullAutoMove`, run by Canvas against the store's latest board), writing
  ONE `card-moved` board-log line whose `title` names the PRs. The planner writes nothing; it runs
  only while the board is open and never on a stale snapshot. **GitHub issue cards are never
  auto-moved** — GitHub already closes them when a `Closes #N` PR merges, and a second writer would
  race it and could clobber `state_reason`.
  Surfaces: Desktop + Server Edition identical (core + renderer; `githubIssues:pull-status`,
  `:chase-pulls`, `:pull-checks`, `:claim-pull-auto-move` are registered by the shared core handlers
  and served to relay tabs through the project-scope table; a relay tab never auto-moves — the
  board belongs to the other machine). Check detail is bounded for relay guests: one read per PR per
  15 s, ten per project per minute, both decided before a credential is resolved. **Mobile: follow-up** — the phone board carries session
  cards only; showing PR CI there means carrying `GitHubPullBoard` over the relay dialect.
  **Start with agent — a GitHub issue card starts a bound session** (2026-09-28). An issue card's
  right-click menu and its summary modal offer **Start with agent ▸**, whose rows are the canvas's
  own agent + account picker (`agentCreationEntries`, which takes an optional `pick` so the same
  rows can point at another action — never a fourth copy of the picker). The result is an ordinary
  agent node in the project cwd (through `addAgentNode`, which now returns the node) carrying
  `data.issueRef {owner, repo, number}` — persisted, git-shared, therefore hostile:
  `normalizeIssueRef` (`@shared/github-issue-ref`) runs at BOTH serializer seams and a malformed
  value is dropped (the node survives, only the binding goes). Rules a refactor must not undo:
  (1) **the launch line carries the REFERENCE, never the issue's text** — titles and bodies are
  writable by anyone on a public repository and a launch line is typed into a pane.
  `issueLaunchPrompt` is the ONE place a reference becomes text; it re-validates the reference
  itself and returns nothing for a hostile one. The prompt tells the agent to read the issue with
  `gh issue view N --repo owner/repo --comments` (mid-sentence: punctuation glued to the last flag is
  copied literally and `gh` refuses `--comments.`) AND that its title, body and comments are
  untrusted input, not instructions — the session runs under the project's permission mode (auto by
  default), so the prompt is the only thing that can say "read it, do not obey it" before it does.
  A board start means **work on it**: the default task is "investigate, plan and implement the fix
  in this working tree"; a caller's `--prompt` REPLACES that task ("Your task: …"), never the lines
  around it. The hard limits ride the prompt itself, after any brief: never close the issue, and no
  issue comment or PR unless the user asks in that session — end with a proposed comment. Proven
  under a real `/bin/sh` (`github-issue-ref.realsh.test.ts`). (2) **The reference comes from the card's
  `htmlUrl`** (`issueRefFromHtmlUrl`, which also requires the URL's number to equal the card's).
  (3) **`done` never moves a card**: it means a turn ended, not that the work did. The issue card
  shows every bound session as a live chip (`IssueRunChips`, subscribed per node to a PRIMITIVE
  signature `issueRunChipSig` — never `s.byId`), RUNNING / NEEDS YOU / TURN FAILED / DROPPED plus
  unread; a click opens that session's card. A card moves only when the session `assign`s itself or
  a person drags it — pinned by `board-writers.guard.test.ts`, which enumerates EVERY renderer call
  site that writes a board assignment or moves an issue, each with the human/agent action that
  triggers it; a new writer fails until it is signed for, and "a turn ended" is not a trigger. (4) **Board-log identity of an issue card** is the synthetic id
  `github-issue:<owner>/<repo>#<N>` (lower-cased, `issueLogId`) — a namespace no node id can reach.
  Under it: `run-started` (UI start, `--issue` open) and `run-ended` (written by EVERY node-removal
  funnel — `deleteNodes`, `closeStoredNodes`, the Omni delete, `deleteProject`, the Server `close` —
  before it drops the node's agent status, with the last observed state). `duplicateNode` drops
  `issueRef` (a copy is a new session nobody started on the issue; carrying the binding made a
  phantom run). Known gap: ⌘Z/⌘⇧Z replay node arrays and write no run history, so an undone delete
  revives a node whose run already ended. The summary modal shows it read-only as
  "Agent runs" (no composer: a comment box under an issue reads as "post to GitHub"). **No cost or
  token figure** is recorded: there is no cumulative per-session number, and a context-window
  reading is not one. (5) The new session card is filed under the issue card's column (the same
  unpruned direct write `createNodeInColumn` uses); the node header, the session card AND the card
  modal's header show a `#N` chip (`IssueRefChip`; the modal's closes itself and makes the same
  request) that opens the issue on the board (`openIssueOnBoard` →
  `viewMode.requestedIssue`) ONLY when that board has GitHub sync — otherwise straight to GitHub,
  rather than flipping the project's persisted view to a board that cannot show it — and the board
  itself falls back to GitHub when the issue is not on a fetched page. Never a dead click. **"Start
  with agent in a new worktree ▸"** sits beside it on the card menu and in the summary modal: a
  fresh `issue-<N>-<slug>` worktree frame with the agent inside, reuse offered when the issue
  already has one — see the Worktrees bullet ("A worktree per GitHub issue"). Surfaces: Desktop + Server Edition (renderer + core); Omni board shows no
  issue lanes; **Mobile does not render the binding** — `issueRef` reaches the phone inside the
  project file, and nodeterm-ios ignores the unknown field (follow-up there).
  **Board dispatch — a card THIS person moves into the dispatch column starts its own run**
  (2026-09-30; `@shared/board-dispatch` consent, `renderer/lib/boardDispatch.ts` decisions,
  `state/boardDispatch.ts` queue, wired in Canvas `dispatchOnUserMove` / `drainDispatchQueue`). The
  run is exactly "Start with agent" — `issueRef` binding, the reference-only `issueLaunchPrompt`,
  `fileIssueSession` (card filed + `run-started`) — only nobody clicked it. The hard question is WHO
  may trigger a run on this machine, and the answer shapes everything else:
  - **The trigger is the person's own move in this app**, never a fact that arrives from outside.
    `decideDispatch` answers `ignore` for every origin but `'user-move'`, and the only caller that
    says `'user-move'` is the board's move-result path (`KanbanView.moveIssueByUser` →
    `onIssueMoved`, reached only from `requestGitHubMove` and the close/reopen confirm). A label
    set on GitHub (by anyone — on a public repository, ANYONE) reaches this app only as a refreshed
    page, and a board change arriving by `git pull` only as a new project file; neither has a path
    in. A move GitHub did not CONFIRM (`stale`, `failed`, `read-only`, …) is not a dispatch.
    `lib/board-dispatch.guard.test.ts` pins the WHOLE chain: `decideDispatch`'s one caller,
    `onIssueMoved`'s one firing site, `dispatchStart`'s two callers (after `decideDispatch` in
    `dispatchOnUserMove`, after `recheckQueued` in the drain), and that a `'queued'` entry — which
    the drain starts without asking `decideDispatch` again — is created only in `dispatchOnUserMove`.
  - **Why not a label with an actor allowlist** (the other design considered): it works from a
    phone, but it needs one issue-events read per candidate issue (budget), compares an actor
    against a credential that can change under it, and today the poll runs only while a board is
    subscribed — a network-derived fact standing in for consent, and no run at all when nobody has
    the board open. That is the follow-up, not v1.
  - **Consent is machine-local** (`settings.boardDispatch`, the `kanbanPullAutoMove` / trigger arm
    store tier), never `.nodeterm/project.json`: a switch in the project file would let a pull
    request make every clone start agents. Per project: the column, the agent, an optional account
    (absent = the project default through the same funnel as "New <agent>"), a cap (1–8, **default
    1**: dispatched runs are told to implement the fix in the project's own working tree, so two at
    once are two agents editing one checkout), and a **binding**.
  - **The consent binds what the column MEANS, not just its id** (`dispatchBinding`: repository +
    column title + its GitHub label). Titles and labels live in the git-shared project file, and
    titles are deliberately outside `githubMappingDigest` — so without it a pulled commit swapping
    the titles of "Agent" and "In Progress" would turn the person's routine drag into "In Progress"
    into a dispatch, and re-pointing the board at another repository (which needs only a mapping
    re-approval) would carry the dispatch switch along. Any difference refuses (`consent-stale`, on
    the card and in Settings) until the person presses "Re-confirm this column". Choosing a column
    binds; changing the agent or the cap does not re-bind. An entry without a binding is OFF.
  - Read through `sanitizeBoardDispatch`: an unreadable entry is OFF, an unreadable cap is 1, the
    kill switch (`paused`) is on only for a literal `true`. `boardDispatch` is in
    `SETTINGS_VERB_FORBIDDEN` — an agent that could switch the dispatcher on would grant itself more
    agents, and the name pattern does not catch the key, so the set is its only fence. Model: the
    same gateway default `addAgentNode` applies; there is no per-project model.
  - **Only agents that report their state through hooks** (`dispatchableAgent` →
    `hasHooks(capabilityAgentId(…))`, the `--after` rule) are offered or accepted. The cap counts
    sessions by hook state; a hookless custom agent never reports, so after the startup grace its
    slot would free and the cap would admit one more run every two minutes.
  - **Bounds.** One run per issue: a bound session that still exists in ANY project, or a dispatch
    already queued/starting, refuses the next with a reason on the card. The cap counts this
    project's bound sessions that are `working`/`waiting`/`blocked`, hold a launch that will start
    BY ITSELF (a `manualOnly` one waiting for Run now does not), or were started by dispatch within
    `DISPATCH_STARTUP_GRACE_MS` (no hook yet) — `done` frees the slot (the cap limits concurrent
    WORK), and an unknown state from before a restart does not hold one, or the cap would stay
    pinned. Over the cap the dispatch QUEUES; the drain runs on a 5 s timer only while something is
    queued. **Every queued entry is re-asked before it starts** (`recheckQueued`): kill switch,
    still switched on, project still open/local/not closed, binding unchanged, agent still
    dispatchable, and the issue still OPEN and still in the dispatch column (read from the host's
    issue cache with `githubIssues.query` — no GitHub request; an unreadable answer waits, it is
    never evidence). A teammate closing or moving the issue while it waited drops it with its
    reason. Moving a queued card out of the column withdraws it. The kill switch refuses new
    dispatches and drops the queue; running sessions are not touched.
  - **No dispatched node is ever left armed to start on its own.** The off-screen path writes the
    node ALREADY CLAIMED (`claimForHeadless`: `manualOnly`, in the same tick as the node — no window
    in which opening the project would auto-start it beside the headless start), then runs the #925
    headless start. Whatever it answers, a node that did not start waits for Run now; a Pause or a
    restart can therefore never be outrun by a held launch that fires on view. The failure notice
    says exactly that (Run now, or close the node to dispatch the issue again — it keeps the issue's
    one run until then).
  - **The queue is in memory, on purpose**: a queue that survived a restart would start agents at
    boot with nobody there. A restart drops it silently, and the drag (or Start with agent) can be
    repeated. Each renderer keeps its own queue, so **two Server Edition tabs on one project can
    each run up to the cap** (known; one tab per project is the supported use).
  - **The card says what happened** (`DispatchChip`): "Queued for an agent (#2)", "Dispatching an
    agent…", or "Not dispatched: <reason>" (`DISPATCH_REFUSAL_TEXT`). A started run shows as the
    ordinary run chip.
  - **Where it runs: the renderer**, because the trigger is a UI gesture core never sees. On screen
    it is `addAgentNode`. Off screen — a queued run whose slot freed later, or a project switch
    during the move's GitHub round trip — it is a cold open into the stored project (the control
    verbs' path) plus the headless start, which raises its "Go there" notice. A CLOSED project's
    queued run is dropped, not started (the headless start would unhide its tab). **Server
    Edition**: the browser renderer's `pty.launchHeadless` is unsupported (the server's own
    headless launcher serves canvas control, not a browser tab), so a dispatch there starts only
    for the project ON SCREEN; an off-screen one stays queued (still subject to Pause) until that
    project is shown. **SSH projects: refused by name** (the headless launcher is local-only).
    **Relay tabs: refused** (the board is the host's). **Mobile: N/A** (the phone board carries no
    issue cards). Never auto-posts to GitHub, never closes an issue, never moves a card on a turn
    `done` — the existing rules; the dispatch column may not be the completion column.
  **Where a card comes from is a registry, not a branch per call site** (`renderer/lib/kanbanSources.ts`,
  2026-08-30 — the same membership-plus-one-leaf discipline `AGENT_CONFIG` uses): each entry declares
  its filter `label`, its `placement` (`assignment` = the board's own persisted assignments,
  reorderable within a column; `provider` = the provider reports the column, the board persists
  nothing and a move is the provider's write), its in-column `lane` order and whether it is
  `configured` for a given board. Two orders live there deliberately: **declaration order is the
  source filter's button order** (All · GitHub · Sessions), **`lane` is the in-column stacking order**
  (sessions above issues) — they genuinely differ, and pinning both is what stops either being
  re-spelled elsewhere. `KanbanColumn` therefore takes ONE `lanes` prop (`{sourceId, cards, footer?,
  count}`) instead of a `cards` + eight `github*` props, places them via `byLane` and names no source;
  the board builds each source's leaf, and the drag union branches on `placement` (`isProviderDrag`)
  rather than on the string `'github'`. A lane's `count` is passed rather than derived from
  `cards.length` because a provider reports a server-side total larger than the page fetched so far.
  What deliberately did NOT move into the registry: the virtual **Ungrouped** column (board
  semantics, not a source's concern) and `validKanban`, which stays the single shape gate on every
  load path — a registry entry must never grow its own parallel validation. **Labels** are a per-project palette (`ProjectKanban` labels,
  edited inline via the Notion-style `LabelPicker`: create/assign/rename/recolor/delete through the
  pure `lib/kanban.ts` transforms) plus each GitHub issue's own labels, both filterable. The canvas stays MOUNTED under the opaque overlay (agent-status
  listeners live in Canvas.tsx; `display:none` would 0×0-resize every terminal into a tmux
  SIGWINCH), and canvas-only shortcuts (undo, ⌘T/⌘⇧C, Delete) early-return via `isKanbanOpen`.
  Board data is `project.kanban` ({columns, assignments: [{nodeId, columnId}]}, order = array
  order) in `.nodeterm/project.json` — git-shared, rides rev/mirror/watcher; absent until the
  first edit (`defaultKanban` seeds To Do / In Progress / Done). The virtual **Ungrouped**
  column (never persisted, undeletable/unrenamable, always first) holds every session with no —
  or dangling — assignment, in canvas order, so the board never opens empty. **Assignment is
  board metadata only**: drags never move canvas nodes or change groups; dead nodes' assignments
  prune lazily on each board change (`pruneAssignments`). Column delete is confirm-free (cards
  return to Ungrouped; no last-column rule — Ungrouped remains). The one shape rule is
  `validKanban` (`core/workspace-files.ts`), applied on EVERY load path — `fileToProject` AND
  `loadV3`'s inline (cwd-less) branch, which bypasses fileToProject — so a v1 `{columns, cards}`
  or hand-mangled board drops to the fresh default instead of crashing the render (view choice
  persists in localStorage, so a render throw would boot-loop). Pure transforms in
  `renderer/lib/kanban.ts`; view choice is personal (`state/viewMode.ts`, localStorage
  `nodeterm.projectView`). The board opens with a **title strip** (`.kanban-header`: project
  dot + name) whose height clears the floating controls-cluster icons — columns never sit under
  them. At 640px and below the cluster spans most of the strip, so the strip moves below it
  instead of padding beside it; otherwise Sync and the scope switch sat under the cluster's
  buttons at phone width (measured with `elementFromPoint`, 2026-11). **Cards collapse/expand on single click** (transient state); the expanded detail row
  reuses `ContextMeter` (model + % pill, per the node header) + session chip + an ↗
  open-on-canvas button; double-click opens the node directly. Z-order contract: overlay 25 <
  `.controls-cluster` 26 (Explorer/SC/Settings stay clickable ON the board) < `.top-banners` 27
  (a mandatory-update card must not hide behind the board) < tabbar 30. An assigned session
  node shows its column as a **half-pill flush on the node's TOP edge** — see the pill sentence
  below. A card's ↗ / double-click opens the **card modal** (`components/kanban/CardModal.tsx`, body
  portal on the dialog-stack, scrim z 55, scrim/Esc close — Esc in CAPTURE phase, and an Esc
  during a header rename only cancels the edit). The modal runs under the CARD project's session
  (`ProjectSessionScope` — the boards themselves sit under App's local provider; see "A remote
  project's node never starts on this core" under Projects). Terminal cards get a LIVE second
  view of the tmux session (`ModalTerminal.tsx`): the pty subscriber ledger is keyed by the composite
  `(ClientId, viewerId ?? PRIMARY)` (`core/pty-manager.ts` — **viewer identity**; viewerId is an
  optional TRAILING arg through preload/ws-bridge/LocalTransport, absent = bit-for-bit legacy, and
  a client's per-connection socket pause survives a single view's departure). The modal viewer
  seed-paints from the joiner screen (`toXtermText` transforms — raw capture-pane staircases),
  handles fresh-cold via scrollback snapshot + hint (agent auto-resume stays canvas-only), has
  deliberately no park/WebGL/hover/flow-control, and kills ONLY its own viewer on close. Sticky
  cards edit their text in the modal (live both ways).
  The modal header carries the terminal node's actions (search via `useTerminalSearch`+
  `FindBar` on the modal xterm; dictate via the same `nodeterm:dictate` event — `.dictation`
  overlay z is 60, ABOVE the modal scrim; ✦ `pty.generateName` through the modal rename funnel;
  and the **⌘M view** — a header toggle (`IconMarkdown`) plus the chord, which lays the SAME face
  the canvas node shows over the live viewer: `ChatPanel` when `canChat(created agent)` and the
  session id is known, else `TerminalMarkdownView`. Three rules: the state is MODAL-LOCAL and per OPENING
  (never `data.mdMode` — that would flip the canvas node under the board too); the viewer
  stays MOUNTED underneath (covered, not swapped, so its co-attach never detaches/re-attaches) and
  gets the same focus hand-off as the node (`ModalTerminal`'s `covered` → `useMdModeFocus`); and the
  chord reaches the modal through `window.nodeTerminal.onMarkdownToggle` only while it is the top
  dialog, while the canvas terminal AND editor nodes' own subscriptions refuse the chord whenever a
  board is up (`lib/markdownChord.ts` `canvasOwnsMarkdownChord` — a hover flag can go stale under
  the opaque board, so one press could otherwise flip both). The header also carries the node's
  pause chips — DROPPED, PAUSED and SLEEPING (Eco, with the refused-wake sentence) — each clicking
  through the same `wakeHibernatedNode` trigger as the canvas chip. The overlay sits at z 5 in the pane, BELOW the
  sheet's resize handles (z 6/7, issue #389) — pinned in `styles.kanban.test.ts`.
  **The 💬 icon means COMMENTS on both surfaces** (repurposed from the markdown view — ⌘M still
  toggles markdown/chat on the canvas node, and on the card modal): on a terminal node it opens a right-side comments
  flyout (`.term-node__comments`, a sibling of the overflow:hidden root, hosting BoardLogPanel
  with `card: Pick<KanbanSession,'id'>`); in the modal it collapses/reopens the panel, which is
  OPEN BY DEFAULT there. Under the modal header sits the **card metadata strip** (`CardMetaBar.tsx`): Members (assign) —
  colored initial avatars, picker pool = me + live presence peers + board-log authors (name-keyed,
  NO separate membership system) — and a Due date (`datetime-local`, red Overdue chip past due;
  cards show mini avatars + a due chip). Data = `kanban.meta [{nodeId, assignees, dueAt, priority}]` (priority low/medium/high/urgent, colored chips)
  (tolerant readers via `cardMeta`; pruned with dead nodes; empty entries dropped). Assign/due
  changes are logged through the SAME diff funnel (`member-assigned/unassigned`, `due-set/cleared`,
  `priority-set/cleared`; agent-to-agent message deliveries are logged as `agent-message` by
  `agent-message-trace.recordDelivery`, where `from`/`to` are node ids and `title` is the outcome;
  unknown future event types render neutrally — the `BoardLogEvent.type` union in `shared/types.ts`
  is the source of truth). Feed rows show ABSOLUTE Trello-style stamps
  (relative in the tooltip). The modal's right third is the **board log** panel (`BoardLogPanel.tsx`, `state/boardLog.ts`):
  per-person comments + card activity from `<cwd>/.nodeterm/board-log.jsonl` — append-only JSONL
  (`core/board-log.ts`: tolerant newest-first parse cap 500; text clamped `BOARD_LOG_TEXT_MAX`
  16KB — an SSH append is ONE printf arg, ARG_MAX would silently drop it), author = presence
  identity, registered via `core/board-log-handlers.ts` in BOTH shells (client sends only a
  projectId — the path always derives from the server's own registry, no jail needed). Events
  come from ONE pure funnel (`lib/boardLogDiff.ts` — binding invariant: its `cardTitle` arg
  returns '' for and ONLY for dead nodes; column deletion suppresses per-card moved-to-Ungrouped
  noise; prunes/reorders log nothing) + `createNodeInColumn`'s card-created. Local projects push
  changes via fs.watch; desktop SSH projects poll 5s while subscribed; inline projects show a
  hint. Relay tabs BRIDGE boardLog to the host (pre-dispatch `sharedProjectId` scope guard in the
  relay dispatch — an out-of-scope projectId is refused before any registry/path resolution; a
  connection drop replays its outstanding onChanged unsubscribes). **The relay-guest scope jail is
  keyed on channel CLASS, not a per-feature list** (`main/remote/relay-project-scope.ts`): every
  method whose name starts with `githubIssues:` / `board-log:` / `projects.` is project-scoped, and
  one the table cannot read a projectId out of is REFUSED on a scoped session. The switch it
  replaced had a `default: not project-scoped` arm, so a new verb in one of those namespaces reached
  another project's data with no refusal anywhere. A new channel in a scoped class therefore needs a
  table row to become reachable — and `relay-project-scope.test.ts` fails if a live IPC channel in a
  scoped class has none, so the fail-closed default cannot silently swallow a shipped verb.
  **A comment can steer an agent**: its composer's @ picker (canvas flyout and card modal alike —
  both build the candidates through `lib/boardMentions`) mentions an agent session on this board,
  and on send that session receives the comment through agent messaging; the row shows each
  delivery's outcome. A comment that ARRIVES in the log is display-only, forever — see "A board
  comment that @mentions a session" under Agent support. Deliberate v1 gaps: column-level
  events are stored but no card feed shows them; canvas-born nodes get no card-created; no
  card-deleted type.
  Per-column "+ New session" menus create agents/terminal/sticky nodes assigned to the column
  (assignment written UN-pruned — the fresh node isn't in the derived list yet). The column
  half-pill itself: (`components/kanban/ColumnPill.tsx`, `columnForNode` in lib/kanban; rendered
  as a SIBLING of the node root — the roots are overflow:hidden — hidden for Ungrouped/dangling,
  click opens the board). Server Edition works as-is (pure renderer + workspace.save). Scope: no
  agent-driven card movement yet, no board undo.
  **Mobile (nodeterm-ios) reaches the board through three relay verbs**, all landing in
  `WorkspaceStore.ensureRemoteBoard` / `setRemoteCardColumn` / `editRemoteCardLabels` (host-service
  `handleKanban`; wired in `main/index.ts`'s `hostBridge.kanban`; pure transforms in
  `core/project-kanban-write.ts`): `projects.ensureBoard` seeds the default columns on a project that
  has none, `projects.setCardColumn` moves one card, and `projects.editCardLabels` adds / removes /
  creates **board labels** on one card (the phone's long-press label sheet, 2026-09). There is ONE
  label model — the per-project palette in `kanban.labels` plus per-card ids in `kanban.meta[].labels`
  — and the label verb writes it through the SAME transforms the canvas node's "+ Label" row and the
  kanban card use: the card-meta + label half of `lib/kanban.ts` moved to `@shared/kanban-labels`
  (re-exported, renderer call sites unchanged) so core can apply it; a test pins that a phone edit
  produces the board `toggleCardLabel` produces. Params are validated at the write site
  (`parseCardLabelEdit`: bounded control-free ids, 1–60-char control-free names, colour from the closed
  palette, no id both added and removed) because they land in a git-shared, hand-editable file; a
  created name matching an existing label case-insensitively REUSES it (the picker offers no Create
  on an exact match); the first label on a board-less project seeds the default board, as the
  desktop's first "+ Label" does; a stale `add` answers `edited:false` with the CURRENT palette so the
  phone can redraw. Deleting/renaming palette entries is deliberately desktop-only (it touches every
  card). The iOS direct-SSH path has a Swift twin of the transform for projects on the host it dials. Three things make them necessary rather than convenient. (1) The desktop board is a
  LAZY default — `kanban` is not written until the user's first board edit — so most project files
  carry NO board and the phone, which knows a project only by its file, could not offer one
  (measured: 1 of 13 project files on the author's machine had a `kanban` block). The default columns
  therefore live in `@shared/kanban-default-board`, read by `defaultKanban()` AND by the core seeder,
  and copied verbatim (under a pinning test on both sides) by iOS `KanbanDefaults`. (2) An SSH
  project's file is on a THIRD machine the phone has no credentials for; the verb writes the entry's
  `cache` and lets the ordinary mirror push it, which is exactly what a desktop card drag does — so
  it needs nothing new from `reconcileSsh` (that decides by `rev` and unions only `nodes`). Its cache
  change IS persisted to workspace.json, because for an ssh entry the cache is the local record. (3)
  The phone's older direct-SSH write inlines the whole project.json into one argv string and so dies
  at Linux's `MAX_ARG_STRLEN` — this repo's own `.nodeterm/project.json` measured 114,695 bytes,
  ~15 KB under the 128 KB ceiling. **Both verbs announce their write on `workspaceExternalChange`
  and that is not optional**: the renderer holds its own board and the next whole-workspace save
  serializes THAT, so a change the renderer never heard about is one the next autosave reverts.
  **Board model + UX (2026-09).** Three tiers, and a new board feature must pick one: a board
  FACT is shared content in `project.kanban` (optional, sanitized, ignored harmlessly by an older
  build); a DISPLAY preference is per-user localStorage (`state/kanbanDisplay.ts`,
  `nodeterm.kanbanDisplay`, per project); a filter on LIVE agent state is component state only.
  - **`sanitizeKanban` (`core/workspace-files.ts`) is the shape rule now**, applied on all three
    seams — `fileToProject`, the store's inline-project branch (which bypasses it) and
    `projectToFile` on the way OUT (the two-seam rule `sanitizeLayouts` follows). It is
    `validKanban` plus per-entry repairs, never inventions: a column that is not an object with
    string `id` + `title` is dropped (React cannot render an object title — a render throw
    boot-loops the app, the view choice persists), a non-string `category` is dropped, a malformed
    assignment is dropped, a card's `assignees` that is not a list is dropped (entries without a
    string name + colour filtered), every other field round-trips, and a clean board comes back BY
    IDENTITY so a well-formed file is never rewritten. **Readers do not trust the load path alone**:
    `cardAssignees` (`@shared/kanban-labels`) is the one reader of `meta[].assignees` — the board,
    the card, the member filter, the log diff and the handoff pings all go through it, because an
    `assignees: 5` iterated raw threw during render (a boot loop) and inside the `assign` verb.
  - **Lifecycle category** (`KanbanColumn.category?: unstarted|started|done|closed`,
    `@shared/kanban-category`). Every reader goes through `columnCategory`: an unknown STRING reads
    as absent but is KEPT in the file (dropping it would erase a newer build's value on an older
    teammate's save); a non-string never reaches a comparison. The default board carries
    unstarted/started/done on every seeding surface (`defaultBoardColumns`, shared by
    `defaultKanban` and the relay's `ensureProjectBoard`/label seeding). It drives the header
    progress (`boardProgress`: live cards in done+closed columns over EVERY live card, Ungrouped
    included; null when no column is done/closed — a number over an undefined "complete" would be
    invented), hides `closed` columns behind a per-user toggle (default hidden), and gives the GitHub
    completion column its default (`defaultCompletionColumnId`: first done, else first closed, else
    the last column — the pre-category default, so an uncategorized board is unchanged). **A
    category change on a column that holds cards is never silent**: it is a claim about every card
    in the column (they start counting as finished, or leave view when it becomes closed), so
    `categoryChangeImpact` gates a `ConfirmDialog` naming the count and the consequence; an empty
    column changes at once. Confirm rather than refuse: refusing would only make the user empty
    the column first, which is friction, not safety. Set from the column's ⋯ menu / header
    right-click on the per-project board; Omni shows no column menu.
  - **An unanchored card move lands at the TOP** (`assignNode`): no `before`, or a `before` naming
    a card outside the destination column. An agent's `assign` into a long Done column used to
    append at the bottom and read as "disappeared". A POSITIONAL drop still says where it landed —
    below the last card or on the column body passes `AT_COLUMN_END` explicitly (both board views).
    The relay's `projects.setCardColumn` follows the same rule; the `assign` help in BOTH agent
    bodies says so (`canvas-control-core.test.ts` pins it).
  - **Status chips** (Running / Needs you / Unread, `lib/kanbanStatusChips.ts`) read the store
    through a derived primitive signature (`statusChipSig`) — never `byId`, the `armedDepSig` rule —
    and are NEVER persisted (component state, reset on project switch): a filter on
    second-by-second state that survived a restart shows a wrong board. The card badge and the chips
    share ONE rule, `cardBadge`, so a chip cannot select cards whose badge says something else. They
    narrow session cards only (like local labels); they AND with the label filter and OR within
    themselves.
  - **Board-log folding is a VIEW** (`lib/boardLogCollapse.ts`, `BoardLogFeed`): consecutive events
    by the same author (name AND colour) of the same type within two minutes of the run's NEWEST row
    render as one "×N" row that expands in place; the jsonl is never rewritten. The window is
    anchored, not chained, so a ×N never spans more than two minutes. Comments never fold, and
    neither do `agent-message` / `agent-read-cookies` (audit rows) or an issue's `run-started` /
    `run-ended` history (each row names a different session) — `NEVER_COLLAPSE`.
  - **Keyboard**: registry scope `board` (group Board) — Space opens the focused/hovered card,
    J/K + ArrowDown/Up walk board order (the session cards on screen, column by column, Ungrouped
    first; GitHub cards excluded), ArrowLeft/Right jump to the same row of the neighbouring
    non-empty column; in the card modal J/K step the modal. `board` resolves only while a board is
    up and has no `allowWhileTyping`/`allowInTerminal`, which is the ONLY reason
    `normalizeBindingForCommand` lets it bind a bare letter or Space (the card modal's terminal,
    the comment box and the chat composer keep every key). Dispatch stays in Canvas's one
    listener; the mounted per-project board answers through `lib/boardKeys.ts` and DECLINES (the
    key falls through) when the focused control uses the key (`keyOwnedByControl`: Space on a
    button/link/checkbox, anything in a `<select>` or ARIA composite), when any dialog other than
    its own card modal is open, or when a card menu is up. Two pre-existing bugs this had to fix:
    the canvas's CAPTURE-phase space-to-pan `preventDefault`ed every non-typing Space even while a
    board covered the canvas (so no board button could be pressed with Space) — `spacePanKeydown`
    now takes `canvasCovered`; and a `Space` binding could never match because `e.key` is `' '`
    (`normalizeKey` maps it to `SPACE`). The Settings recorder captures a bare key only for a
    command that may have one (`board` scope or `allowBareKey`).
  - **Rank strings** (`KanbanAssignment.rank?`, `@shared/kanban-rank` + `@shared/kanban-order`).
    Order within a column = rank; an entry without a valid one (every pre-rank board, an older
    build's move — its `assignNode` rebuilds the moved entry without the field — a hand edit) sits
    right after the entry before it in the ARRAY, ties keep array order. Keys are base-62
    fractional-index strings with an integer head, so the board's DEFAULT (top insert) is a
    decrement: a thousand top inserts stay four characters (a digits-only midpoint scheme grows a
    character every few). **A move never throws**: ~1.3k inserts into ONE gap grow a key past
    `RANK_MAX_LENGTH` (256), and only then is the destination column re-keyed evenly as one
    contiguous block (`rebalanceColumn`) — the one rebalance this scheme does. A rank STRING readers
    cannot use is kept in the file (like an unknown category) and re-keyed by the next write into
    that column; a non-string is dropped. A card assigned twice (a clean git merge can do that)
    keeps its FIRST assignment everywhere — `sanitizeKanban`, `columnOrder` and `placeAssignment`
    (which removes every copy of the moved card, as the pre-rank `assignNode` did). **Every write goes
    through `placeAssignment`** (renderer `assignNode` AND the relay's `setProjectCardColumn`), which
    also keeps the array in rank order so a build that ignores `rank` shows the same column — the
    brief's two goals ("a move is a one-line diff" and "keep writing the array in rank order") pull
    against each other, and the resolution is to move as little as the second allows: a
    cross-column move whose array slot already sits between its new neighbours changes ONE entry in
    place (two lines: `columnId` + `rank`); otherwise its block moves next to its successor; a
    reorder WITHIN a column always moves a block (the array must change for an old build to see
    it). A destination column is repaired first when it must be — missing/invalid/colliding ranks
    re-keyed in the order it was already showing (only those entries change; a board's first write
    into an unranked column ranks it once), an array that disagrees re-slotted within the column's
    own positions. MEASURED with `git merge-file` (`core/kanban-rank-merge.test.ts`): two
    ADJACENT cards filed into Done concurrently conflict under array-only placement and merge
    cleanly with ranks; two NON-adjacent ones merged cleanly either way, so do not claim more than
    that. The file's own `rev`/`savedAt` header still conflicts on any concurrent save — untouched.
  - **Saved views** (`kanban.views: [{id, name, query}]`, `@shared/kanban-views`) are SHARED
    content: a query carries source, labels, members and columns (the member and column filters are
    board filters of their own). `viewQuery` is the ONLY builder and reads only those four, so the
    status chips can never enter a view. The ACTIVE view and "show closed" are per user
    (`kanbanDisplay`), restored on entering the board; a view a teammate deleted is ignored.
    Deleting a view confirms (it goes for everyone). `sanitizeViews` runs inside `sanitizeKanban`,
    keeps query fields it does not know, and `KANBAN_VIEW_SOURCES` is pinned to the renderer's
    source registry (the shared sanitizer cannot import it).
  - **Handoff pings** (`lib/handoffPings.ts`): the `assign` verb notifies a card's ASSIGNEE (this
    machine's presence name) when an agent files it into a `done` column or a `started` column past
    the board's first — never on routine moves, and not for needs-you (the existing agent-status
    alert already covers every agent node). Same consent, background-only rule and per-node
    cooldown as the turn-end alert, and a handoff ping arms a one-shot FOLD so the Stop hook that
    follows seconds later is not a second notification for the same moment. The fold lasts only
    while the user is away: a window focus in between drops it (`installHandoffFocusReset`), or the
    next chime — for a turn the user sat and watched — was swallowed. v1 is agent-driven
    moves only: a teammate's move arriving by git, or the phone's relay move, pings nobody.
  - **Team progress** (`lib/teamProgress.ts`, `components/TeamProgressChip.tsx`): a session that
    opened stations shows "N of M done" as a small ring on its board card, its card modal header
    AND its canvas node header — ONE component, so three views of one node cannot count
    differently; clicking it lists the stations and a row travels to that node. A station is a
    session node that is the target of an OPENER rope. Ropes carry two relations — "opened by"
    (`ctrl-<source>-<node>`) and a wait (`--after`, the verify panel), which is minted
    `ctrl-after-<dep>-<node>` (`waitRopeId`, `lib/edgeModel.ts`) and skipped. **The mark is what
    makes this hold, not rope order**: the canvas prunes every rope with an endpoint off the canvas,
    so deleting an orchestrator (or the user deleting its rope, or a `--project` open whose opener
    lives in another project) removed the opener's rope, and under the old "first rope is the
    opener" rule the first surviving wait read as the opener — a pipeline's upstream station showed
    the next one as its team, a verify panel's reviewed node showed its reviewers. Canvases saved
    before the mark are re-marked at LOAD by append order (`markLegacyWaitRopes`: every rope into a
    node after its first is a wait), which must run before the prune; one already pruned and saved
    has lost that evidence. **A node that records its opener (`data.openedBy`, the station-notice
    stamp) closes that residual**: only the recorded opener's rope may claim it, so a surviving
    wait is never promoted; the rope still has to exist (delete it and the station leaves the team,
    the same pair the station-failure notice reads). Nodes opened before the field keep the rope
    rule. Tests run the canvas's load → heal → prune steps before `stationsByOpener`. Rules the count keeps: **unknown is unknown, never done** (state is
    transient; after a restart a station reads `unknown` until it reports), paused/hibernated count
    as a finished turn (both come only from an exit that refuses a working or blocked session), a
    CLI that announced its exit (`sessionEnded`) reads `ended` and counts (it is not running and
    never will be on its own — `unknown` would hold the ring below complete forever), a held launch
    reads `queued`, `done` + `lastTurnError` reads `errored` (the `--after` verdict), a station that
    can never report (plain terminal, hook-less agent) is listed as "no status" and kept OUT of M
    (the line `--after` draws), and a deleted station is not a station.
    Subscriptions: each chip reads `teamProgressSig` — one character per station, no ids — never
    `byId`; the per-project board gets the teams as a prop from Canvas, the Omni lanes derive
    theirs from the stored `p.ropes`/`p.nodes`, and the canvas node header reads `useTeamStations`
    (`state/teamStations.ts`, a transient store Canvas publishes from its live control ropes). The
    previous map is threaded back into `stationsByOpener`, so an unchanged team keeps its array
    identity across drag frames and nothing re-renders. Desktop + Server Edition identical;
    Mobile: follow-up (the phone board would need the ropes).
  - **The card does not repeat what its place says** (`lib/cardRedundancy.ts`). The session-name
    chip is hidden when it is the card's title (agent titles auto-track it) — the same rule the
    canvas node header has always had, now one function for both — and a past due date in a
    done/closed column keeps its date but drops the overdue alarm. The card MODAL keeps both facts:
    its header names a session that differs from the title, and its Due strip still says
    "Overdue". Audited and NOT hidden (written in the module so the next audit does not re-derive
    it): the card never names its column or its project, and there is no badge that restates a
    column category — RUNNING / NEEDS YOU describe the agent's turn right now, which is exactly
    what an idle card in In Progress needs distinguished.
  - **`bridges` / `ropes` are admitted through `sanitizeLinks`** (`core/workspace-files.ts`) on the
    same seams as `sanitizeKanban` — `fileToProject`, `projectToFile`, the inline-project branch
    and the legacy v2 path of the store — and on `persistedCanvases`, which reads the RAW index entry
    and last-written file for the context-link map (`buildBackgroundLinkMaps` iterates every
    bridge). They are git-shared, hand-editable input that every reader
    maps as `BridgeLink[]`, and the canvas's rope restore threw on one `null` entry at project load.
    A non-list is dropped, an entry without non-empty string `id`/`source`/`target` is dropped, and a
    clean list comes back BY IDENTITY.
  **Phone** (nodeterm-ios): must at least not break on `category`, `rank` or `views` (extra JSON
  keys its board decoder ignores). The relay-served move now lands at the top with a rank, while
  the phone's direct-SSH writer (`KanbanBoardWriter`) still appends without one — the next desktop
  write into that column ranks it, and array order already shows it correctly. `KanbanDefaults`
  should gain the three categories. All three are the iOS follow-up, not desktop work.
- **Omni Kanban (global swimlanes)** (`components/kanban/GlobalKanbanView.tsx`; one swimlane per open project; `state/viewMode.ts` `globalKanban` (localStorage `nodeterm.globalKanban`, machine-local, like `viewByProject`); the Kanban tab and `view.kanbanToggle` (Cmd+Shift+B) open it, and `view.globalKanbanToggle` (registry command, unbound, remappable) moves between it and this project's board; it was a settings-gated opt-in until the Kanban tab made it the board's front door, and a stale `omniKanban*` key in settings.json is ignored; it has no GitHub issue lanes, so a node's `#N` chip goes to the project's own board; **Omni is a SCOPE of the kanban side, not a third view**: the view toggle (Kanban tab, ⌘⇧B, the menu) flips canvas ⇄ board, and a board header's `KanbanScopeSwitch` ("This project" / "All projects") moves between the two scopes — so leaving Omni through the switch lands on the project's board, and the view toggle from Omni lands on the canvas (it used to fall through to whatever the project's view happened to be, so "Canvas view" from Omni could land on a board). The decisions live once in `state/viewMode.ts` (`toggleBoardView` / `toggleAllProjectsBoard` / `showProjectBoard` / `showCanvas`), called by TabBar, the menu IPC and both registry commands; Omni has no close button. `globalKanban` deliberately stays independent of the active project, so a project switch made from a lane does not drop the user out of Omni. Non-active lanes are derived from serialized `p.nodes` via `toKanbanSessionState` (the persisted-state counterpart to `toKanbanSession`); the ACTIVE project's lane is fed LIVE by Canvas (`GlobalKanbanLive`: the same `kanbanSessionsFrom(nodes)` cards + live `teamStations` the per-project board uses), because its edits reach the store only at the next ~800 ms autosave — a store-fed lane reverted the card modal's controlled sticky textarea on every keystroke and pruned the assignment of a card created a moment earlier. The open card modal is ONE overview-level fact reported to Canvas's `setKanbanModalNode` (watched for Eco, wake-on-open, dictation target), never per-lane state; each lane's board write resolves ITS project's session (`sessionForProject`) for the hosted read-only refusal and the board-log api; `pendingLaunch` never becomes `initialCommand` in the modal (the DAG launch must fire only when dependencies report done, and the canvas `TerminalNode` already delivers `initialCommand` via `writeWhenShellReady` after the `nodeterm:create-node` project switch). Active-project edits (rename / sticky / browser nav) route through Canvas live nodes (`setNodes` + `markDirty`), non-active through the store + `writeDisk`; delete uses `ConfirmDialog` (not `confirm`) and then `deleteNodes` (active project) or `closeStoredNodes` (any other) — the existing cross-project teardown funnel, never a hand-rolled copy. The top bar's project pills and Cmd/Ctrl+1..9 (`nodeterm:swimlane-jump`) jump to the lane; header hint shows the correct mod (`Cmd` on Mac, `Ctrl` elsewhere). Server Edition works as-is, Mobile N/A.

## dis-invoice sync

A person pressing **Sync** on either board mirrors dis-invoice's pending work: one DisTerm project per dis-invoice project with pending tasks, one sticky per task. Nothing polls, and agent status has no path to it (`board-writers.guard.test.ts` signs the one board write). Connector contract: `src/app/api/connector` in Distriib/dis-invoice. Code: `core/dis-invoice/` (client, folders, key and links, overrides, a brief's WSL path), `shared/dis-invoice-reconcile.ts` (every sync rule, in one pure reducer), `renderer/lib/disInvoiceSync.ts` (order and project resolution, with injected deps), `renderer/lib/disInvoiceCanvas.ts` (live or stored), `renderer/lib/disInvoiceBrief.ts` (an agent's brief), `renderer/state/disInvoiceSyncRun.ts` (the run and its report), thin adapters in Canvas.

Invariants, each with the failure it prevents:

- **All or nothing on the fetch.** `fetchSnapshot` returns tasks only if every page arrived. A task missing from the snapshot means finished, so a partial list would finish tasks that are still open. An empty column list changes nothing, because that list is empty until someone opens dis-invoice's board. Reconcile runs over the global task map, so a task moved to another project does not read as finished: its old sticky stays, and the new project gets its own. The report warns about that only when the task left this DisTerm project. Two dis-invoice projects can share one DisTerm project (same repository), and a task can lose its project, and neither says anything about a move.
- **Read only, and the key stays in core.** The client has no write method and sends no redirects onward (`redirect: 'error'`, because a redirect would resend the bearer key). No channel returns the key. The URL is a constant, and only a loopback override is honoured, for the same reason. A packaged build takes no override, because any local process can listen on a loopback port. The Server Edition reports itself packaged on every run, so its proof entry point passes its overrides through its config (`core/dis-invoice/overrides.ts`). Every `disInvoice:` channel is host-only and refused to relay peers. Folder and clone channels take a project id and read the name and repository from the last snapshot, so a caller supplies neither a URL nor a new folder's name. `save-link` does take a folder, because a reused project lives wherever it lives, so `ensure-folder` and `clone` create or remove only a folder directly inside the base folder, and read any other as it is.
- **Only an upstream change moves a card.** `disInvoiceRef.columnaId` is the column sync last saw, not where the card is, so a local drag survives every later sync. `movedToFinished` records that a task left the pending list and its card was moved once, so a task returning to its old column still moves back, and a finished card dragged elsewhere stays there. Text works the same way through `textHash`: a local edit survives until the task's text changes upstream, and then upstream wins. Priority and due date have no last-seen value in the reference, so upstream wins on every sync.
- **`updatedAt` is never compared.** It bumps on a card's own column move in dis-invoice, so it says nothing about the text.
- **Mirrored column ids are derived** (`dis-invoice:<columnaId>`), so no mapping is stored and a rename breaks nothing. Column renames are not synced. A deleted mirrored column comes back on the next sync. The `al_facturar` column is billing's and is not mirrored. The finished target is the lowest `orden` column that is `terminada` and not `al_facturar`. With no such column a card is not marked finished, because `movedToFinished` is what stops later syncs moving it: the report counts it, and it moves once a finished column appears.
- **Sticky ids are scoped by project, and a minted one is always free** (`sticky-dis-<proyectoId>-<taskId>`). The core store finds a project by node id, so one id cannot live in two projects. `duplicateNode` clears the reference, because two mirrors of one task would both be overwritten by every sync. If an undo revives a second mirror, the first keeps the reference and the other becomes an ordinary note, which keeps its id, so a later mint takes a `-2` suffix rather than merging over a person's note. A recreated sticky takes the first grid slot no mirror covers, because deleting a mirror frees a slot while later ones stay put.
- **Nodes before board, one tick, one persist.** The board publisher prunes cards against live node ids, so a card written first would be pruned. There is no await between reading a project's nodes and writing them. `persist()` runs once at the end, because `writeDisk()` alone would mark uncommitted live edits as saved. A sync that changed nothing does not save.
- **Live or stored is decided by the canvas, not by `loadingRef`.** A project is written live when `nodesProjectIdRef` names it and it is active. That includes a load's settle window, when `loadingRef` is still set: `persist()` commits `nodesRef` over the store there, so a store-only write would be erased (`disInvoiceSync.test.ts` shows the erasure, `disInvoiceCanvas.test.ts` pins each branch). In the gap before a switch's load runs, the refs still hold the outgoing project, whose commit already happened, so the store is the truth.
- **New projects meet the limit gate, and never switch tabs.** See `docs/project-limit.md`. `registerDisInvoiceProject` uses `registerProject`, not `adoptProject`, because the latter activates. The gate is asked before any folder exists, and `planned-folder` reads the target with nothing written, so a refusal leaves the remaining projects with no folder and no reserved link. Closed linked projects are written without reopening them.
- **Only a project on this machine, whose nodes a save will write, is touched.** `registerProject` matches by cwd alone and un-closes what it matches, so a relay or SSH project at the target path is refused before it, unchanged. Those are skipped and reported, as is a link to one. So is an unavailable placeholder, whose nodes `workspace-files.ts` never saves: stickies written there would read as added and then vanish.
- **Client text stays out of git where it can.** A project sync creates stores its canvas in app data. A reused project, or a clone that ships `.nodeterm/project.json`, stays folder-backed, and the report says so when git can see `.nodeterm/`. Sync never edits `.gitignore` or `.git/info/exclude`. It writes no board-log entries for the same reason, since that log lives beside a folder-backed project.
- **An agent's brief is a prompt file.** A note edge pushes text only on a manual drag, flattens newlines and cuts at 2000 characters. `disInvoiceBrief` frames the task as client data, and neutralizes anything in it that reads as the closing marker, in any case or spacing (`dis-invoice.realsh.test.ts` runs it under a real `/bin/sh` with hostile text). That holds the frame against the plain attempt. It does not make hostile text harmless to a model. Only the path is typed. An SSH project refuses, because its pane cannot read a file on this machine, and there is no inline fallback, since inlining would type client text into a pane. A pane in a distribution reads the path `wslpath` answers in there, the same call `resolveWslLaunch` makes for its cwd, so a custom automount root comes out right. A `test -r` in the distribution stands behind it, because a failed `cat` would start the agent on an empty prompt with no word, and any failure refuses the start with its reason (`wsl-brief.realsh.test.ts`, with `wsl.exe` the one stand-in). The shell asked about is the project's, then the default, as the spawn resolves it, so "New Claude: WSL" rows are not offered here. **NOT measured:** any of this through a real `wsl.exe`. On a Windows-native pane the launch goes through `launch-intent-execute`, which reads the file as one argument with whitespace collapsed, so the brief arrives on one line there.
- **Existing repositories are never pulled or changed.** A clone runs only into an empty folder. A folder with other files is left alone, and the report says the clone was skipped. A project first synced before dis-invoice named its repository is cloned the same way on a later sync, unless its folder is not the one its link recorded. A failed clone there is reported and retried next sync, and that project's tasks still sync, because the project already exists. An unattended clone stays off the clone dialog's progress channel, cannot prompt for credentials and gives up at a watchdog.
- **With no key saved, the button says so.** It reads *Connect dis-invoice* and opens Settings, because a bare *Sync* gave no hint that the key lives under Settings → dis-invoice. Settings fires `nodeterm:dis-invoice-key-changed` on save and remove, so an open board relabels without a remount. The press still asks `status` itself, so a stale label never syncs without a key.
- **The report outlives the board.** A clone can take minutes and switching boards unmounts the button, so the run and its report live in `state/disInvoiceSyncRun.ts`. A sync that changed anything names it, so it never says "Already up to date".

Surfaces: Desktop and Server Edition are the same code. On the server, folders live on the server host. Relay tabs have no button on either board, and their channels are refused. Mobile is not applicable: synced stickies travel as ordinary nodes, and the unknown field is ignored there.

Run against the fake on loopback with `npm run fake:dis-invoice` and `npm run server:dis-invoice-proof`, the entry point that keeps managed hooks off. It exits unless `DISTERM_DIS_INVOICE_URL` is loopback and `DISTERM_DIS_INVOICE_DOCUMENTS` is an absolute path, because without them it is a real server on the production connector and the real Documents folder.
