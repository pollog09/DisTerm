import type { ClaudeComposer } from './claude-screen'

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

const isRule = (line: string): boolean => /^─{20,}$/.test(line.trim())

// The live input box must end this close to the bottom: below it sit only the status line and
// transient notices, and a capture includes scrollback where old boxes can survive.
const BOX_TAIL_LINES = 4

/**
 * Is GitHub Copilot CLI's composer empty? MEASURED on 1.0.107 (a PTY driven through a terminal
 * emulator): at its prompt the bottom of the screen is `────` rule, a line `❯ <draft>` (continuation
 * lines under it), `────` rule, then the status line. An empty composer is a bare `❯`: no placeholder.
 * The folder-trust dialog and permission prompts replace that box (their `❯` marks a choice such as
 * `❯ 1. Yes`, inside a bordered panel, never between two bare rules).
 *
 * Any text after the `❯` (a draft, a slash-command filter, an answer being typed) reads `draft`, and
 * so would a placeholder if a later version adds one: the error stays on the side of not typing.
 */
export function readCopilotComposer(screen: string): ClaudeComposer {
  const lines = screen.split(/\r?\n/).map((l) => l.replace(ANSI, '').trimEnd())
  if (lines.every((l) => l === '')) return 'unknown'
  let bottom = -1
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - BOX_TAIL_LINES); i--) {
    if (isRule(lines[i])) {
      bottom = i
      break
    }
  }
  if (bottom < 0) return 'no-prompt'
  let top = -1
  for (let i = bottom - 1; i >= 0; i--) {
    if (isRule(lines[i])) {
      top = i
      break
    }
  }
  if (top < 0 || top + 1 >= bottom || !lines[top + 1].startsWith('❯')) return 'no-prompt'
  if (lines[top + 1].slice(1).trim() !== '') return 'draft'
  for (let i = top + 2; i < bottom; i++) if (lines[i].trim() !== '') return 'draft'
  return 'empty'
}
