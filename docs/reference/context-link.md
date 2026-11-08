# Context Link

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Context Link

- **Context Link** — a node action gated by `CONTEXT_LINK_CAPABLE` (claude/codex/gemini/opencode/grok/cursor/antigravity/copilot;
  custom agents + plain terminals excluded). **copilot joined in 2026-11:** its conversation is
  `<COPILOT_HOME>/session-state/<sessionId>/events.jsonl`, located strictly by session id
  (`locateCopilot`, which reuses the ⌘M reader's validated locator, so a malformed id never reaches a
  path) and rendered by `linesFromCopilot`: `user.message` / `assistant.message` text, one `$` line per
  `tool.execution_start` and one `=` line per `tool.execution_complete`; system prompt, reasoning,
  usage and unknown events render nothing, and sub-agent events and the user messages copilot's own
  timeline hides are skipped. The `get-linked-context` skill is installed in `<COPILOT_HOME>/skills`
  under the same consent as the other agents; copilot gets the discovery note too, so
  a copilot↔copilot link announces itself: `EMPTY_PROMPT_READABLE` (not `SCREEN_DIALOG_READABLE`, which
  would widen the chat view's dialog gate) admits it to `sendToEmptyPrompt`, whose emptiness proof is
  `readCopilotComposer` (`shared/agents/copilot-screen.ts`, measured on 1.0.107: a bare `❯` between
  two `────` rules is empty, any text after it is a draft). **grok joined in 2026-09, and the file matters:** its
  readable conversation is `chat_history.jsonl`, NOT the `updates.jsonl` its own hook payloads
  advertise and this line used to name. Routing through the advertised path does not error — it opens
  a real file, parses nothing, and hands the linked agent an EMPTY transcript with no diagnostic, so
  a reader who trusts the old wording will build the silent failure this note exists to prevent
  (`core/handoff/locate.ts` pins it): drawing an edge between two builtin-agent nodes lets each
  READ the other's context on demand (pull, not push). Architecture (2026-07, SSH-capable — see
  docs/ssh-agent-skills.md): the **desktop does the reading AND the parsing**; the CLI the agent
  runs (`context.sh`) is a thin POSIX **sh+curl** shim that POSTs to the hook server's
  `/context-link/<verb>` route and prints the text/plain reply (the Electron-as-Node CLI is
  retired — its embedded-JS parser now lives as tested TS in `core/context-link-render.ts`:
  parsers for **all four** formats — claude JSONL / codex rollout / gemini event-sourced chat /
  opencode export — plus `renderContextLink` over injected fetchers). `src/core/context-link.ts`
  coalesces renderer updates before workspace-map construction with a non-resetting task.
  Intermediate ACL publications retain previously resolved paths keyed by node, agent, session,
  account, cwd, remote/local placement and hook path. Ingest prunes changed/removed identities,
  so changing back during queued discovery cannot revive an invalidated path. Reinitialization
  clears the cache, and only current-revision discovery may refill it. The service
  holds the link docs in memory (per-node files under `<userData>/context-links/` remain as a
  debug aid), carries per-entry `agentId`/`sessionId`/`accountId`, and answers the route;
  **authorization** = the doc is selected by the REQUESTER's node id, so a token-holding caller
  can only read nodes in its own (directional) link map. Codex/gemini paths resolve via the
  handoff locators (`locateCodex`/`locateGemini` by sessionId); claude keeps the hook-fed path +
  `locateClaude(sessionId, accountId)` fallback (cwd-newest is claude-only).
  `useContextLinkSync` publishes semantic map changes from live edges and subscribes to
  background project/status changes. Geometry/status render churn cannot postpone publication;
  relay-bound projects never enter the local core's map. A render-captured project epoch prevents
  outgoing live nodes replacing the incoming project's persisted map during a tab switch. Core
  replaces the read authorization map synchronously, then enriches/writes debug documents through
  a recoverable serialized queue; revision checks prevent obsolete enrichment restoring a removed
  link. Transcript paths can be temporarily unavailable while the current snapshot is enriched.
  **SSH projects:** the shim +
  skill are installed on the remote host at connect (`RemoteHooks.installContextLink`, gated on
  the VERIFIED reverse hook tunnel; POSTs ride `--unix-socket` through it); a remote node's
  transcript is read over the ControlMaster (`initContextLink(ptyManager, deps)` — `src/main`
  injects `isRemoteNode`/`readRemoteFile`/`runRemoteCommand`, bounded tail reads), its hook-fed
  path is jailed at ingest (`isSafeRemoteTranscriptPath`), and `resolveLinkTranscript` REFUSES
  the local locators for remote nodes (they'd resolve a stranger's local transcript). Server
  Edition IS wired (`src/server/context-link.ts` calls `initContextLink(ptyManager, {})`) but
  passes no remote deps → **local-only**, which is the complete answer there: that shell runs ON the
  host whose transcripts and tmux it reads, and SSH projects are a desktop-only concept. Discovery is the `get-linked-context` skill in each consented
  context-link-capable agent's own skills dir (since #744; the old marker block
  `<!-- nodeterm:get-linked-context:start/end -->` in AGENTS.md / GEMINI.md is stripped — see
  **Agent-integration consent**). On connect a one-line discovery note is typed into each endpoint
  (claude → skill pointer; codex/gemini → inline CLI command via `contextLink.info()`) — **only into
  an idle agent at an EMPTY prompt** (issue #1144: it used to be a bare `sendText` gated only on
  `state !== 'working'`, so it was pasted in front of the user's half-typed draft and the Enter
  submitted both as one prompt, and a `blocked`/`waiting` pane would have had its dialog ANSWERED).
  Two halves: the renderer's `linkNoteRefusal` (`renderer/lib/noteLink.ts` — the ⌘M composer's
  `chatSendRefusal`: never working / waiting / blocked / CLI gone) and core's
  `PtyManager.sendToEmptyPrompt` (`pty:send-to-empty-prompt`, both shells), which reads a STYLED
  capture with `readClaudeComposer` (`shared/agents/claude-screen.ts`) and writes only on `empty`,
  inside `serializePaneWrite`. MEASURED on Claude Code 2.1.301 (fixtures
  `__fixtures__/claude/composer-capture.json`): the empty composer's placeholder is SGR 2 (dim), a
  draft is not, shell mode (`!`) is a draft. Only dim text counts as placeholder, so a capture that
  lost its SGR reads `draft` — the safe direction. Emptiness is therefore provable only for an agent
  in `SCREEN_DIALOG_READABLE` (claude); **every other agent gets no note** (`unsupported`). A refused
  note is DROPPED, not queued — the link is the capability (pull-based), the note only advertises
  it, and a note arriving minutes later is the same unsolicited prompt at a moment nobody chose —
  and every skipped endpoint is named in ONE info strip (`linkNoteSkippedNotice`). Residual: a
  keystroke in the milliseconds between the capture and the write.
  (Replaced the earlier MCP-based bridge.)
  **One-way links (issue #852):** a context bridge may carry `reader` (`BridgeLink.reader`, the ONE
  endpoint allowed to read the other); absent = both read, which is every pre-#852 link, so old
  `project.json` files load unchanged. The rule is `linkReadPairs` (`shared/canvas-link.ts`), and
  `buildLinkMap` is where it BITES: the non-reading side gets no map entry, so main serves it no
  document and the resolver refuses it — enforcement is at the read, not in the discovery note. A
  `reader` naming neither endpoint, or any present non-string value, authorizes nobody (fail closed)
