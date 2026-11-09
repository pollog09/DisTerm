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

/** Whether the 3D view's card of fly keys shows. Shown until someone hides it: the keys are not
 *  guessable, and the card is how anyone finds out the view can be flown. */
export const AGENT_GRAPH_FLY_HELP_KEY = 'nodeterm.agentGraphFlyHelp'

function loadFlyHelp(): boolean {
  try {
    return readLocal(AGENT_GRAPH_FLY_HELP_KEY) !== 'hidden'
  } catch {
    return true
  }
}

interface AgentGraphDisplayState {
  dimension: AgentGraphDimension
  setDimension(v: AgentGraphDimension): void
  flyHelp: boolean
  setFlyHelp(shown: boolean): void
}

export const useAgentGraphDisplay = create<AgentGraphDisplayState>((set) => ({
  dimension: load(),
  setDimension: (dimension) => {
    save(dimension)
    set({ dimension })
  },
  flyHelp: loadFlyHelp(),
  setFlyHelp: (flyHelp) => {
    try {
      writeLocal(AGENT_GRAPH_FLY_HELP_KEY, flyHelp ? 'shown' : 'hidden')
    } catch {
      /* a display preference is a nicety, never fail the UI */
    }
    set({ flyHelp })
  }
}))
