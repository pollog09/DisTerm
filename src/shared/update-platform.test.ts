import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  MANUAL_UPDATE_MODE,
  isManualUpdatePlatform,
  installReadiness,
  mayQuitAndInstall,
  noSelfInstallCopy,
  releaseNotesText,
  shouldEnableUpdater,
  toUpdateAvailablePayload,
  updateDelivery,
  validUpdateFeed
} from './update-platform'

const FEED = 'https://updates.example/disterm'
const delivery = (o: Omit<Parameters<typeof updateDelivery>[0], 'feed'> & { feed?: unknown }) =>
  updateDelivery({ feed: FEED, ...o })

describe('isManualUpdatePlatform', () => {
  it('linux with APPIMAGE set → auto (self-installs)', () => {
    expect(isManualUpdatePlatform('linux', true)).toBe(false)
  })

  it('linux without APPIMAGE → manual (.deb/.rpm)', () => {
    expect(isManualUpdatePlatform('linux', false)).toBe(true)
  })

  it('darwin → auto regardless of APPIMAGE', () => {
    expect(isManualUpdatePlatform('darwin', false)).toBe(false)
    expect(isManualUpdatePlatform('darwin', true)).toBe(false)
  })

  it('win32 → auto', () => {
    expect(isManualUpdatePlatform('win32', false)).toBe(false)
  })
})

describe('shouldEnableUpdater', () => {
  it('disables checks in development and in explicitly local packaged builds', () => {
    expect(shouldEnableUpdater(false, undefined, FEED)).toBe(false)
    expect(shouldEnableUpdater(true, 'disabled', FEED)).toBe(false)
  })

  it('keeps updater behavior unchanged for normal packaged releases', () => {
    expect(shouldEnableUpdater(true, undefined, FEED)).toBe(true)
    expect(shouldEnableUpdater(true, 'enabled', FEED)).toBe(true)
  })
})

/**
 * `shouldEnableUpdater` is only half the fix — it reads a marker the BUILD has to set. A `dist*`
 * script that forgets it produces a package indistinguishable from a release (`app.isPackaged` is
 * true for both), which then polls the production feed for a version nobody published and logs a
 * 404 on `latest*.yml` every six hours. That is a build-config mistake no unit test of the pure
 * function can catch, so assert it against the real package.json — the same guard-test shape as
 * `src/core/no-electron.test.ts`.
 */
describe('the feed is opt-in per build, and no script stamps one', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
  ) as { scripts: Record<string, string>; build: Record<string, unknown> }

  it('package.json names no update feed: a package gets one only by asking', () => {
    // null, not absent: absent makes electron-builder derive a feed from the git remote.
    expect(pkg.build.publish).toBeNull()
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(cmd, name).not.toContain('distermUpdateFeed')
      expect(cmd, name).not.toContain('nodeTermUpdates')
    }
  })

  it('no feed means no channel on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      expect(delivery({ isPackaged: true, updateMode: undefined, platform, hasAppImage: true, feed: undefined })).toBe(
        'no-channel'
      )
    }
  })

  it('only an https url is a feed', () => {
    expect(validUpdateFeed('https://updates.example/x')).toBe('https://updates.example/x')
    for (const bad of ['http://updates.example/x', 'file:///x', 'updates.example', '', 7, null, undefined]) {
      expect(validUpdateFeed(bad)).toBeNull()
    }
  })
})

describe('toUpdateAvailablePayload', () => {
  it('carries version + string release notes + manual flag', () => {
    expect(toUpdateAvailablePayload({ version: '1.2.0', releaseNotes: 'fixes' }, true)).toEqual({
      version: '1.2.0',
      notes: 'fixes',
      manual: true
    })
  })

  it('coerces non-string / missing release notes to empty string', () => {
    expect(toUpdateAvailablePayload({ version: '1.2.0' }, false)).toEqual({
      version: '1.2.0',
      notes: '',
      manual: false
    })
    expect(toUpdateAvailablePayload({ version: '1.2.0', releaseNotes: 42 }, false).notes).toBe('')
  })

  it('flattens the fullChangelog array form instead of dropping it', () => {
    expect(
      toUpdateAvailablePayload(
        { version: '1.2.0', releaseNotes: [{ version: '1.2.0', note: '- a' }, { note: null }, { version: '1.1.0', note: '- b' }] },
        false
      ).notes
    ).toBe('- a\n- b')
  })

  it('caps very long notes', () => {
    expect(releaseNotesText('x'.repeat(100_000)).length).toBe(16 * 1024)
  })
})

