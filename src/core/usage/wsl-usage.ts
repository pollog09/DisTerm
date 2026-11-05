// The Claude subscription usage of a WSL distribution. A project running in one spends that
// distribution's login, in its own ~/.claude, which the local reader never looks at. Reused from the
// SSH read, for the same reason: the token stays where it lives. The shell inside the distribution
// reads its own credentials and calls the endpoint; only the JSON answer crosses wsl.exe.
//
// Claude only. Codex keeps its Windows row: reading a distribution's needs Node in there, and failing
// that would put a warning on the pill of everyone who does not use Codex.
import { parseWslShell, wslShellLabel } from '../../shared/terminal-profiles'
import { wslProfileExec, wslRunner } from '../remote-ssh/native/wsl-endpoint'
import { listRunningWslDistros, wslExe } from '../terminal-profiles'
import type { RemoteUsageRunner, RemoteUsageTarget } from './remote-claude-usage'

/** Below the 10 s the curl inside may take, plus a login-free `sh` start. */
const WSL_USAGE_TIMEOUT_MS = 15_000

export interface WslUsageDeps {
  /** A read must not boot a distribution someone stopped. */
  isRunning(target: RemoteUsageTarget): Promise<boolean>
  run: RemoteUsageRunner
}

/** The one row a distribution offers, or null when `hostKey` is not a valid `wsl:` profile. The name
 *  comes from the renderer and becomes an argv element, so it is validated here. */
export function wslUsageTarget(hostKey: string | undefined): RemoteUsageTarget | null {
  const label = wslShellLabel(hostKey)
  if (!hostKey || !label) return null
  return { key: `${hostKey}#`, hostKey, projectId: '', accountId: null, label }
}

/** The real reads. Null off Windows, where no distribution exists to read. */
export function defaultWslUsageDeps(
  runtimePlatform: NodeJS.Platform | string = process.platform
): WslUsageDeps | null {
  if (runtimePlatform !== 'win32') return null
  return {
    isRunning: async (target) => {
      const distro = parseWslShell(target.hostKey)?.toLowerCase()
      const running = await listRunningWslDistros(wslProfileExec)
      return !!distro && !!running?.some((d) => d.toLowerCase() === distro)
    },
    run: async (target, command) => {
      const distro = parseWslShell(target.hostKey)
      if (!distro) return null
      const r = await wslRunner(wslExe())(['-d', distro, '--exec', 'sh', '-c', command], {
        timeoutMs: WSL_USAGE_TIMEOUT_MS
      })
      // Not gated on the exit code, like the ssh runner: the marker block says whether it completed.
      return r.timedOut ? null : r.stdout.toString('utf8')
    }
  }
}
