# Remote access and push webhook

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Remote access (phone relay) — free, not Pro

**In DisTerm the relay is off by default.** `RELAY_URL` and `API_BASE` have no default
(`main/remote/host-service.ts`, `server/index.ts`), and `relayAllowed()` is `!!NODETERM_RELAY_URL`,
packaged or not. With none set, phone access, Team Access, the remote dialog, Live Links and Share with
team are disabled with ONE sentence, `RELAY_UNAVAILABLE_REASON` (`shared/relay-availability.ts`), read
through `state/relayAvailability.ts`, whose unanswered state counts as "not available". The push webhook
panel is disabled with its own sentence (`PUSH_WEBHOOK_OFF_REASON`), and push is off without
`NODETERM_API_BASE` even in a packaged build. The
Upgrade dialog and ProCompare state which paid or free rows are unavailable and give that same reason;
price, checkout and gates are unchanged. A new surface that rides the relay owes the same gate. The rules below describe what happens once a
relay is configured.

- **Relay key intake: no low-order keys, one spelling per key, a 10-digit SAS** (security audit
  2026-10, relay-crypto F1–F5). (1) `deriveSharedKey` (`core/relay/e2ee.ts`) refuses a peer key whose
  RAW X25519 output is all zero (`WeakPeerKeyError`, `E_WEAK_PEER_KEY`): tweetnacl's `box.before`
  accepts low-order points, and with one the shared key is HSalsa20(0), a public constant — a
  secret-less client completed the handshake, both humans saw the same fixed SAS ("357 836"), and a
  0^32 key pinned through a tampered offer/join code let anyone back in silently (`autoApprove`).
  Check the raw X25519 output, never `box.before`'s. The host refuses in the `e2ee_hello` handler
  WITHOUT answering and closes the socket (no throw inside the ws emit), and sets `peerPubB64` only
  after a successful derive, so nothing can pin or auto-approve the refused key; a client throws in
  `connectRelay` before dialing. The intakes are belts on that choke point: `decodeOffer`,
  `decodeJoinCode`, `ownerKeyProblem`, `pinDevice`/`isPinned`, and the `/pair` `epk` (400 `bad
  epk`) — `isLowOrderPublicKey` uses a fixed probe scalar, since any clamped scalar sends exactly
  the low-order points to zero. Pinned by `relay-low-order.test.ts` (the audit's repro, against the
  real host and client). (2) Keys and nonces must be CANONICAL padded base64 (`canonicalB64ToBytes`):
  Node's decoder skips junk, so `"!!!" + key` decoded to the key, and pin stores compare strings.
  A join code's body is canonical base64url too, after removing ASCII whitespace (wrapped mail
  lines). Every producer (desktop, iOS, Android, web viewer) pads already. (3) The SAS is v2:
  `pad6(BE_u32(h[0..4]) mod 1e6) + pad4(BE_u32(h[4..8]) mod 1e4)`, "NNN NNN NNNN", h =
  SHA-512(shared). v1 (~20 bits) was grindable on both legs in seconds by whoever substitutes a
  pinned key. The first seven characters are the v1 code, and every surface shows
  `SAS_COMPARE_HINT` (`shared/remote/sas.ts`) under the code — the host approval dialog
  (`shared/remote/approval.ts`), the joiner's prompt (Canvas), the hosted owner dialog and `team
  status`. Nothing compares SAS strings in code, so mixed versions stay correct; vectors in
  `e2ee.test.ts` and docs/ios-protocol-migration.md §3.1 (the phones owe their own release). (4) The
  host SAS dialog has one slot: a DIFFERENT device's pending request is refused while one is open
  (`renderer/lib/pendingPeerAdmission.ts`: a phone is rejected and retries, a relay peer is never
  confirmed), never swapped in under the human comparing digits; the same device re-raising (#372
  retry churn) replaces in place. (5) The pairing QR carries `sshHostKeys` (`SHA256:…` `ssh-keygen
  -lf` spelling, ordered ed25519/ecdsa/rsa, at most 4, after `relay`, before `ssh`; always omitted
  with `ssh:false`), so the phone pins its first SSH connect instead of TOFU
  (`main/ssh-host-key-fingerprint.ts`; phones: nodeterm-ios#75 + Android). **COMPLETE OR ABSENT,
  never partial**: the phones REFUSE a host key not in the set, and sshd presents whichever key the
  client's algorithm preference picks, so a missing key locks the phone out until a new QR. The set
  is what sshd would serve: `HostKey` lines of sshd_config + its `Include`s (else sshd's defaults),
  each counted only if its private file exists (stat, never read), each `.pub` required to parse.
  Any doubt drops the field — an unreadable `.pub`, `HostKeyAgent`, a relative or `%`/`~` path, a
  glob form we do not model, more than 4 keys; an unreadable config falls back to the defaults
  only when all three are present and consistent. A superset is harmless.

- **A Team Access invite that shares ONE project is a boundary, not a label**
  (`core/relay/scoped-guest-policy.ts`, wired by `main/remote/relay-host.ts` as the core relay
  host's hooks). The invite is consent to run commands IN that project, and nothing else: inbound is
  an allowlist (`SCOPED`) where a node id must belong only to the shared project, paths realpath
  inside the project root and outside userData (symlinks and dangling links refused), `pty:create`
  loses `sshRemote` and defaults its cwd to the root, `workspace:save` is refused; outbound reuses
  the viewer policy's per-project event/terminal-frame attribution, presence included (only peers on
  the shared project, no node id outside it — `createPresenceFilter`). **A node id the guest itself
  introduces over `canvas:mut` (one no project holds yet: the host saves on a debounce, so a new
  terminal's first `pty:create` precedes its node on disk) is PENDING, and pending unlocks nothing
  but its own spawn** (security audit F1, 2026-10): its `pty:create` carries `newOnly` (core refuses
  a join, a reattach, and any session that already runs under that name, `unavailable: 'new-only'`),
  and only that create's own `fresh: true` response makes it the guest's node. Until then every
  node-keyed verb and the outbound stream refuse it, even after the host saved it into the project
  (being on the canvas is the guest's own doing, not ownership). Introduced ids are bounded (256) and
  must be `[A-Za-z0-9-]` (`sessionName` rewrites anything else, so two ids could name one tmux
  session). The audit's attack was an SSH-project guest (no local shell granted) recording a PREFIX
  of another project's node id and reaching that LOCAL terminal through tmux prefix matching (see
  "Exact tmux targets" under the tmux section). **A share rooted at the disk root, the home directory
  or an ancestor of either or of userData is never served** (`core/relay/share-root.ts`): every file
  under it would be readable, `~/.ssh` included; the invite UI shows such a project disabled with the
  reason (`relayHost.scopeProblems`), `addSeat` refuses to mint it, and the policy refuses every
  request of such a session. An unknown channel is refused, and the guard test
  forces a decision for every relay-tab channel. `connectRelayHost` THROWS for a scoped session
  given no scope deps rather than serve it unscoped. **What it does not claim**: the guest's own
  terminal is a shell as the host's user and can `cd` anywhere or attach another tmux session; the
  policy closes the app's RPC doors, not the OS. Secret-bearing RPCs are host-only for EVERY relay
  peer (`shared/host-control.ts`, now also enforced in core `relay-host.ts` `serve`, so the Server
  Edition's hosted peers meet it): `settings:*` (a peer that saved `modelGateway.baseUrl` and then
  called `agent:discover-models` would have the keychain-held gateway key sent to its URL),
  gateway credentials, `license:*`, `claude-accounts:*`/`codex-accounts:*`, `usage:*`, and the
  pairing/relay trust plane. An UNSCOPED invite (Team Access seats) stays full access, and its copy
  now says so. Known degrades of the scoped tab: the host-path picker starts at `/` and is refused
  (navigate from the project instead), and an SSH project's terminals do not open over the relay.

- Phone relay remote access ("Reach this Mac from anywhere") is a **Core (free) feature** as of
  2026-08-01 — the iOS app is itself paid, so a desktop Pro gate double-charged the same feature.
  The former Pro gate AND the free-tier monthly quota (`core/relay-quota.ts`, `RelayQuotaBanner`,
  the ProCompare meter, the `relayQuota` IPC/preload/bridge surface, docs/relay-quota.md) were all
  **removed**. The toggle (`settings.phoneAccessEnabled`, Settings → Phone + quick-pair popover)
  shows for everyone; the standing host reconciles on `enabled && relayAllowed()` alone, with no
  quota metering at `onPeerReady`. **Entitlement passthrough remains**: a stored Pro entitlement is
  sent on mints, else the `{deviceId,…}` body (host-token `{deviceId, hostPublicKeyB64}`, plus
  `popChallenge`/`popProof` when the backend supports it; device mint `{deviceId, hostDeviceId,
  hostPublicKeyB64, label}`). **The backend is the real gate now**:
  `POST /v1/relay/host-token` / `/v1/relay/device` must admit deviceId (no-entitlement) mints, and
  the relay server may rate-limit free hosts independently — a client-side gate must NOT be
  reintroduced to work around a backend refusal (fix the backend policy instead).
- **A paused phone stream is resumed by a drain sweep, never by "the next chunk"**
  (`main/remote/host-service.ts`, FLOW_SWEEP_MS). `sendFrame` refuses — and drops — a frame once the
  relay socket holds >8 MB, and the host pauses the pty; a paused node-pty emits no `onData`, so the
  old resume-on-next-successful-send never fired and the phone's terminal froze until it detached.
  A 250 ms sweep, armed only while a stream is paused and cleared in
  `dropStream`/`closeAll`, waits for `bufferedAmount() <= 256 KB`, then capture → `OP.Snapshot*` →
  `setFlow(resume)`, in that order (the dropped frame desynced the phone; resuming first lets live
  output race the repaint). The repaint is NOT the attach snapshot's bytes: the phone feeds a
  snapshot into its emulator with no reset, over the old screen, so the resume payload
  (`resumeRepaintText`, `@shared/capture-paint`) is SGR reset + home + clear, the screen with CRLF
  line endings (SwiftTerm runs convertEol off) and one trailing newline dropped, then the pane's
  cursor when `PtyManager.captureVisible` read it (else the attach's own capture, no cursor). The
  attach snapshot, painted into an empty emulator, stays the raw capture. A refused repaint retries with backoff (250 ms doubling to 10 s: a
  reconnecting relay reads 0 buffered but refuses every send, so no backoff = a tmux capture per
  tick). Output still queued after the pause is dropped, not streamed. An empty
  capture resumes WITHOUT a repaint — unlike `ui-sink-registry`'s keep-desynced rule, staying here
  means staying frozen. The same drain-sweep pattern as `core/ui-sink-registry.ts` (whose self-paced
  sinks are never dropped at all); do not reintroduce a chunk-driven
  resume. `~/.nodeterm/relay.json` is written only when its content changes or the file is missing
  (`relay-advertise.ts`): the ~90 s listener cycle used to rewrite it identically (~960/day).
- **The phone's Chat screen verbs** (`chat.page` / `chat.status` / `chat.send` / `agent.answer`,
  `host-service.ts` `handleChat` → `main/remote/host-chat.ts`, spec + exact error strings in
  `docs/mobile-chat-view.md` §3.2). Four rules a refactor must not undo: (1) **the phone sends only a
  node id**; cwd/account/agent/session are resolved from THIS machine's records
  (`WorkspaceStore.getNodeResolved` + the mirror). The session id is asked of the RENDERER's
  agent-status store first (what ⌘M reads; after a restart a hook-fed id lives only there), the
  mirror / minted id only as a fallback; the cwd rides only for a REMOTE node with a known id, so a
  local known-but-dead id — or no id at all — reads NOTHING rather than claude's cwd-newest fallback
  (a stranger's session). An SSH-project node is read REMOTE-ONLY (`remoteOnly`): over its live
  pty's master, else its PROJECT's (`remoteTargetForNode` — an idle tab or any node after a restart
  has no pty, and resolving through the pty alone sent it to THIS machine's disk), and a remote read
  that cannot happen is `unreadable` ⇒ "Could not read the transcript.", never `found:false`. Only
  chat-capable agents are served (`canChat(capabilityAgentId(agent))`); (2) **the send gate is the host mirror's, then the renderer's** — refused
  first when the mirror says working/waiting/blocked or holds a question/approval ticket (renderer
  state is transient after a reload), then an IPC round-trip (`host:chat-query` /
  `host:chat-reply`, sender-checked to the main window) answered from the agent-status store and the
  ⌘M composer's `chatSendRefusal` at send time plus "no held request". A renderer that does not
  answer FAILS CLOSED: status is an error; `'refused'` (with a `reason`) means nothing was typed
  (no window, a gate, past `startBy`, or `busy` — one send per node in flight until it SETTLES),
  while a send whose outcome the desktop cannot confirm (no answer in time, or a `sendText` that
  rejected after starting — it may or may not have been typed) is `'unconfirmed'`, never `'refused'`,
  which would invite the phone to resend and type the prompt twice. `ChatStatus` carries the mirror's
  view too (`hostRefuses`/`refusal`, `version: 1`): after a restart the window's `state` is null while
  the mirror may still hold a live dialog, and the phone must see the lock the send applies; (3) **text is capped raw (64000) then stripped of ESC + C0/C1** (`\n`/`\t` kept) and
  rides `pty.sendText` (stdin into tmux, never argv); `'sent'` only for `sendText === true`;
  (4) **`agent.answer` is the desktop answer path** — `answerHeldPermission` over the SAME
  `heldPermissionIoFor` (local fs or the SSH ControlMaster) and the in-process structured-ticket
  gate, and the `pendingId` must be THIS node's (a mirror approval ticket for it, or the renderer's
  `held.pendingId`), else `false` with no I/O and no answered event on the wrong node. The `chat`
  dependency is OPTIONAL at every hop, so a dropped hop compiles and ships the verbs
  inert ("not served"); `host-chat-wiring.test.ts` pins the chain at source level. Served only to an
  approved phone; Team-access relay guests never reach them (`relay-host.ts` serves no phone
  dialect). Server Edition: N/A (no phone relay; the bridge subscription is inert).
- **One relay pin store per ROLE, and only the phone store admits anyone** (`main/remote/approved-devices.ts`).
  `phonePins` (`remote-approved-phones.json`) is what the standing host auto-approves from, silently,
  with the full phone vocabulary; `guestPins` (Team Access desktops we host) and `joinedHostPins`
  (hosts we joined) are records that nothing reads to admit. They used to be ONE file, so a host you
  once joined, or a guest whose seat you revoked, was auto-admitted as a phone. The pre-split
  `remote-approved-devices.json` is deleted at boot and NOTHING in it is carried over: nothing on
  this machine can tell its roles apart (the phone's relay box key is never sent at pairing, so
  agent.json cannot vouch for one), so every phone re-approves by SAS once. **Every revoke goes
  through `main/remote/peer-revoke.ts`**: unpin from the named role stores, then run every
  registered host killer (standing host pool incl. pending consent, the interactive `initRemoteHost`
  session, the Team Access `live` set). A revoke that knows only one host leaves the others serving.
  Phone "Remove" (`pairing-service.revokeDevice`) revokes ALL phone pins and cuts ALL phone relay
  sessions, before the SSH key and the device entry go — all-phones because no box key maps to a
  device; a failure reports `local:false` and keeps the device listed to retry.
- **Phone pairing is platform-neutral, and revoke still speaks the iOS-era stamp.** New keys are
  stamped `nodeterm-mobile-<deviceId>` (`pairing-core.deviceCommentFor`); `filterAuthorizedKeys`
  matches BOTH that and the legacy `nodeterm-ios-<deviceId>` (`deviceCommentsFor`), because every
  iPhone paired before Android existed carries the old stamp — drop the legacy leg and "Remove"
  reports a phone removed while its SSH key stays live. The device name is what the phone sends
  (Android sends one), sanitized to one ≤64-code-point line; with none it is `'Phone'`, EXCEPT the
  iOS app — which has never sent a name — is recognised by its fixed key comment `nodeterm-ios` and
  keeps `'iPhone'`. Store links go through `renderer/lib/links.ts` `mobileStoreLinks()`; the Play
  link is hidden by the single `ANDROID_APP_PUBLISHED` flag until the listing exists, and
  `mobileStore.guard.test.ts` refuses a direct store URL anywhere else in the renderer. `LicenseSource` includes
  `'google'` (a Play purchase bridged from the phone, `google:<orderId>`), with its own
  `licenseCopy` sentence. `settings.mobileLiveActivities` keeps its key; the UI says "Live updates
  on phone".
- **A Windows desktop pairs relay-only — no SSH key, and do not "fix" that by writing one.** The
  phone's direct-SSH path is POSIX sh + tmux end to end (nodeterm-ios `HostCommands`, `TmuxBinary`,
  the typed `tmux new-session -A` attach, workspace paths with no `%APPDATA%` candidate). Windows
  OpenSSH hands out `cmd.exe`, and sessions live in the session host, which nothing on the phone
  can attach to over SSH. So on win32 `createPairingService` installs no key, the QR carries
  `"ssh":false`, the QR is gated on the RELAY instead of sshd (`shared/pairing-gate.ts`), and a
  failed relay mint pairs NOTHING (502 to the phone, `reason:'relay-failed'` to the UI) instead of
  the SSH platforms' LAN-only degrade. **A key sshd accepts makes things worse, not better**: the
  phone tries SSH before the relay, so a working key pins it to a path that cannot work, where a
  rejected one lets it fall through. Issue #758's `administrators_authorized_keys` rule is detected
  (`main/windows-ssh-keys.ts`) only to explain the missing key; revoke still sweeps that file IN
  PLACE (a temp + rename would swap its Administrators+SYSTEM ACL for the directory's, and sshd
  would then refuse every admin key in it). Relay attach on Windows rests on the session host
  being packaged (#575, shipped by #579): without that bundle `pty.attach` spawns a new plain shell
  instead of joining the node's session, while `sessionExists` still answers "warm".

- **The phone never types shell syntax into a relay host** (relay-only hosts — every Windows
  pairing — have no SSH, and a Windows pane is pwsh/cmd). `pty.attach { launch: {agentId,
  sessionId?, cwd?, accountId?, permissionMode?} }` makes the HOST launch, only into a session the
  attach CREATED, exactly once (`core/relay-launch.ts`, `PtyManager.prepareRelayAttach`): every
  field re-validated, cwd jailed to the fs roots, cwd/account folded into the SPAWN options of an
  unrecorded node (a recorded node keeps its records), and the line built for the pane's real
  parser — `assembleResumeCommand` on POSIX, the trusted Windows planner when its resolver is
  wired, else only a dialect-neutral line. Reply `launched: true` = "type nothing", and it is only
  promised after a preflight build succeeded (`relayLaunchPreflight` — an unset `${env:…}` or a
  non-neutral custom line on a Windows pane answers `launched:false`, never a launch that silently
  never comes). The reply also says `paneShell: 'posix' | 'windows'` — whether a typed POSIX line is
  safe in THAT pane, which is not `hostPlatform`: a Windows desktop's SSH-project node runs on a
  POSIX host (not host-launched; the phone types as before). Without `launch` the reply is
  byte-identical. `pty.scroll` writes the wheel only on a tmux /
  mouse-requesting pane (`PtyManager.scrollRoute`); a session-host / plain stream's reply says
  `scroll:'local'` and its snapshot is the full buffer. Keyed answers ride `agent.key` (closed key
  set, host-side state + open-ask guard, hook reply first; an SSH-project node with no client held
  goes over its owner's ControlMaster or nowhere — never the local socket), read-acks `inbox.ack`
  (`applyPhoneReadAck`, the ack sweeper's body), plus `fs.browse` (home-jailed, dirs only) and
  `pty.capture`; `host.info` lists them. All additive — an old phone keeps its old path.

### Standing phone consent lifetime (#819)

A browse socket can close before the human clicks the SAS dialog. `core/phone-approval.ts` retains
only the handshake-bound id/key for 120 seconds, at most 64 requests, one per key. Socket closure
releases presence and transport but does not discard that bounded consent; replacement, rejection,
expiry and host stop clear the exact dialog id. Approval requires BOTH id and displayed key (no
key-only match or mismatched-key fallback), consumes once, then persists before granting access.
`remote:phone:approve` is raw, owner-window Electron IPC, never a relay RPC. Its response separates
stale/persistence failure from approved/saved-disconnected; renderer rejection/timeout is explicitly
unconfirmed. SAS derivation and mutual trust verification are unchanged. Legacy interactive offers
remain session-only, and Server Edition rejects standing phone approval as unsupported.

Pin/revoke mutations use `updateApprovedDevices` to queue the entire read/modify/write in process;
unique-temp atomic rename alone cannot prevent lost updates. Non-ENOENT reads and malformed JSON
reject rather than overwrite unknown trust state. The queue is not a cross-process lock. A click
accepted before host stop may finish its disk save, but must never open the now-closed session.

## Push webhook (a script or CI job rings the paired phone)

Settings → Phone → **Push webhook** mints a per-host bearer token; anything that can run `curl`
then pushes a plain-text notification to the phones relay-paired with this machine
(`POST $NODETERM_API_BASE/v1/push/webhook`, `{"title","body"}`; with that variable unset the panel is
disabled and the client refuses before calling anything). Agents already push through
their hooks; this is for the jobs that have no agent in the loop. The backend half lives in
nodeterm-server (`src/routes/push-webhook.ts`, `src/lib/host-proof.ts`); the desktop half is
`core/push-webhook.ts` (client), `shared/push-webhook.ts` (types, copy, the example) and
`PushWebhookPanel.tsx`. Rules a change must keep:

- **Minting, reading and revoking need the relay host SECRET key, not the public identity.** Other
  host-authenticated backend routes accept `(hostDeviceId, hostPublicKeyB64)` alone — except, since
  R44, for a LATCHED host (one that has proven its key once; every host after
  `POP_REQUIRED_AFTER`), whose host-token mint also needs a relay PoP proof and whose host-mode
  notify / live-update need a `hostAuth` session (§ Hosted team relay). Both fields are known to
  every paired phone; for a send that only lets the holder reach phones that already
  trust the host, but a webhook token is DURABLE — whoever can mint or revoke one can keep a live
  token or silently cut the owner's CI alerts. So each management call is a challenge: the server
  answers with an ephemeral X25519 key (derived from its own secret + the challenge, so no state
  and any instance verifies), and main returns `HMAC-SHA256(X25519(hostSecret, ephemeral),
  context)` with `context` = domain, challenge, action, host device id. The key never leaves main;
  a proof for `status` cannot be spent on `revoke`; a challenge lives 5 min and is single-use per
  process. `webhookProofContext` and the server's `proofContext` are ONE wire contract — change
  both. `core/push-webhook.test.ts` verifies the desktop's NaCl `scalarMult` proof against Node's
  own X25519 (the server's primitive), so the two cannot drift silently.
- **The token is shown ONCE and kept nowhere on this side.** 256 random bits (`ntwh_` + 43
  base64url), stored server-side only as its SHA-256 (a fast hash is right for a high-entropy
  token), returned `Cache-Control: no-store`. The panel holds it in component state until "Done";
  it is never written to settings.json, storage or a log (the panel test asserts local/session
  storage). There is no "show again" — Rotate mints a new one and revokes the old. One live token
  per host is enforced by a partial UNIQUE index on the backend (`host_id WHERE revoked_at IS
  NULL`), not by the mint's transaction: under READ COMMITTED two concurrent first mints each see
  no live row and both insert.
- **Viewing the page calls nothing without a paired phone.** The client asks `hasPairedPhone` (the
  same local check as `pushHasPairedPhone`: a phone pin or a registry device) BEFORE reading the
  host key or the network: the first read of `remote-host-key.json` CREATES it, and a status call
  sends the device id + public key to the backend — neither may happen because someone opened
  Settings → Phone. A failed local check reads as "no phone". And settings search unmounts and
  remounts every row, so the panel reuses its last status answer for 5 minutes
  (`STATUS_REUSE_MS`, module state) instead of spending a challenge + status round trip per remount
  against a per-IP budget that everyone behind one NAT shares.
- **The example never puts the token on argv.** `pushWebhookCurlExample` (labelled `sh`) reads
  `$NODETERM_WEBHOOK_TOKEN` and feeds the header to `curl --config -` through `printf` (a shell
  builtin), the house rule for every credential we generate. Windows has no `sh`, so there is a
  `PowerShell` twin (`pushWebhookPowerShellExample`): `Invoke-RestMethod` makes the request
  in-process, so there is no child argv at all (and PowerShell 5.1 mangles JSON quotes passed to
  `curl.exe`). `shared/push-webhook.test.ts` runs the
  example under a real `/bin/sh` with a recording curl and asserts the token reached stdin and not
  argv.
- **The push is labelled and inert.** Subtitle `Webhook · <hostname>`, its own `thread-id`, the
  phone's existing no-action category `AGENT_DONE`, and an `nt` block with `kind: 'webhook'` and no
  `nodeId`, so a tap opens the Inbox and nothing else: no Allow/Deny buttons, no deep link, no URL
  opened. Title is one line (≤ 120 code points), body ≤ 500; C0/C1 controls, lone surrogates and
  the bidi/zero-width controls are stripped — NOT all of `\p{Cf}`, which holds ZWJ and the tag
  characters (👨‍💻, subdivision flags) — and a payload over APNs' 4096 bytes is refused with a 413
  rather than answered `sent: 0` (lone surrogates JSON-escape to 6 bytes each; measured 4103 bytes
  before they were stripped).
- **KNOWN GAP — needs an iOS release upstream.** The phone shows these pushes without a release
  (unknown `kind` + no `nodeId` routes to a plain Inbox open), EXCEPT while its Inbox sheet is open:
  `PushPresentation.shouldSuppressBanner` suppresses every push then (the live feed is assumed to
  show it), so `willPresent` presents nothing — no banner, no sound, no Notification Center entry —
  and a webhook message never appears in the Inbox feed. It is lost. The fix is phone-side: do not
  suppress `nt.kind == "webhook"`.
- **Budgets:** 10 per minute per token, 60 per hour per HOST (keyed by hostId, so rotating does not
  reset it), 20 mints per host per day, plus per-IP shields. Fan-out = exactly a host-mode
  `/v1/push/notify`: this host's live relay pairings with a live APNs registration, minus phones
  that muted this host.
- **Relay-paired phones only.** An SSH-granted phone (push grants) has no row the backend can tie to
  this host, so it does not receive webhook pushes; minting with no live pairing answers
  `no_paired_phone` and the panel says so. The desktop refuses before calling at all when it knows
  of no paired phone, so a token left live after every phone is unpaired cannot be revoked from
  here until a phone is paired again (it sends to nobody meanwhile).
- **No canvas-control verb.** An agent already has hook-driven pushes, and a verb would need the
  desktop to hold the token, which it deliberately does not.

Surfaces: Desktop full. **Server Edition: N/A** — it has no relay host key or paired-phone
registry (same degrade as `push-notify.ts`); the bridge answers `E_UNSUPPORTED` and the row is
hidden in a browser tab. IPC is under `pairing:` so `HOST_ONLY_CHANNEL_PREFIXES` keeps it off the
relay. **Mobile:** the Inbox-open gap above needs an iOS release; an iOS follow-up could also give
`kind: 'webhook'` its own Inbox row and tap target.
