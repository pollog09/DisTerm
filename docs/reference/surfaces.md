# Surfaces: machine naming and board parity

Reference split out of `CLAUDE.md`, which holds the rules every change needs. Words like "above", "below" or "this file" here can mean another file in `docs/reference/`: `git grep` the name there.

## Surfaces: machine naming and board parity

- **The local machine is not a Mac.** Every user-visible string naming it goes through
  `renderer/lib/machineName.ts` (`thisMachine()` / `thisMachineCap()` / `machineNoun()` →
  "this Mac" / "this PC" / "this computer"). A **browser tab always gets the neutral word**: the
  license, seats and sessions it describes belong to the SERVER, and the viewer's `navigator` says
  nothing about that machine's OS — a confident wrong noun is worse than a plain one. Issue #563
  found ~30 such strings, and the damage was not in Accounts but in the copy people must TRUST:
  "This Mac is not authorized on this license" and "a teammate on a seat can run commands on this
  Mac". `machineName.guard.test.ts` scans non-comment lines in `src/renderer` + `src/shared` and
  fails on a new one, with a named-and-reasoned exemption list (the ptmx-limit banner, whose
  `kern.tty.ptmx_max` really is macOS; the onboarding notch step, which only exists there).
  `@shared` code cannot ask the renderer, so it takes the machine word as a PARAMETER defaulting
  to the neutral one (`describeGrant(peer, machine)`) rather than hard-coding a brand.

  **The canvas and the kanban board are TWO VIEWS of the same nodes — treat the board as a
  first-class surface, not an afterthought.** Every session/node feature you add to a canvas node
  (a header action, a context-menu item, a status badge, file drop, dictation, …) should be
  considered for the kanban **card** and its **card modal** too, so we don't keep shipping a
  feature on one view and then bolting it onto the other in a follow-up. The board already mirrors
  most of the node's surface: the card modal co-attaches the same tmux session (`ModalTerminal`),
  carries the node's actions (search / dictate / AI-name / comments), accepts file drops
  (`terminal/file-drop.ts`), renders browser webviews (`BrowserSurface`), and its cards support
  right-click actions + `+ New`. When you touch a node's UI, ask "does the board need this too?"
  and wire it through `KanbanView`/`SessionCard`/`CardModal` in the SAME change. Node menu rows live in ONE builder, `renderer/lib/nodeActionItems.tsx` (canvas menu, sessions sidebar, both boards' card menus via `kanban/cardMenu.tsx`); a card takes only `BOARD_NODE_ACTION_IDS` and writes through `nodeWritesFor(projectId)`, because the Omni board acts on nodes of projects that are not on the canvas.
  The card modal's ⋯ menu takes `BOARD_MODAL_ACTION_IDS` and closes the modal before any action
  runs, because restart-and-shell, switch model, account switch and pause-and-end recycle the tmux
  session its terminal is attached to; a card of a project the canvas does not hold shows these
  rows disabled with 'This terminal is not attached right now.', and a card with no session row
  (a plain shell, a non-resumable agent) gets no ⋯ button at all. A node the canvas holds but
  whose terminal was released while off screen is a different case (`NodeActionCtx.onCanvas`
  true, `attached` false): Refresh stays enabled, since its respawn is what revives the node,
  and the session rows say the terminal was released (`RELEASED_HINT`). Kanban itself is
  desktop+Server-Edition (pure renderer + `workspace.save`); the iOS board is a separate read/move
  mirror (`nodeterm-ios`, `KanbanGrouping`/`ProjectBoardView`).
