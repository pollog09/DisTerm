// Pure part of handoff: what the fork is asked to write, where the file goes and what the
// command says afterwards. No engine calls here, so DisTerm's own tests import this file directly.

/** What the fork is asked. It already holds the whole chat, so the prompt only says what to write. */
export const HANDOFF_PROMPT = [
  'Stop the work for a moment. You have no tools for this reply; write text only.',
  '',
  'Another agent will pick this work up in a brand-new session. It will see nothing of this',
  'conversation except the document you write now, so leave out nothing it needs and assume it',
  'knows nothing about the project beyond what you put here. Be concrete: file paths, commands,',
  'names, numbers and error messages exactly as they appeared. Skip pleasantries and history',
  'that no longer matters.',
  '',
  'Write it in Markdown under these headings, in this order:',
  '',
  '# Handoff',
  '## Goal: what the person wants in the end, and how they will judge it done.',
  '## Decisions: each choice made so far, with the reason for it and any option ruled out.',
  '## Where things stand: what works now, what is half done, what was checked and how.',
  '## Files: every file created, changed or important to read, one line each on its role.',
  '## Open problems: bugs, unknowns, failing checks, questions still waiting on the person.',
  '## Next steps: a numbered list the new agent can follow from its first command on.',
  '',
  'Reply with the document alone.',
].join('\n')

/** The file's base name: `<node id or session id>-<epoch ms>.md`, made of safe characters. */
export function handoffFileName(owner: string, nowMs: number): string {
  const cleaned = owner.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'session'
  return `${cleaned}-${Math.max(0, Math.floor(nowMs))}.md`
}

/** Strips a code fence the model may have wrapped the whole document in. */
export function cleanDocument(text: string): string {
  const t = text.trim()
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(t)
  return (fenced ? fenced[1]! : t).trim() + '\n'
}

export type ForkFailure = 'nothing-to-fork' | 'api-error' | 'empty-reply' | 'aborted'

/** What the command says when the fork gave no document. */
export function failureText(reason: ForkFailure): string {
  switch (reason) {
    case 'nothing-to-fork':
      return 'Handoff: nothing to summarize yet. Run it after the chat has had a turn.'
    case 'api-error':
      return 'Handoff: the request for the summary failed. No file was written; try again.'
    case 'empty-reply':
      return 'Handoff: the model sent back no text. No file was written.'
    case 'aborted':
      return 'Handoff: the summary was cut off before it finished. No file was written.'
  }
}

export function doneText(path: string, chatTokens: number, docTokens: number): string {
  return [
    `Handoff written to ${path}`,
    `(about ${docTokens.toLocaleString('en-US')} tokens, from a chat of ${chatTokens.toLocaleString('en-US')}).`,
    'DisTerm opens it in a new agent node, which starts from this file instead of the whole chat.',
  ].join(' ')
}

export const OFF_TEXT = 'Handoff is switched off in DisTerm (Token savers).'
