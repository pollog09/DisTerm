---
paths:
  - "src/core/pty-*.ts"
  - "src/core/tmux-*.ts"
  - "src/core/zellij-*.ts"
  - "src/core/scrollback-*.ts"
  - "src/renderer/nodes/TerminalNode.tsx"
  - "src/renderer/terminal/**"
  - "src/renderer/components/kanban/ModalTerminal*"
---

Before changing these files, read `docs/reference/terminal-sessions.md`, `docs/reference/terminal-restore.md`, `docs/reference/terminal-rendering.md`. They hold the invariants for this code, why each exists and what was measured. Add a new invariant there, not to `CLAUDE.md`.
