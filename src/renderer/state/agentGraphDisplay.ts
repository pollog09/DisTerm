import { create } from 'zustand'
import { readLocal, writeLocal } from '../lib/localStore'

// Whether the agent graph is drawn flat or in 3D: a DISPLAY preference (the board's tier, see
// `kanbanDisplay.ts`), so it is this person's on this machine, in localStorage, never in a project
// file. One choice for every project: it is about how someone likes to look, not about the project.

export const AGENT_GRAPH_VIEW_KEY = 'nodeterm.agentGraphView'

export type AgentGraphDimension = '2d' | '3d'

/** Anything but a literal `3d` is the 2D default, so a hand-edited or stale value cannot strand
 *  someone in a view their machine may not draw. */
export function parseAgentGraphDimension(raw: string | null): AgentGraphDimension {
  return raw === '3d' ? '3d' : '2d'
}

function load(): AgentGraphDimension {
  try {
    return parseAgentGraphDimension(readLocal(AGENT_GRAPH_VIEW_KEY))
  } catch {
    return '2d'
  }
}

function save(v: AgentGraphDimension): void {
  try {
    writeLocal(AGENT_GRAPH_VIEW_KEY, v)
  } catch {
    /* quota/private-mode: a display preference is a nicety, never fail the UI */
  }
}

interface AgentGraphDisplayState {
  dimension: AgentGraphDimension
  setDimension(v: AgentGraphDimension): void
}

export const useAgentGraphDisplay = create<AgentGraphDisplayState>((set) => ({
  dimension: load(),
  setDimension: (dimension) => {
    save(dimension)
    set({ dimension })
  }
}))