describe('installReadiness', () => {
  it('nothing downloaded is never installable, on any platform', () => {
    for (const p of ['darwin', 'linux', 'win32'])
      expect(installReadiness(p, { downloaded: false, nativeReady: true })).toBe('none')
  })

  it('macOS waits for Squirrel.Mac to stage the download', () => {
    expect(installReadiness('darwin', { downloaded: true, nativeReady: false })).toBe('preparing')
    expect(installReadiness('darwin', { downloaded: true, nativeReady: true })).toBe('ready')
  })

  it('AppImage / NSIS install from the downloaded file: ready at once', () => {
    expect(installReadiness('linux', { downloaded: true, nativeReady: false })).toBe('ready')
    expect(installReadiness('win32', { downloaded: true, nativeReady: false })).toBe('ready')
  })
})


/**
 * Issue #814: a local package carries `nodeTermUpdates=disabled` (no feed), so the updater never
 * wires a feed — and the one thing that branch DID wire was a manual check answering "up to date".
 * These pin the delivery paths apart, and pin that the macOS and Linux release paths are untouched
 * by the `manual` marker.
 */
describe('updateDelivery', () => {
  const pkgd = { isPackaged: true, updateMode: undefined as unknown, hasAppImage: false }

  it('a packaged build with updates switched off has NO CHANNEL — it is not up to date', () => {
    expect(delivery({ ...pkgd, updateMode: 'disabled', platform: 'win32' })).toBe('no-channel')
  })

  it('decides no-channel from the build marker, never from the platform name', () => {
    // The same marker on every platform: `dist`, `dist:linux` and `dist:win` all set it, and the
    // day a Windows RELEASE ships with a feed it carries no marker and takes the ordinary path
    // below with nothing to edit here.
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(delivery({ ...pkgd, updateMode: 'disabled', platform })).toBe('no-channel')
    }
  })

  it('a Windows release stamped with the feed self-installs, by carrying no marker', () => {
    expect(delivery({ ...pkgd, platform: 'win32' })).toBe('self-install')
    expect(
      delivery({ ...pkgd, platform: 'win32', feed: 'https://github.com/pollog09/DisTerm/releases/latest/download' })
    ).toBe('self-install')
  })

  it('a Windows build without the feed (local dist:win) has no channel', () => {
    expect(delivery({ ...pkgd, platform: 'win32', feed: undefined })).toBe('no-channel')
    expect(delivery({ ...pkgd, platform: 'win32', feed: 'http://github.com/pollog09/DisTerm/releases/latest/download' })).toBe(
      'no-channel'
    )
  })

  it('macOS is unchanged: a release self-installs', () => {
    expect(delivery({ ...pkgd, platform: 'darwin' })).toBe('self-install')
    expect(delivery({ ...pkgd, platform: 'darwin', hasAppImage: true })).toBe('self-install')
  })

  it('Linux is unchanged: .deb/.rpm stays manual, AppImage stays self-installing', () => {
    expect(delivery({ ...pkgd, platform: 'linux' })).toBe('manual-install')
    expect(delivery({ ...pkgd, platform: 'linux', hasAppImage: true })).toBe('self-install')
  })

  it('dev stays its own state — quiet, not a no-channel card in every `npm run dev`', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(delivery({ isPackaged: false, updateMode: undefined, platform, hasAppImage: false })).toBe('dev')
      // Even with the marker a dist build would carry, an unpackaged run is dev first.
      expect(delivery({ isPackaged: false, updateMode: 'disabled', platform, hasAppImage: false })).toBe('dev')
    }
  })

  it('the manual marker is a feed check that never self-installs, on Windows too', () => {
    expect(delivery({ ...pkgd, updateMode: 'manual', platform: 'win32' })).toBe('manual-install')
    expect(shouldEnableUpdater(true, 'manual', FEED)).toBe(true)
  })

  it('the manual marker wins over the platform — even where self-install would work', () => {
    expect(delivery({ ...pkgd, updateMode: 'manual', platform: 'darwin' })).toBe('manual-install')
    expect(
      delivery({ ...pkgd, updateMode: 'manual', platform: 'linux', hasAppImage: true })
    ).toBe('manual-install')
  })

  it('an unpackaged run with the manual marker is still dev', () => {
    expect(
      delivery({ isPackaged: false, updateMode: 'manual', platform: 'win32', hasAppImage: false })
    ).toBe('dev')
  })

  it('stays composed from the two primitives — no second definition to drift', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      for (const hasAppImage of [false, true]) {
        for (const updateMode of [undefined, 'enabled', 'disabled']) {
          const d = delivery({ isPackaged: true, updateMode, platform, hasAppImage })
          expect(d === 'no-channel').toBe(!shouldEnableUpdater(true, updateMode, FEED))
          if (d !== 'no-channel') {
            expect(d === 'manual-install').toBe(isManualUpdatePlatform(platform, hasAppImage))
          }
        }
      }
    }
  })
})

