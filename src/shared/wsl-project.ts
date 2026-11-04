// A WSL project is an SSH project whose host is a distribution on this machine: `sshd -i` runs in
// the distro over a `wsl.exe` child's stdio and the native transport speaks SSH to it, so no port is
// opened. See CLAUDE.md, "SSH projects on Windows", and core/remote-ssh/native/wsl-endpoint.ts.
//
// The host name below is only a handle. The distro, keys, host key and transport behind it are read
// from machine-local storage by trusted core code, so nothing that carries this name can supply them.

import type { SshServer } from './ssh'

/** `.invalid` is reserved (RFC 6761): if this name ever reached a real ssh, it could not resolve. */
export const WSL_HOST_SUFFIX = '.wsl.nodeterm.invalid'

export function isWslHost(host: unknown): host is string {
  // Host names are case-insensitive, so no spelling of one may slip past a check on this.
  return typeof host === 'string' && host.toLowerCase().endsWith(WSL_HOST_SUFFIX)
}

/** What the new-project flow may offer. */
export interface WslDistroList {
  /** False on a core that cannot host WSL projects; the flow then shows no WSL rows. */
  available: boolean
  distros: string[]
}

/** Something missing in the distro that costs a feature but not the project. */
export interface WslWarning {
  kind: 'tmux' | 'curl' | 'distro-restarted' | 'keepalive'
  message: string
  /** The command for the user to run in the distro. Never run on their behalf. */
  install?: string
}

export type WslSetupErrorCode =
  | 'unavailable'
  | 'not-installed'
  | 'invalid-distro'
  | 'distro-timeout'
  | 'distro-failed'
  | 'sshd-missing'
  | 'host-key-changed'
  | 'setup-failed'

export type WslPrepareResult =
  | { ok: true; server: SshServer; warnings: WslWarning[] }
  | { ok: false; code: WslSetupErrorCode; error: string; install?: string }

export interface WslProjectApi {
  /** The distros to offer. Reading the list does not start one. */
  list(): Promise<WslDistroList>
  /** Set up `distro` for use, granting only the throwaway folder-browse connection `browseId`. This
   *  starts the distro, so it is called only after the user picks that row. */
  prepare(distro: string, browseId: string): Promise<WslPrepareResult>
  /** Record that the user created this project on this endpoint, so it may connect from now on. */
  bind(projectId: string, host: string): Promise<boolean>
  /** The user deleted this project. An endpoint's last project takes its keepalive with it. */
  unbind(projectId: string, host: string): Promise<boolean>
}
