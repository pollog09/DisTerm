/**
 * What a line in the agent graph says: its colour, words and hover text. Pure and DOM-free, so the
 * acceptance suites can ask what a move finally reads as, not only what the model called it.
 */
import type { DeliveryClass } from '@shared/agent-graph'
import type { GraphEdge } from './agentGraphModel'

export const DELIVERY_COLOR: Readonly<Record<DeliveryClass, string>> = {
  delivered: 'var(--state-success)',
  queued: 'var(--state-queued)',
  failed: 'var(--state-warning)',
  refused: 'var(--state-error)'
}

/** A skill call, an MCP call and the harness link each get a hue none of the process or message lines
 *  uses, from the system palette: nothing here is a state, so no state role stands for it. */
export const SKILL_LINE = 'var(--sys-teal)'
export const MCP_LINE = 'var(--sys-indigo)'
/** Quiet: every session has one, and it says only "this runs on this machine". */
export const HARNESS_LINE = 'rgba(var(--tint-rgb), 0.28)'

/** The line's colour, as a role token (a var on a DOM style, per CLAUDE.md "Semantic colours"). */
export function graphEdgeColor(edge: GraphEdge): string {
  if (edge.kind === 'uses-skill') return SKILL_LINE
  if (edge.kind === 'uses-mcp') return MCP_LINE
  if (edge.kind === 'harness') return HARNESS_LINE
  if (edge.kind === 'message') return DELIVERY_COLOR[edge.latest ?? 'delivered']
  // Uncertain lines first: "maybe" and an observed loop assert no rejection, so they must not
  // wear its colour, including on a declared reject edge that may have been taken.
  if (edge.maybe && !edge.traversals) return 'var(--state-warning)'
  if (edge.loop && edge.kind === 'observed' && !edge.undeclared) return 'var(--state-warning)'
  if (edge.loop || edge.kind === 'ship-reject') return 'var(--state-attention)'
  if (edge.undeclared) return 'var(--state-warning)'
  if (edge.kind === 'context') return 'var(--state-automation)'
  return OTHER_LINE
}

export interface GraphLegendEntry {
  label: string
  color: string
  dashed?: boolean
}

const OTHER_LINE = 'rgba(var(--tint-rgb), 0.45)'
const LINE_LEGEND: readonly GraphLegendEntry[] = [
  { label: 'context link', color: 'var(--state-automation)', dashed: true },
  { label: 'reject or re-entry', color: 'var(--state-attention)', dashed: true },
  { label: 'maybe, repeated or not declared', color: 'var(--state-warning)', dashed: true },
  { label: 'opened, then, spawned, next', color: OTHER_LINE },
  { label: 'skill call', color: SKILL_LINE },
  { label: 'MCP call', color: MCP_LINE }
]

/** The legend for the lines actually drawn, read through `graphEdgeColor` so it cannot disagree with
 *  them. A message line can hold several outcomes, so each one it counted gets its entry. */
export function graphLegend(edges: readonly GraphEdge[]): GraphLegendEntry[] {
  const outcomes = new Set<DeliveryClass>()
  const lineColors = new Set<string>()
  for (const edge of edges) {
    // Every session has a harness line, and the Harness box already says what it is.
    if (edge.kind === 'harness') continue
    if (edge.kind !== 'message') {
      lineColors.add(graphEdgeColor(edge))
      continue
    }
    if (edge.latest) outcomes.add(edge.latest)
    if (edge.counts) for (const k of Object.keys(edge.counts) as DeliveryClass[]) if (edge.counts[k] > 0) outcomes.add(k)
    if (!edge.latest && !edge.counts) outcomes.add('delivered')
  }
  const messageLabels: Readonly<Record<DeliveryClass, string>> = { delivered: 'delivered', queued: 'queued', failed: 'not confirmed', refused: 'refused' }
  return [
    ...(Object.keys(DELIVERY_COLOR) as DeliveryClass[])
      .filter((k) => outcomes.has(k))
      .map((k) => ({ label: messageLabels[k], color: DELIVERY_COLOR[k] })),
    ...LINE_LEGEND.filter((l) => lineColors.has(l.color))
  ]
}

/** The words on a line. A refusal is spelled out, because a colour alone is not a refusal. */
export function graphEdgeLabel(edge: GraphEdge): string {
  if (edge.kind === 'message' && edge.counts) {
    const parts = (Object.keys(edge.counts) as DeliveryClass[])
      .filter((k) => edge.counts![k] > 0)
      .map((k) => `${edge.counts![k]} ${k}`)
    return parts.join(' · ')
  }
  const times = edge.traversals ? ` ×${edge.traversals}` : ''
  if (edge.kind === 'harness') return ''
  if (edge.kind === 'uses-skill' || edge.kind === 'uses-mcp') return `×${edge.traversals ?? 0}`
  if (edge.maybe) return edge.traversals ? `×${edge.traversals} + maybe ×${edge.maybe}` : `maybe ×${edge.maybe}`
  // With no file there is no order to have gone against: this could be a rejection or a second run, so
  // its words claim neither. The colour and the direction marks show it, and the hover text says why.
  if (edge.loop && edge.kind === 'observed' && !edge.undeclared) return times.trim()
  if (edge.loop) return `re-entered${times}`
  if (edge.undeclared) return `not declared${times}`
  if (edge.kind === 'ship-reject') return `reject${times}`
  if (edge.kind === 'context') return 'context'
  if (edge.kind === 'dependency') return 'then' // the rope runs from the awaited node to the waiter
  if (edge.kind === 'opened') return 'opened'
  return times.trim()
}


const OBSERVED_LOOP_HINT = 'Nothing here declares an order for these agents, so a rejection and a second run in the same turn look the same.'
const MAYBE_HINT = 'This agent could have taken this route or another declared one. Hooks cannot tell, so neither is counted.'

/** The hover text of a line, where its words alone would overclaim. */
export function graphEdgeTitle(edge: GraphEdge): string | undefined {
  if (edge.kind === 'uses-skill' || edge.kind === 'uses-mcp') {
    const n = edge.traversals ?? 0
    const what = edge.kind === 'uses-skill' ? 'skill' : 'mcp'
    const typed = edge.typedCalls ? ` (${edge.typedCalls} typed as /${edge.subject})` : ''
    const newest = edge.tool ? `, newest ${edge.tool}` : ''
    return `${n} ${n === 1 ? 'call' : 'calls'} started to ${what} ${edge.subject} this app run${typed}${newest}`
  }
  if (edge.kind === 'harness') return 'This session runs on this machine\'s harness. A dot moves on a state change, a message, a subagent, or a skill or MCP call.'
  if (edge.reason) return `Refused: ${edge.reason}`
  if (edge.maybe) return MAYBE_HINT
  if (edge.loop && edge.kind === 'observed' && !edge.undeclared) return OBSERVED_LOOP_HINT
  return undefined
}
