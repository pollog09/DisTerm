// Pure part of research-router: the tool the main model sees, what the research subagent is told,
// and how its run is matched and its answer turned into the tool's result. No engine calls here,
// so DisTerm's own tests import this file directly.

export const TOOL_NAME = 'Research'

export const TOOL_DESCRIPTION = [
  'Answers a question that needs research on the web, the kind that means searching and reading',
  'several pages: comparing libraries or services, checking current versions, prices, limits or',
  'API behaviour, finding how others solved an error. A cheaper model does the searching and',
  'reading in a context of its own, and you get back a short brief: the answer, the facts behind',
  'it, numbered sources with URLs, and what it could not confirm. Prefer it to calling WebSearch',
  'and WebFetch yourself whenever more than one page would have to be read. Not for questions',
  'about this codebase or the local machine. Ask one self-contained question and include any',
  'detail that narrows it (versions, platform, what was already ruled out).',
].join(' ')

export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'The question, self-contained: the subagent sees nothing of this conversation.',
    },
  },
  required: ['question'],
  additionalProperties: false,
} as const

/** How long the tool waits for the subagent before it gives up and says so. */
export const WAIT_MS = 5 * 60 * 1000
/** How often the tool looks for the answer while it waits. */
export const POLL_SECONDS = 2
/** A question longer than this is cut; the subagent needs the question, not a document. */
export const QUESTION_CHARS = 6000

/** A tag unique to one run, written into its prompt so the run's own turn can be told apart. */
export function runTag(nowMs: number, n: number): string {
  return `rr-${Math.floor(nowMs).toString(36)}-${n.toString(36)}`
}

export function researchPrompt(question: string, tag: string): string {
  const q = question.length > QUESTION_CHARS ? `${question.slice(0, QUESTION_CHARS)} [...]` : question
  return [
    `Research task ${tag}. Another agent is waiting on your answer and will read only your final reply.`,
    '',
    'Question:',
    q,
    '',
    'How to work:',
    '- Use WebSearch to find candidate pages, then WebFetch to read the ones that matter. Base every',
    '  claim on a page you actually opened in this task; do not answer from memory.',
    '- Prefer primary sources: official documentation, changelogs, specifications, the project\'s',
    '  own repository. Treat forum posts and blogs as leads to check, not as proof.',
    '- When sources disagree, say which says what and which one is newer.',
    '- Stop once the question is answered; do not edit files or run commands on this machine.',
    '',
    'Reply in this shape and nothing else, under about 400 words:',
    'Answer: two or three sentences that settle the question.',
    'Key facts: short bullets, each ending with the number of its source, like [2].',
    'Sources: a numbered list, each "title - URL".',
    'Not confirmed: anything you looked for and could not verify, or "nothing".',
  ].join('\n')
}

export function cleanQuestion(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

export const OFF_TEXT =
  'The Research tool is switched off in DisTerm (Token savers). Research with your own tools instead.'
export const NESTED_TEXT = 'Research is not available inside a research run. Use WebSearch and WebFetch directly.'

export function timeoutText(minutes: number): string {
  return (
    `The research subagent did not finish within ${minutes} minutes, so no brief came back. ` +
    'It may still be running in the background. Research with your own tools, or ask a narrower question.'
  )
}

export function failedText(reason: string): string {
  return `The research subagent could not run (${reason}). Research with your own tools instead.`
}

/** The tool's result: the brief, said to come from the Research tool, or why there is none. */
export function resultText(answer: string, isAborted: boolean): string {
  const brief = answer.trim()
  if (!brief) {
    return isAborted
      ? 'The research run was interrupted before it answered.'
      : 'The research subagent finished without writing a brief. Research with your own tools instead.'
  }
  return brief
}