describe('mayQuitAndInstall', () => {
  it('only a self-installing build (or dev, unchanged) may reach quitAndInstall', () => {
    expect(mayQuitAndInstall('self-install')).toBe(true)
    expect(mayQuitAndInstall('dev')).toBe(true)
    expect(mayQuitAndInstall('manual-install')).toBe(false)
    expect(mayQuitAndInstall('no-channel')).toBe(false)
  })

  it('a Windows build stamped with the manual marker can never install from the feed', () => {
    const d = delivery({ isPackaged: true, updateMode: 'manual', platform: 'win32', hasAppImage: false })
    expect(mayQuitAndInstall(d)).toBe(false)
  })
})

describe('noSelfInstallCopy', () => {
  const manual = noSelfInstallCopy('manual-install', '0.3.8')
  const none = noSelfInstallCopy('no-channel')

  it('the Linux .deb sentence is byte-identical to the one that shipped', () => {
    expect(manual).toEqual({
      title: 'Update available',
      body: 'DisTerm v0.3.8 is available. Download it to update.',
      action: 'Download'
    })
  })

  it('the no-channel card names the reason and the remedy, and claims no version', () => {
    expect(none.title).toBe('Updates not configured')
    expect(none.body).toBe(
      'Updates are not configured for this build, so it cannot tell you when a new version is out. Rebuild DisTerm from source to update.'
    )
    expect(none.action).toBeUndefined()
  })

  it('never says "up to date", and never promises a self-install', () => {
    const words = `${none.title} ${none.body} ${none.action}`.toLowerCase()
    expect(words).not.toContain('up to date')
    expect(words).not.toContain('latest version')
    expect(words).not.toContain('restart')
    expect(words).not.toContain('install itself')
  })

  it('the two reasons never collapse into one sentence — the remedies differ', () => {
    expect(none.title).not.toBe(manual.title)
    expect(none.body).not.toBe(manual.body)
    // `manual` knows which version is out; `no-channel` structurally cannot.
    expect(manual.body).toContain('0.3.8')
    expect(none.body).not.toMatch(/\bv?\d+\.\d+/)
  })

  it('names no platform — the state decides the copy, not an OS typed into a string', () => {
    for (const copy of [manual, none]) {
      const words = `${copy.title} ${copy.body} ${copy.action}`.toLowerCase()
      for (const os of ['windows', 'win32', 'macos', 'linux', 'deb', 'rpm']) {
        expect(words).not.toContain(os)
      }
    }
  })
})
