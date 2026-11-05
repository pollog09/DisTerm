import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./TerminalNode.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function applyFitBody(): string {
  const start = source.indexOf('const applyFit = () => {')
  const end = source.indexOf('applyFitRef.current = applyFit', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('applyFit reports what the pty has not been told', () => {
  // `sentCols/sentRows` are what the catch-up fit after `create()` compares against. Moving them
  // before the session exists made a fit that changed mid-spawn read as already reported.
  it('moves the sent size only on the branch that reports it', () => {
    const body = applyFitBody()
    const guard = body.indexOf("if (action !== 'report' || !sessionId) return")
    const report = body.indexOf('transport.resize(sessionId, size.cols, size.rows)')
    expect(body).toContain('planFit(')
    expect(guard).toBeGreaterThan(-1)
    for (const assignment of ['sentCols = size.cols', 'sentRows = size.rows']) {
      // Exactly one: a second assignment above the guard is the bug, whatever follows it.
      expect(body.split(assignment)).toHaveLength(2)
      const moved = body.indexOf(assignment)
      expect(moved).toBeGreaterThan(guard)
      expect(report).toBeGreaterThan(moved)
    }
  })
})
