// handoff: `/handoff` writes a document a fresh agent can start from, so a long chat can be left
// behind instead of carried. The document comes from `$.model.fork`, which sends the chat as the
// main thread last sent it, so the API serves it from the prompt cache: the chat is read at a
// tenth of its price and only the document is written fresh.
//
// The file lands in ~/.nodeterm/token-savers/handoffs/, and the ledger line names it (`file`):
// DisTerm watches the ledger and opens the file in a new agent node.

import type { Register } from 'claude-code'
import { estimateTokens, helperUsageCached, isModOn, promptTokens, recordSaving, saversPath, writeWhole } from './common'
import { HANDOFF_PROMPT, OFF_TEXT, cleanDocument, doneText, failureText, handoffFileName } from './document'

const MOD = 'handoff'

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: 'handoff', description: 'Write a handoff of this chat for a fresh agent node' })
      .catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($) => {
    if (!(await isModOn($, MOD))) return { text: OFF_TEXT }

    // No `effort`: a level other than the session's own can make the first fork write the whole
    // chat to a cache entry of its own (ModelForkRequest), the very cost a handoff exists to avoid.
    const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
    if (!reply.isAnswered) return { text: failureText(reply.reason) }
    const doc = cleanDocument(reply.text)
    if (doc.trim() === '') return { text: failureText('empty-reply') }

    const nodeId = (await $.env.get('NODETERM_NODE_ID')) || ''
    const session = await $.session.id().catch(() => '')
    const now = await $.clock.now()
    const path = await saversPath($, `handoffs/${handoffFileName(nodeId || session, now)}`)
    if (!path || !(await writeWhole($, path, doc))) {
      return { text: 'Handoff: the summary was written but could not be saved to disk.' }
    }

    const model = await $.session.model().catch(() => '')
    const chatTokens = promptTokens(reply.usage)
    const docTokens = estimateTokens(doc.length)
    await recordSaving($, {
      mod: MOD,
      tool_use_id: null,
      action: 'handoff',
      before: chatTokens,
      after: docTokens,
      helper: helperUsageCached(model || 'unknown', reply.usage),
      file: path,
      measured: 'estimated',
    })
    return { text: doneText(path, chatTokens, docTokens) }
  }).catch(() => ({ text: 'Handoff: something went wrong. No file was written.' }))
}
