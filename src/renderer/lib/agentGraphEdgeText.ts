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

/** The line's colour, as a role token (a var on a DOM style, per CLAUDE.md "Semantic colours"). */
export function graphEdgeColor(edge: GraphEdge): string {
  if (edge.kind === 'message') return DELIVERY_COLOR[edge.latest ?? 'delivered']
  // Uncertain lines first: "maybe" and an observed "went back" assert no rejection, so they must not
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
  { label: 'maybe, went back or not declared', color: 'var(--state-warning)', dashed: true },
  { label: 'opened, then, spawned, next', color: OTHER_LINE }
]

/** The legend for the lines actually drawn, read through `graphEdgeColor` so it cannot disagree with
 *  them. A message line can hold several outcomes, so each one it counted gets its entry. */
export function graphLegend(edges: readonly GraphEdge[]): GraphLegendEntry[] {
  const outcomes = new Set<DeliveryClass>()
  const lineColors = new Set<string>()
  for (const edge of edges) {
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
  if (edge.maybe) return edge.traversals ? `×${edge.traversals} + maybe ×${edge.maybe}` : `maybe ×${edge.maybe}`
  // With no file there is no order to have gone against: this could be a rejection or a second run.
  if (edge.loop && edge.kind === 'observed' && !edge.undeclared) return `went back${times}`
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
  if (edge.reason) return `Refused: ${edge.reason}`
  if (edge.maybe) return MAYBE_HINT
  if (edge.loop && edge.kind === 'observed' && !edge.undeclared) return OBSERVED_LOOP_HINT
  return undefined
}
