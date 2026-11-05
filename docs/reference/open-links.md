# nodeterm:// links

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## `nodeterm://` links (another app asks to open a node)

`nodeterm://open?agent=…&project=…|project-cwd=…&cwd=…&prompt=…|prompt-file=…&title=…&source=…`
lets an app with no node identity (a review tool, a script, a bookmark) ask for ONE node; the human
approves every link in a confirm sheet. Spec + as-built decisions:
`docs/superpowers/specs/2026-10-13-open-link-design.md`. Parser `@shared/open-link`, service
`main/open-link.ts` (electron-free, tested), wiring `main/open-link-wiring.ts`, sheet
`components/OpenLinkSheet.tsx`. Invariants:
- **Behind a flag, OFF by default** (`settings.allowOpenLinks`, Settings → Behavior "Allow
  nodeterm:// links"). Main reads it on every link and again on accept; off, a link is not even
  parsed — one notice says where to turn it on. The scheme is still registered, so the notice is
  what a click meets.
- **The parser refuses, never drops**: unknown/duplicate params, over-cap values, relative paths,
  controls. No canvas-control power flags exist here; `source` is display-only.
- **Paths are stat'ed before the sheet, so a path may not reach another machine.** A POSIX-form
  path with a backslash is refused (Windows reads `/\host\share` as UNC and a stat there
  authenticates to that host — NTLM), as are UNC and the macOS automount roots `/net`, `/Network`.
- **Nothing the sheet would not show reaches the agent**: `hasHiddenText` (every `\p{Cf}` except
  ZWJ, plus C1 — bidi overrides, zero-width, Unicode TAG "ASCII smuggling") refuses an inline
  prompt, a prompt file's text, every path and every label. The sheet prints the prompt's size.
- **The permission mode shown is the one launched.** A new-project choice adopts the folder's
  committed `project.json`, so the sheet probes it (Open waits) and labels from it; a mode that
  differs at landing refuses. `bypassPermissions` gets a warning in the sheet.
- **The prompt file is read from ONE non-blocking open** (no stat first, `O_NONBLOCK` so a FIFO
  cannot park a thread, looped read to EOF/cap). A project whose folder changed while the sheet was
  up refuses on accept; `/`, the home folder and its ancestors are never offered as a new project.
- **Main is the authority**: it resolves project candidates from ITS workspace index (SSH and
  handed-off projects never offered), stats the cwd, reads `prompt-file`, and on accept re-checks
  the renderer's choice (a candidate id or the offered new-project folder), re-reads the file,
  refuses if it changed, and copies it into `<userData>/launch-prompts`. Requests are single use and
  expire after 10 min.
- **Delivery**: `open-url` registered in `will-finish-launching` (macOS), argv on cold start and in
  `second-instance` (Windows/Linux); held until the renderer calls `openLink.ready()`, held again on
  every page death (`clearRendererKeyState`). 5 links a minute; a second link replaces only an
  untouched sheet. The window raise is the shared `raiseForUserLaunch`.
- **The sheet**: Enter never opens, nor Space on the focused button (`detail === 0` is ignored);
  Open is disabled for 1 s, then a pointer click only. A second link replaces the sheet only within
  that first second and untouched — after that it is dropped (reading fires no event). An accepted
  link waiting for its project to load is dropped after 30 s, never created later.
- `pair`/`join` links open the existing code prompt pre-filled; never auto-connect.
- Desktop only. Server Edition stub is inert; `open-link:` is a host-only prefix. A dev run registers
  the scheme only with `NODETERM_DEV_PROTOCOL=1`. An `NT_MULTI` sandbox takes links (argv,
  `second-instance`, `open -a <Electron.app> 'nodeterm://…'`) only with that variable and never
  registers the scheme — that is the live-test setup beside an installed app.
