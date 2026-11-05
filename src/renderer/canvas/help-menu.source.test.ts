import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { REPO_URL } from '../lib/bugReport'

// The Help menu is built inline in Canvas. Report a bug and Documentation must stay visible and inert:
// nothing in the app may open a page, or file an issue, on the upstream project.
const SRC = readFileSync(join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('the Help menu', () => {
  it('shows Report a bug and Documentation disabled, each with its reason', () => {
    expect(SRC).toContain("label: 'Report a bug…', disabled: true, hint: BUG_REPORT_OFF_REASON")
    expect(SRC).toContain("label: 'Documentation', disabled: true, hint: DOCS_OFF_REASON")
  })

  it('has no route left to the bug report dialog', () => {
    expect(SRC).not.toContain('BugReportDialog')
    expect(SRC).not.toContain('buildBugReportUrl')
  })

  it('GitHub repository opens this fork', () => {
    expect(REPO_URL).toBe('https://github.com/pollog09/GrafoTerm')
    expect(SRC).toContain('openExternal(REPO_URL)')
  })
})
