/**
 * How a remote terminal tells the reconnect coordinator its connection dropped. Canvas installs the
 * handler; TerminalNode and the kanban card modal report through it.
 */
let sshDropHandler: ((projectId: string, nodeId: string) => void) | null = null

export function setSshDropHandler(fn: ((projectId: string, nodeId: string) => void) | null): void {
  sshDropHandler = fn
}

/**
 * Report a remote terminal that has no session to the reconnect coordinator. Also used by the
 * kanban card modal, which spawns the same node through its own transport and hits the same
 * "no master" refusal — both surfaces queue the node so ONE reconnect flushes them together.
 */
export function reportSshDrop(projectId: string, nodeId: string): void {
  sshDropHandler?.(projectId, nodeId)
}

/**
 * A terminal's process exited. ssh exiting 255 on an SSH-project terminal is a CONNECTION drop
 * (sleep/wake, network change, NAT idle) and the remote tmux session survives, so the coordinator
 * re-establishes the master and respawns the node. A parked terminal keeps this subscription, so this
 * also runs for a terminal nobody is looking at.
 */
export function reportSshExit(code: number | null | undefined, projectId: string | null | undefined, dialsSsh: boolean, nodeId: string): void {
  if (code === 255 && projectId && dialsSsh) reportSshDrop(projectId, nodeId)
}
