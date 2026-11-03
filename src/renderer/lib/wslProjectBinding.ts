import type { Project } from '@shared/types'
import type { WslProjectApi } from '@shared/wsl-project'

type SshBinding = NonNullable<Project['ssh']>

/**
 * Record that the user created this WSL project, in the same tick as the store write that opened it.
 * The core refuses to connect a WSL project it has no such record of, and opening the project is what
 * makes React run the effect that connects it. So the bind goes out before any effect: main handles IPC
 * in order, and its first step is synchronous.
 */
export function bindOpenedWslProject(
  opened: Pick<Project, 'id'>,
  ssh: SshBinding,
  api: Pick<WslProjectApi, 'bind'> | undefined
): void {
  if (ssh.server.wslDistro) void api?.bind(opened.id, ssh.server.host)
}

/**
 * A closed WSL project gives up its connection. An SSH master stays up after a close, and the manager's
 * 45 s watchdog re-establishes any master it holds, so an open-looking connection on a closed tab would
 * boot a distro the user had stopped with `wsl --terminate`, indefinitely. Nothing is lost: tmux and the
 * keepalive are in the distro, and reopening the tab connects again. `ended` is the close's own session
 * kill, which needs this connection to arrive. An ordinary SSH project keeps today's behavior.
 */
export function dropClosedWslConnection(
  project: Pick<Project, 'id' | 'ssh'> | undefined,
  ended: Promise<unknown> | undefined,
  disconnect: (projectId: string) => Promise<unknown>,
  clear: (projectId: string) => void
): void {
  if (!project?.ssh?.server.wslDistro) return
  const { id } = project
  void Promise.resolve(ended).then(() => {
    clear(id)
    return disconnect(id)
  })
}

/** The user deleted this project. A closed tab does not come here: its agents are meant to keep running. */
export function unbindDeletedWslProject(
  project: Pick<Project, 'id' | 'ssh'> | undefined,
  api: Pick<WslProjectApi, 'unbind'> | undefined
): void {
  if (project?.ssh?.server.wslDistro) void api?.unbind(project.id, project.ssh.server.host)
}
