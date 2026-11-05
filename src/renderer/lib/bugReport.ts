/**
 * Pure helpers for the "Report a bug" flow: compose an environment block and a prefilled
 * GitHub issues/new URL. No backend, no token — the browser opens GitHub and the user
 * submits under their own account (see docs/superpowers/specs/2026-07-14-help-menu-bug-report-design.md).
 */

export const REPO_URL = 'https://github.com/pollog09/GrafoTerm'

/** Why the Help menu's rows are disabled: this fork takes no bug reports and hosts no docs, so
 *  neither may open a page that looks like it does. */
export const BUG_REPORT_OFF_REASON = 'Not available in this build: DisTerm has no bug tracker.'
export const DOCS_OFF_REASON = 'Not available in this build: DisTerm has no hosted documentation.'

/** GitHub rejects URLs past ~8 KB; keep the pre-encoding body well under that. */
export const BODY_BUDGET = 6000

export interface BugReportEnv {
  /** null = unknown (the Server Edition bridge has no getVersion handler). */
  appVersion: string | null
  userAgent: string
}

export function describeSurface(userAgent: string): 'desktop' | 'server' {
  return /Electron\//.test(userAgent) ? 'desktop' : 'server'
}

export function describeOs(userAgent: string): string {
  if (/Mac OS X|Macintosh/.test(userAgent)) return 'macOS'
  if (/Windows/.test(userAgent)) return 'Windows'
  if (/Linux|X11/.test(userAgent)) return 'Linux'
  return 'unknown'
}

export function envBlock(env: BugReportEnv): string {
  const lines = [
    `DisTerm: ${env.appVersion ? `v${env.appVersion}` : 'unknown'}`,
    `surface: ${describeSurface(env.userAgent)}`,
    `os: ${describeOs(env.userAgent)}`
  ]
  const electron = env.userAgent.match(/Electron\/([\d.]+)/)
  if (electron) lines.push(`electron: ${electron[1]}`)
  return lines.join('\n')
}

const TRUNCATION_MARKER = '… (truncated)'

export function buildBugReportUrl(
  title: string,
  description: string,
  env: BugReportEnv
): { url: string; truncated: boolean } {
  const footer = `\n\n---\n\`\`\`\n${envBlock(env)}\n\`\`\``
  let desc = description.trim()
  const room = BODY_BUDGET - footer.length
  const truncated = desc.length > room
  if (truncated) desc = desc.slice(0, room - TRUNCATION_MARKER.length - 1) + '\n' + TRUNCATION_MARKER
  const params = new URLSearchParams({ title, body: desc + footer, labels: 'bug' })
  return { url: `${REPO_URL}/issues/new?${params.toString()}`, truncated }
}
