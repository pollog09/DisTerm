# Token savers

## Token savers (Claude Code mods DisTerm installs)

The token savers are Claude Code plugins of function hooks ("mods") that DisTerm writes, ships and installs. They save tokens
**inside Claude's own process**: they rewrite a tool's result before the model reads it, and they pick a subagent's model at
spawn. DisTerm runs `claude` in a pty, so it cannot do either from outside. That is why the split is:

- **The mods** (`resources/claude-mods/plugins/*`) hold every saving mechanism. They draw no panes inside the terminal, at
  most a one-line toast, because a node is a small terminal and DisTerm draws the real UI.
- **DisTerm** (`src/core/token-savers/*`, the renderer pieces below) installs them, switches them, and shows what they
  saved. It is the one place that sees every agent on the machine at once.

The mods in this phase:

| Mod | What it does |
|---|---|
| `input-router` | Big `Read`/`cat` results and big connector (MCP) results go to Haiku first. Claude gets short notes and the path to the full text. |
| `model-router` | Haiku judges each `general-purpose` subagent task and picks a tier (light, standard, heavy). It moves a task down only at confidence ≥ 0.6 and up at ≥ 0.3. It never changes the main chat's model. |
| `efficient-browser-use` | Shrinks browser-tool screenshots before Claude reads them. |

