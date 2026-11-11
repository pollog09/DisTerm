// input-router: a large file read or connector result goes to Haiku first, and Claude reads
// Haiku's notes plus where the full text is, instead of the full text.
//
// How a result is rewritten. A hook's `{ result }` for a built-in tool is checked against that
// tool's output schema and mapped for the model by the tool's own mapper, so:
// - Read: the answer stays a valid `type: "text"` Read record whose content is a short pointer
//   (path, size, how to fetch exact lines), and the notes ride in `context`, the reminder the model
//   reads right after the result. Putting the notes in `content` would have the mapper number their
//   lines as if they were the file's, which Claude would confuse with real line numbers.
// - Bash `cat <file>`: Bash's record with `stdout` replaced by pointer + notes.
// - MCP tools (no schema): the same kind of value the server gave (a string or text blocks),
//   holding pointer + notes; the full text is saved under ~/.nodeterm/token-savers/full/.
// Any failure, a slow or failed Haiku call, or notes that save too little returns the tool's own
// result untouched.

import type { EngineInterface, ModelUsage, Register } from 'claude-code'
import {
  estimateTokens,
  helperUsage,
  isBrowserTool,
  isModOn,
  isWindows,
  recordSaving,
  safeName,
  saversPath,
  writeWhole,
} from './common'
import {
  NOTES_MAX_TOKENS,
  NOTES_SYSTEM,
  NOTES_TIMEOUT_MS,
  clipMiddle,
  countLines,
  isBigEnough,
  isPdfPath,
  mcpText,
  notesAreWorthIt,
  notesPrompt,
  numberLines,
  plainCatTarget,
  pointerText,
  readIsWhole,
  withMcpText,
  type NotesKind,
} from './routing'

type Engine = EngineInterface
const MOD = 'input-router'
const HELPER = 'haiku'

interface Notes {
  text: string
  usage: ModelUsage
}

async function writeNotes($: Engine, kind: NotesKind, label: string, source: string): Promise<Notes | null> {
  const body = kind === 'file' ? numberLines(source) : source
  const clipped = clipMiddle(body)
  const reply = await $.model.complete({
    model: HELPER,
    system: NOTES_SYSTEM,
    prompt: notesPrompt(kind, label, clipped.text, clipped.isClipped),
    maxTokens: NOTES_MAX_TOKENS,
    timeoutMs: NOTES_TIMEOUT_MS,
  })
  if (!reply.isAnswered || !reply.text.trim()) return null
  return { text: reply.text.trim(), usage: reply.usage }
}

let pdftotextSeen: boolean | null = null

/** pdftotext on a Linux host, looked up once per load. */
async function hasPdftotext($: Engine): Promise<boolean> {
  if (pdftotextSeen !== null) return pdftotextSeen
  try {
    if (await isWindows($)) return (pdftotextSeen = false)
    const ran = await $.process.run(['sh', '-c', '[ "$(uname -s)" = Linux ] && command -v pdftotext'], {
      timeoutMs: 5000,
    })
    pdftotextSeen = ran.exitCode === 0 && ran.stdout.trim() !== ''
  } catch {
    pdftotextSeen = false
  }
  return pdftotextSeen
}

