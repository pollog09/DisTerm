import { describe, expect, it } from 'vitest'
import {
  BODY_BUDGET,
  buildBugReportUrl,
  describeOs,
  describeSurface,
  envBlock,
  REPO_URL
} from './bugReport'

const ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) nodeterm/0.2.7 Chrome/120.0.6099.291 Electron/28.2.6 Safari/537.36'
const LINUX_BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const WINDOWS_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

describe('describeSurface', () => {
  it('detects Electron as desktop', () => {
    expect(describeSurface(ELECTRON_UA)).toBe('desktop')
  })
  it('detects a plain browser as server', () => {
    expect(describeSurface(LINUX_BROWSER_UA)).toBe('server')
  })
})

describe('describeOs', () => {
  it('maps user agents to OS names', () => {
    expect(describeOs(ELECTRON_UA)).toBe('macOS')
    expect(describeOs(LINUX_BROWSER_UA)).toBe('Linux')
    expect(describeOs(WINDOWS_BROWSER_UA)).toBe('Windows')
    expect(describeOs('SomethingElse/1.0')).toBe('unknown')
  })
})

describe('envBlock', () => {
  it('includes version, surface, os and electron version on desktop', () => {
    const block = envBlock({ appVersion: '0.2.7', userAgent: ELECTRON_UA })
    expect(block).toContain('DisTerm: v0.2.7')
    expect(block).toContain('surface: desktop')
    expect(block).toContain('os: macOS')
    expect(block).toContain('electron: 28.2.6')
  })
  it('reports unknown version and omits electron on server', () => {
    const block = envBlock({ appVersion: null, userAgent: LINUX_BROWSER_UA })
    expect(block).toContain('DisTerm: unknown')
    expect(block).toContain('surface: server')
    expect(block).not.toContain('electron:')
  })
})

describe('buildBugReportUrl', () => {
  const env = { appVersion: '0.2.7', userAgent: ELECTRON_UA }

  it('builds an issues/new URL with title, body and bug label', () => {
    const { url, truncated } = buildBugReportUrl('Crash on resize', 'Steps here', env)
    expect(truncated).toBe(false)
    const u = new URL(url)
    expect(url.startsWith(`${REPO_URL}/issues/new?`)).toBe(true)
    expect(u.searchParams.get('title')).toBe('Crash on resize')
    expect(u.searchParams.get('labels')).toBe('bug')
    const body = u.searchParams.get('body')!
    expect(body).toContain('Steps here')
    expect(body).toContain('DisTerm: v0.2.7')
  })

  it('truncates an over-budget description with a marker', () => {
    const long = 'x'.repeat(BODY_BUDGET + 500)
    const { url, truncated } = buildBugReportUrl('t', long, env)
    expect(truncated).toBe(true)
    const body = new URL(url).searchParams.get('body')!
    expect(body).toContain('… (truncated)')
    expect(body.length).toBeLessThanOrEqual(BODY_BUDGET)
    // env block must survive truncation
    expect(body).toContain('DisTerm: v0.2.7')
  })

  it('does not mark a short description as truncated', () => {
    const { truncated } = buildBugReportUrl('t', 'short', env)
    expect(truncated).toBe(false)
  })
})