and is carried VERBATIM through every conversion — dropping it as "absent" would widen it to two-way
on the next save. Set it from the context-link
  edge's right-click menu (both / A reads B / B reads A; arrowheads point at the reader — a rope
drawn over a hidden link resolves it by endpoint pair via `contextLinkForEdge`) or with
  `link --one-way` (`--from` reads). On the canvas it rides `edge.data.reader`; every bridge↔edge
  conversion goes through `bridgeToEdge`/`edgeToBridge` (renderer/lib/noteLink.ts; CLI-planned
bridges enter live state only via `appendBridgeEdges`) and the server
  merge keeps it (`serverChange.edgeRef`) — a field-by-field `{id, source, target}` copy silently
  turns a one-way link two-way again. A flip that GRANTS read access sends the same one-shot
  discovery note a new link sends; losing access sends nothing, like removing a link. Note: the
  premise "every submit triggers a full read" does not hold — nothing reads on submit; the linked
  agent reads only when it decides to run the skill/shim. What one-way removes is the other side's
  PERMISSION and its discovery note. **Team sync carries it too**: an `edge-upsert` of kind
  `bridge` keeps `reader` through the diff, the shape gate, the reflector's sanitize and the peer's
  apply (`edgeFields`/`sameEdge` in `shared/canvas-mutations.ts`), and a flip alone is a change. A
  three-id copy there never cast a flip and landed a cast one-way link on the peer as both-read,
  which the peer then saved and published back. A malformed reader on the wire REFUSES the op
  (never dropped — dropping widens), and a rope never carries one.
  **Note links:** a sticky note can be connected to ANY terminal node (one-way, sticky →
  terminal). On connect, agent sessions get a one-shot push of the note text
  (`buildNotePushMessage`, single-line, truncated at 2000 chars) through the SAME empty-prompt gate
  as the context-link note above (#1144); plain terminals get no push (the text would execute). The note's live text also rides
  the link file (`ContextLinkInfo.note`), so Claude reads the current text via the
  get-linked-context CLI (`summary`/`transcript` print it; `list` marks `(note)`). Pure
  edge/push/map logic in `renderer/lib/noteLink.ts`.