export const register: Register = (on) => {
  // `/input-router full` lets the next large result through whole, once.
  let isFullNext = false
  const takeFull = (): boolean => {
    const was = isFullNext
    isFullNext = false
    return was
  }

  on('session.start', async ($, e, next) => {
    await $.command
      .register({
        name: 'input-router',
        description: 'Input Router: "full" lets the next large read through whole',
        argumentHint: '[full]',
      })
      .catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'input-router' }, async (_$, e) => {
    if (e.args.trim() === 'full') {
      isFullNext = true
      return { text: 'Input Router: the next large read goes through whole.' }
    }
    return { text: 'Input Router: /input-router full lets the next large read through whole.' }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isMcp = tool.startsWith('mcp__')
    if (tool !== 'Read' && tool !== 'Bash' && !isMcp) return next(e)
    if (isMcp && isBrowserTool(tool)) return next(e)
    if (!(await isModOn($, MOD))) return next(e)

    // ---- Read ----
    if (e.tool === 'Read') {
      if (readIsWhole(e) !== true) return next(e)
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError) return ran
      const r = ran.result

      let source: string | null = null
      let filePath = e.file_path
      let totalLines = 0
      let seenChars = 0
      if (r.type === 'text') {
        filePath = r.file.filePath
        source = r.file.content
        if (r.file.truncatedByTokenCap) source = await $.fs.read(filePath).catch(() => source)
        totalLines = r.file.totalLines
        seenChars = (ran.text ?? r.file.content).length
      } else if ((r.type === 'pdf' || r.type === 'parts') && isPdfPath(filePath) && (await hasPdftotext($))) {
        const pdf = await $.process
          .run(['pdftotext', '-layout', filePath, '-'], { timeoutMs: 60000 })
          .catch(() => null)
        if (!pdf || pdf.exitCode !== 0 || pdf.isStdoutTruncated) return ran
        source = pdf.stdout
        totalLines = countLines(source)
        // what Claude would have read: the PDF itself, which costs at least its text
        seenChars = source.length
      }
      if (source === null || !isBigEnough(source.length)) return ran
      if (takeFull()) return ran

      // a PDF's text is saved beside the ledger so Claude can page through it with Read
      let fullPath = filePath
      if (r.type !== 'text') {
        const saved = await saversPath($, `full/${safeName(e.tool_use_id)}.txt`)
        if (!saved || !(await writeWhole($, saved, source))) return ran
        fullPath = saved
      }

      const notes = await writeNotes($, 'file', filePath, source)
      if (!notes || !notesAreWorthIt(notes.text.length, seenChars)) return ran
      const pointer = pointerText({
        kind: r.type === 'text' ? 'file' : 'output',
        label: filePath,
        fullPath,
        chars: source.length,
        lines: totalLines || countLines(source),
      })

      await recordSaving($, {
        mod: MOD,
        tool_use_id: e.tool_use_id,
        action: r.type === 'text' ? 'read → notes' : 'pdf → notes',
        before: estimateTokens(seenChars),
        after: estimateTokens(pointer.length + notes.text.length),
        helper: helperUsage(HELPER, notes.usage),
        measured: 'estimated',
      })
      return {
        result: {
          type: 'text' as const,
          file: {
            filePath,
            content: pointer,
            numLines: countLines(pointer),
            startLine: 1,
            totalLines: totalLines || countLines(source),
          },
        },
        // A hook's answer replaces what `next` returned, so reminders from hooks beneath are kept.
        context: [...(ran.context ?? []), `[input-router] Notes on ${filePath}:\n\n${notes.text}`],
      }
    }

    // ---- Bash: a plain `cat <file>` ----
    if (e.tool === 'Bash') {
      const target = plainCatTarget(e.command)
      if (!target || readIsWhole({ file_path: target }) !== true) return next(e)
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError) return ran
      const r = ran.result
      if (r.interrupted || r.isImage || r.backgroundTaskId) return ran

      let source = r.stdout
      const isCut = Boolean(r.persistedOutputPath) || r.stdoutHoldsOutputEnd === true
      if (isCut) {
        const whole = r.persistedOutputPath
          ? await $.fs.read(r.persistedOutputPath).catch(() => null)
          : await $.fs.read(target).catch(() => null)
        if (whole === null) return ran
        source = whole
      }
      if (!isBigEnough(source.length)) return ran
      if (takeFull()) return ran

      const seenChars = (ran.text ?? r.stdout).length
      const notes = await writeNotes($, 'file', target, source)
      if (!notes || !notesAreWorthIt(notes.text.length, Math.max(seenChars, source.length * 0.5))) return ran
      const pointer = pointerText({
        kind: 'file',
        label: target,
        fullPath: target,
        chars: source.length,
        lines: countLines(source),
      })
      const stdout = `${pointer}\n\nNotes:\n${notes.text}`

      await recordSaving($, {
        mod: MOD,
        tool_use_id: e.tool_use_id,
        action: 'cat → notes',
        before: estimateTokens(seenChars),
        after: estimateTokens(stdout.length),
        helper: helperUsage(HELPER, notes.usage),
        measured: 'estimated',
      })
      const { persistedOutputPath: _p, persistedOutputSize: _s, stdoutHoldsOutputEnd: _h, ...rest } = r
      return { result: { ...rest, stdout }, ...(ran.context?.length ? { context: ran.context } : {}) }
    }

    // ---- MCP tools ----
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const text = mcpText(ran.result)
    if (text === null || !isBigEnough(text.length)) return ran
    if (takeFull()) return ran

    const saved = await saversPath($, `full/${safeName(e.tool_use_id)}.txt`)
    if (!saved || !(await writeWhole($, saved, text))) return ran
    const notes = await writeNotes($, 'output', tool, text)
    if (!notes || !notesAreWorthIt(notes.text.length, text.length)) return ran
    const pointer = pointerText({
      kind: 'output',
      label: tool,
      fullPath: saved,
      chars: text.length,
      lines: countLines(text),
    })
    const out = `${pointer}\n\nNotes:\n${notes.text}`

    await recordSaving($, {
      mod: MOD,
      tool_use_id: e.tool_use_id,
      action: 'connector → notes',
      before: estimateTokens((ran.text ?? text).length),
      after: estimateTokens(out.length),
      helper: helperUsage(HELPER, notes.usage),
      measured: 'estimated',
    })
    return { result: withMcpText(ran.result, out), ...(ran.context?.length ? { context: ran.context } : {}) }
  }).catch(($, e, next) => next(e)) // once `next` ran, this replays the tool's own result
}
