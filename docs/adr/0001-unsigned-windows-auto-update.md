---
status: accepted
---

# Unsigned Windows builds update themselves from this repo's GitHub releases

DisTerm on Windows updates itself without a code-signing certificate. `npm run release` pushes a
version tag, `.github/workflows/release-windows.yml` builds the NSIS installer with the feed
`https://github.com/pollog09/DisTerm/releases/latest/download` stamped in and publishes it as the
latest GitHub Release, and the installed app downloads it in the background and offers "Restart to
update". Upstream's rule was that Windows self-install waits for signing, because an unsigned
auto-update is a downgrade in trust. We took the downgrade on purpose: this is a personal fork with no
certificate, and updating by hand meant a manual download and install every release.

## Consequences

- **The trust is the same as a manual download, minus the human glance.** The installer comes from the
  same GitHub releases a person would download from. electron-updater fetches it over HTTPS and checks
  it against the sha512 in `latest.yml`, and with no `publisherName` (an unsigned build has none) it
  skips the Authenticode check. Nobody looks at what was downloaded before it runs.
- **Anyone who can publish a release on this repo can push code to every installed copy.** A leaked
  token with `contents: write`, a compromised Actions run or a hijacked account all reach users
  silently. The sha512 only proves the installer matches `latest.yml`; both come from the same release.
- Only the Windows release carries a feed. Local `npm run dist:win` builds and every macOS and Linux
  package stay `no-channel`, so a forgotten flag still cannot pull an update from anywhere.
- No `*.blockmap` is published, so every update is a full installer download.

## What would reverse it

A Windows code-signing certificate. With one, electron-builder writes `publisherName` into
`app-update.yml` and electron-updater refuses an installer that is not signed by that publisher, which
closes the "anyone who can publish a release" hole. Upstream's other option, `nodeTermUpdates=manual`
(a "new version available, download it" notice that never installs), is still there for a build that
should not install itself.
