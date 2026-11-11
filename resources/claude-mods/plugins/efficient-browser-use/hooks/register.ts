// efficient-browser-use: shrinks the screenshots a browser or computer-use MCP tool returns, so
// their long side is at most 1280 px, before Claude reads them. A note after each shrunk image
// gives the scale, so a coordinate read off it can be mapped back for a click.
//
// The tool always runs first; the hook rewrites only the image blocks of its result, in the
// spelling the result came in (MCP `data`/`mimeType` or API `source`). The host's own program does
// the shrinking (sips, ImageMagick, Python's PIL or PowerShell's System.Drawing); with none
// found the images pass as they are, nothing is recorded, and one toast per session says so.

import type { EngineInterface, Register } from 'claude-code'
import { isModOn, isWindows, recordSaving } from './common'
import {
  base64ImageSize,
  blocksOf,
  chooseResizer,
  claudeSizedIt,
  imageIn,
  imageTokens,
  isBrowserTool,
  outputFormat,
  POSIX_PROBE,
  readProbe,
  scaleNote,
  shrinkCommand,
  shrinkTarget,
  withBlocks,
  type Resizer,
  type Size,
} from './images'

type Engine = EngineInterface
const MOD = 'efficient-browser-use'

let resizerSeen: { value: Resizer | null } | null = null

async function findResizer($: Engine): Promise<Resizer | null> {
  if (resizerSeen) return resizerSeen.value
  let value: Resizer | null = null
  try {
    if (await isWindows($)) {
      const ran = await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        timeoutMs: 15000,
      })
      value = chooseResizer('windows', ran.exitCode === 0 ? ['powershell'] : [])
    } else {
      const ran = await $.process.run(['sh', '-c', POSIX_PROBE], { timeoutMs: 15000 })
      const probe = readProbe(ran.stdout)
      value = chooseResizer(probe.platform, probe.found)
    }
  } catch {
    value = null
  }
  resizerSeen = { value }
  return value
}

/** One image shrunk, checked: a smaller, readable image of the planned size, or null. */
async function shrinkOne($: Engine, resizer: Resizer, base64: string, mime: string): Promise<{ base64: string; size: Size } | null> {
  const cmd = shrinkCommand(resizer, mime)
  const ran = await $.process.run(cmd.argv, { stdin: base64, env: cmd.env, timeoutMs: 30000 })
  if (ran.exitCode !== 0 || ran.isStdoutTruncated) return null
  const out = ran.stdout.trim()
  if (!out || out.length >= base64.length) return null
  const size = base64ImageSize(out)
  if (!size || size.width < 1 || size.height < 1) return null
  return { base64: out, size }
}

export const register: Register = (on) => {
  let isFullNext = false
  let hasWarned = false

  on('session.start', async ($, e, next) => {
    await $.command
      .register({
        name: 'efficient-browser',
        description: 'Efficient Browser Use: "full" lets the next screenshot through at full size',
        argumentHint: '[full]',
      })
      .catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'efficient-browser' }, async (_$, e) => {
    if (e.args.trim() === 'full') {
      isFullNext = true
      return { text: 'Efficient Browser Use: the next screenshot comes through at full size.' }
    }
    return { text: 'Efficient Browser Use: /efficient-browser full lets the next screenshot through at full size.' }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!isBrowserTool(tool)) return next(e)
    if (!(await isModOn($, MOD))) return next(e)
    if (claudeSizedIt(e as Record<string, unknown>)) return next(e)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const blocks = blocksOf(ran.result)
    if (!blocks) return ran

    const planned = blocks
      .map((block, index) => {
        const img = imageIn(block)
        const size = img ? base64ImageSize(img.base64) : null
        const target = size ? shrinkTarget(size) : null
        return img && size && target ? { index, img, size } : null
      })
      .filter((p) => p !== null)
    if (planned.length === 0) return ran
    if (isFullNext) {
      isFullNext = false
      return ran
    }

    const resizer = await findResizer($)
    if (!resizer) {
      if (!hasWarned) {
        hasWarned = true
        $.ui.toast('efficient-browser-use: install ImageMagick to shrink screenshots')
      }
      return ran
    }

    const rewritten: unknown[] = [...blocks]
    const notes: string[] = []
    let before = 0
    let after = 0
    const sizes: string[] = []
    for (const p of planned) {
      const shrunk = await shrinkOne($, resizer, p.img.base64, p.img.mime).catch(() => null)
      if (!shrunk) continue
      rewritten[p.index] = p.img.put(shrunk.base64, outputFormat(p.img.mime).mime)
      notes.push(scaleNote(p.size, shrunk.size))
      before += imageTokens(p.size.width, p.size.height)
      after += imageTokens(shrunk.size.width, shrunk.size.height)
      sizes.push(`${p.size.width}x${p.size.height} → ${shrunk.size.width}x${shrunk.size.height}`)
    }
    if (notes.length === 0) return ran
    rewritten.push({ type: 'text', text: notes.join('\n') })

    await recordSaving($, {
      mod: MOD,
      tool_use_id: e.tool_use_id,
      action: sizes.length === 1 ? `screenshot ${sizes[0]}` : `${sizes.length} screenshots shrunk`,
      before,
      after,
      helper: null,
      measured: 'estimated',
    })
    // A hook's answer replaces what `next` returned, so reminders from hooks beneath are kept.
    return { result: withBlocks(ran.result, rewritten), ...(ran.context?.length ? { context: ran.context } : {}) }
  }).catch(($, e, next) => next(e)) // once `next` ran, this replays the tool's own result
}