**Where they came from.** These are our own code. A third-party pack ("token-saving mods" by Ben AI) was the behavioural
reference: what each mod should do, its thresholds, the idea of a ledger. No code, prompt or text was copied from it. Only
one file of that pack carries a license (`model-router`, MIT, itself a copy of claude-code-templates' "Jev Model Router").
Ours keeps the idea of routing subagents by a judge's confidence and the two bars. The judge's criteria, the tier names
and the option names were written fresh, after a review found that a first draft paraphrased that file's criteria too
closely. Keep it that way: a mod added here is written here, under this repo's license.

**model-router routes only `general-purpose` spawns.** Setting a spawn's `model` overrides the agent definition's own
model, and `agent.spawn` does not say whether a definition names one. So routing any other agent type could silently
replace a model the user chose for it: a `reviewer` pinned to Opus by this repo's CLAUDE.md, or a Haiku-defined agent
moved up. A spawn whose Agent call set `model`, a fork and a resume are never routed either.

**Platforms.** The reference pack was a macOS build (`sips`, `pbcopy`). Every external command in our mods has a Linux/WSL
path and a fallback that does nothing when the tool is missing:

- **Screenshot resize**, tried in this order:
  - macOS: `sips`.
  - Linux and WSL: `magick` (ImageMagick 7), then `convert` (ImageMagick 6), then `python3 -I` with PIL.
  - Windows: PowerShell's System.Drawing.
  - None of these: the picture is left alone and the mod shows a toast once per session.
- **PDF reads:** `pdftotext` when it is on PATH, otherwise the file is left alone.

**Surfaces.**

- **Desktop and Server Edition:** the service lives in core and is booted by both shells, so both get the whole feature.
  On the Server Edition it manages the *server's* Claude.
- **Relay tab:** it keeps the stub (`E_UNSUPPORTED`). The mods belong to the host.
- **SSH projects:** the mods are not installed on SSH hosts yet; the Settings copy says so. The cache clock still works
  wherever the transcript tail works.
- **Mobile:** a note only.

### Ledger and switches

Both files live in the fork's on-disk namespace, `~/.nodeterm/token-savers/`. It is shared by every managed Claude account,
so one ledger covers them all. The contract is `src/shared/token-savers.ts`.

**`savings.jsonl`.** The mods append one line per action; DisTerm only reads it.

- Line shape: `{ ts, session, nodeId, tool_use_id, mod, action, before, after, helper, measured, usd_saved? }`.
- `before` and `after` are tokens the main chat would have read and did read. They are estimated as chars / 4 unless the
  line says `measured: 'real'`.
- **`nodeId` is `NODETERM_NODE_ID`** of the session that did the action, which DisTerm already sets in every pty it
  starts. With it a row maps to its canvas node without guessing from session ids. It is null outside DisTerm.
- **One action per `tool_use_id`** (per mod). A later line replaces an earlier one, but an `estimated` line never replaces
  a `real` one.
- **Left out, not hidden.** A line is shown but counted in no total when:
  - `before` is over 500,000; or
  - the cut is more than 1000x; or
  - `after` is bigger than `before`.

  A broken line is counted in `skipped`. The panel says both numbers.
- **The read is capped.** The service reads the newest 8 MB and keeps 300 rows. "All time" means "in that window", and
  the panel says so (rule 8 of the graph rules: no silent caps).
- **Helper cost** is priced at list price from `MODEL_PRICES`. A model with no price costs 0 there and is not a saving.
  `usd_saved` (model-router) is dollars, not tokens, and can be negative. model-router writes none today: a subagent's
  cost is known only after it ran.

**`full/`.** input-router saves a connector's whole output, or a PDF's text, under `~/.nodeterm/token-savers/full/`, so
that Claude can `Read` the exact part it needs.

- Those files can hold mail or ticket text, so the service deletes any older than 7 days, at boot and every hour
  (`pruneFullOutputs`).
- A file Claude still needs after that is gone. The tool can be run again.

**`switches.json`.**

- `{ "<mod>": false }` turns a mod off; a missing key is on. DisTerm writes the file whole with `writeFileAtomic`, and keys
  it does not know are kept.
- Each mod reads the file on every event, so a switch applies to every running session at once, with no reload.
- An off mod passes every event through untouched.

### Install

`src/core/token-savers/install.ts`. The mods are bundled into the app **as text**, in `bundled.generated.ts`, which is
built from `resources/claude-mods` by `npm run mods:bundle`.

**Why text.** It is the one form that Electron's vite bundle and the Server Edition's esbuild bundle both carry with no
packaging step. `bundled.test.ts` fails when the generated file is stale. It also fails when a plugin's
`hooks/common.ts` no longer matches `resources/claude-mods/shared/common.ts`: plugins cannot import across plugin
folders, so each one carries a copy.

**Install does two things:**

1. **Writes the bundle to `~/.nodeterm/token-savers/marketplace`.** It is a stable folder, never the app's resources path,
   which moves with every update and, in an AppImage, with every launch. Claude reads a directory marketplace from the
   folder itself, so a later DisTerm build that ships new mod files reaches Claude by rewriting that folder. The service
   does that at boot when the mods are installed, gated by a content hash in `.bundle-hash`. Files the bundle dropped are
   removed, so a stale module is never imported.
2. **Registers the mods through Claude's own CLI**, never by a hand edit of `settings.json`:
   - `claude plugin marketplace add <dir> --scope user`;
   - then `claude plugin install <mod>@disterm-token-savers --scope user`;
   - in every local config dir: the default one, plus each managed or linked account through `CLAUDE_CONFIG_DIR`.

   Claude owns that schema, and shared settings are user data (agent-hooks.md, issue #851).

**Other rules:**

- **The version gate.** Claude Code 2.1.287 or newer (`supportsTokenSavers`) is required; an older CLI would install the
  mods and never run them. A missing or old CLI gets a message and no install.
- **"Installed"** means that every mod is `true` under `enabledPlugins` in the default config dir's `settings.json`.
- **Remove** uninstalls each mod and drops the marketplace. "Not installed" and "not found" count as done. The ledger and
  the switches are kept.
- **Two consents.** Nothing is installed at boot or without the user pressing Install. Install also refuses unless the user
  enabled the Claude integration (`settings.agentIntegrations.agents.claude`). Like every other write into an agent's
  config (CONTRIBUTING.md § User-owned agent settings, issue #744), it is gated on that choice.
  - **Only an explicit decline removes.** Declining the Claude integration later removes the mods, once per decline: a
    removal that fails (no `claude` on PATH, say) is not retried on every poll, only after the consent changes again
    or when the user presses Remove. "Never asked" writes nothing and removes nothing, as for every integration.
  - **A veto touches nothing.** The Server Edition's `installHooks: false` refuses Install and Remove and never
    removes on its own, so a desktop sharing that home keeps what it installed.
  - `service.test.ts` pins all of this, and `agent-integrations-wiring.test.ts` allows `installTokenSavers(` and
    `uninstallTokenSavers(` only in `install.ts` and `service.ts`.

### Cache clock

The prompt cache is the other big cost lever: a chat whose cache went cold re-sends its whole context at the full input
price on the next message. DisTerm shows the clock natively, with nothing to install.

- **Where the numbers come from.** `parseLatestUsage` (`core/context-tail.ts`) takes the latest assistant record's
  `timestamp` (`lastReplyAt`) and its cache-write split: any `cache_creation.ephemeral_1h_input_tokens` means a 1-hour TTL,
  otherwise 5 minutes. These ride the existing `ContextWindowUsage` push.
- **Where it shows.** `ContextMeter` draws:
  - the countdown: warm, amber in the last minute, `cold` after that;
  - the node's savings (`−42k`), with a popover link to the Token savings panel.

  `ContextMeter` is the one component behind the node header, the kanban `SessionCard` and `CardModal`, so the three views
  cannot disagree.
- **Keep-warm** (pinging the cache before it expires) is not built. It needs `$.model.fork` inside Claude, so it would be
  a mod, and it costs a request per ping.
