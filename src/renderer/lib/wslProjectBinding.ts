import type { Project } from '@shared/types'
import type { WslProjectApi } from '@shared/wsl-project'
import { SshReconnector, type SshReconnectorDeps } from './sshReconnect'
import { useProjects } from '../state/projects'

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

/** A closed WSL project is not dialed by anything automatic. An ordinary SSH project has no such rule. */
export function isClosedWslProject(project: Pick<Project, 'closed' | 'ssh'> | undefined): boolean {
  return project?.closed === true && !!project.ssh?.server.wslDistro
}

/**
 * The reconnect coordinator Canvas runs. A closed WSL project stays down: without this, the master its
 * close ended would end its terminal with exit 255, which reports a drop, which dials a second later,
 * which registers the project with the watchdog again, and that boots a distro the user stopped.
 *
 * But the drop is still remembered. Closing the LAST open tab leaves its nodes mounted (the load effect
 * bails with no active project), so reopening keeps the same ids and nothing remounts. Those terminals
 * come back only through a respawn, so the coordinator holds them and resumes when the project reopens.
 */
export function createProjectReconnector(deps: Omit<SshReconnectorDeps, 'mayDial' | 'onMayDialChange'>): SshReconnector {
  return new SshReconnector({
    ...deps,
    mayDial: (id) => !isClosedWslProject(useProjects.getState().getProject(id)),
    onMayDialChange: (changed) => useProjects.subscribe(changed)
  })
}

export interface ClosedWslDeps {
  /** The close's own session kill, which needs this connection to arrive. */
  ended: Promise<unknown> | undefined
  /** Cancel a reconnect already pending for this project. */
  forgetReconnect: (projectId: string) => void
  /**
   * Drop the terminals' parks, and make a mounted one dispose rather than park as it unmounts. A park
   * holds a PTY on this master, so after the disconnect it is dead, and reopening would adopt it.
   */
  releaseTerminals: (project: Pick<Project, 'id' | 'nodes'>) => void
  clearConn: (projectId: string) => void
  disconnect: (projectId: string) => Promise<unknown>
}

/**
 * Let go of a closing project's terminals. A terminal that is mounted unmounts right after this, and
 * must dispose rather than park on a master about to end. One that is not mounted may hold a park.
 */
export function releaseClosedTerminals(
  project: Pick<Project, 'nodes'>,
  isActive: boolean,
  ops: { disposeOnUnmount: (nodeId: string) => void; disposePark: (nodeId: string) => void }
): void {
  for (const n of project.nodes) {
    if ((n.kind ?? 'terminal') !== 'terminal') continue
    if (isActive) ops.disposeOnUnmount(n.id)
    else ops.disposePark(n.id)
  }
}

/**
 * A closed WSL project gives up its connection, so nothing can boot a distro the user stopped with
 * `wsl --terminate`. Nothing is lost: tmux and the keepalive are in the distro, and reopening the tab
 * connects and reattaches. Call it before the store closes the project: the terminals are released in
 * this tick, ahead of their unmount, and the disconnect runs after it. A project reopened before the
 * close's session kill was answered keeps its connection. An ordinary SSH project keeps today's behavior.
 */
export function dropClosedWslConnection(project: Project | undefined, deps: ClosedWslDeps): void {
  if (!project?.ssh?.server.wslDistro) return
  const { id } = project
  deps.forgetReconnect(id)
  deps.releaseTerminals(project)
  void Promise.resolve(deps.ended).then(() => {
    if (!isClosedWslProject(useProjects.getState().getProject(id))) return undefined
    deps.clearConn(id)
    return deps.disconnect(id)
  })
}

/** The user deleted this project. A closed tab does not come here: its agents are meant to keep running. */
export function unbindDeletedWslProject(
  project: Pick<Project, 'id' | 'ssh'> | undefined,
  api: Pick<WslProjectApi, 'unbind'> | undefined
): void {
  if (project?.ssh?.server.wslDistro) void api?.unbind(project.id, project.ssh.server.host)
}
