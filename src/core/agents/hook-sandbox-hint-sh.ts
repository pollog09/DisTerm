/**
 * The Codex-sandbox self-diagnosis both generated sh shims share (issue #367).
 *
 * Codex's command sandbox denies network connect() outright when its network policy is disabled —
 * on Linux a seccomp filter EPERMs `connect()` for EVERY address family (unix sockets included,
 * with no allowlist), and on macOS the seatbelt base profile is `(deny default)` with no
 * network-outbound allowance. Either way curl dies with exit != 0 / HTTP 000 while the nodeterm
 * hook server is perfectly healthy, and the shims' generic "nodeterm unreachable" message sent
 * agents (and users) off to relink or restart a server that was never the problem.
 *
 * Codex exports `CODEX_SANDBOX_NETWORK_DISABLED=1` into every sandboxed command on both
 * platforms, so the shims can tell the two failures apart at the exact moment they happen. The
 * remedies differ by platform:
 *  - both: retry the SAME command once with command-specific escalated permissions (the sandbox
 *    is per-command; an escalated retry runs outside it);
 *  - macOS only (codex >= 0.146): `network.allow_unix_sockets = ["<hook sock>"]` in
 *    ~/.codex/config.toml permanently re-opens exactly the hook socket inside the sandbox, no
 *    escalation needed. Linux has no such allowlist, so that line would be a false promise there
 *    — the fragment gates it on `uname -s` = Darwin as well as on the socket being advertised.
 *
 * The message text lives in exported constants so the agent-facing docs (skill bodies + AGENTS.md
 * instruction blocks) can carry the same sentences and the parity tests can hold the two ends
 * together; the sh fragment is exercised against real /bin/sh in the shim test suites.
 */

/** Both platforms, line 1: what actually failed, and what NOT to do about it. */
export const CODEX_SANDBOX_BLOCKED_LINE =
  "Codex's sandbox blocked this connection to DisTerm. DisTerm itself is running — do not relink or restart it."

/** Both platforms, line 2: the one action that works everywhere. */
export const CODEX_SANDBOX_RETRY_LINE =
  'Retry the SAME command once with command-specific escalated permissions (approve the escalation prompt for this command).'

/** macOS only, wrapped around the advertised hook socket path. */
export const CODEX_SANDBOX_MACOS_BEFORE =
  'Permanent fix on macOS: add network.allow_unix_sockets = ['
export const CODEX_SANDBOX_MACOS_AFTER =
  '] to ~/.codex/config.toml — the sandbox then allows this hook socket with no escalation.'

/**
 * POSIX-sh fragment defining `nt_codex_sandbox_hint`: prints the actionable error to stderr and
 * returns 0 when the codex sandbox is the diagnosis, returns 1 (printing nothing) otherwise —
 * so call sites read `nt_codex_sandbox_hint || echo "<the old generic message>" >&2` and the
 * genuine-unreachable case keeps its original text to the byte.
 */
export const CODEX_SANDBOX_HINT_SH = `# Codex-sandbox self-diagnosis (issue #367). Codex exports CODEX_SANDBOX_NETWORK_DISABLED=1 into
# every sandboxed command; when it is present, a dead transport (curl exit != 0 / HTTP 000) means
# the SANDBOX denied connect() — Linux seccomp EPERMs every address family, macOS seatbelt is
# deny-by-default — and the generic "unreachable" message would misdirect the agent into
# relinking/restarting a healthy server. Prints the actionable error and returns 0 only in that
# state; callers fall back to their own generic message on 1.
nt_codex_sandbox_hint() {
  [ -n "$CODEX_SANDBOX_NETWORK_DISABLED" ] || return 1
  echo "${CODEX_SANDBOX_BLOCKED_LINE}" >&2
  echo "${CODEX_SANDBOX_RETRY_LINE}" >&2
  if [ -n "$NODETERM_HOOK_SOCK" ] && [ "$(uname -s)" = "Darwin" ]; then
    echo "${CODEX_SANDBOX_MACOS_BEFORE}\\"$NODETERM_HOOK_SOCK\\"${CODEX_SANDBOX_MACOS_AFTER}" >&2
  fi
  return 0
}`
