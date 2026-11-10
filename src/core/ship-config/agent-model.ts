import type { ShipAgentModel } from '../../shared/ship-config'

/**
 * An agent file with its `model:` frontmatter line set to `model`, or null when the file has no
 * frontmatter block to put it in (nothing is ever invented around a person's file).
 *
 * The block is found the way `parseFrontmatter` (core/chat-catalog.ts) finds it, so the line written
 * is the line discovery reads back: an optional BOM, a first line `---`, and the next line that starts
 * with `---`. Inside it, every `model:` line (keys are case-insensitive there too) gets the new value,
 * keeping its own key spelling and spacing; with none, one is added just before the closing line. Every
 * other byte stays as it was: other keys, comments, line endings (CRLF too) and the whole body, where a
 * `model:` line is prose and is left alone.
 */
export function setFrontmatterModel(text: string, model: ShipAgentModel): string | null {
  const bom = text.startsWith('﻿') ? '﻿' : ''
  const lines = text.slice(bom.length).split('\n')
  if (lines.length < 2 || lines[0].replace(/\r$/, '') !== '---') return null
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith('---')) {
      close = i
      break
    }
  }
  if (close < 0) return null
  let found = false
  for (let i = 1; i < close; i++) {
    const m = /^(model\s*:[ \t]*)(.*?)(\r?)$/i.exec(lines[i])
    if (!m) continue
    lines[i] = `${m[1]}${model}${m[3]}`
    found = true
  }
  if (!found) {
    const cr = lines[0].endsWith('\r') ? '\r' : ''
    lines.splice(close, 0, `model: ${model}${cr}`)
  }
  return bom + lines.join('\n')
}
