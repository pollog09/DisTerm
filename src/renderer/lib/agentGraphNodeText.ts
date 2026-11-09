/**
 * What a box in the agent graph says: its badges, and which status glow it wears. Pure and DOM-free,
 * shared by the 2D box and the 3D tooltip so the two views can never word a node differently.
 */
import { AGENT_CONFIG, type BuiltinAgentId } from '@shared/agents/config'
import type { GraphMachine, GraphNode } from './agentGraphModel'

export const GRAPH_STATE_LABEL: Readonly<Record<string, string>> = {
  working: 'working',
  waiting: 'needs you',
  blocked: 'needs you',
  done: 'idle'
}

export function graphAgentLabel(agentId: string): string {
  return AGENT_CONFIG[agentId as BuiltinAgentId]?.label ?? agentId
}

export interface GraphNodeBadge {
  text: string
  role?: 'state' | 'loop' | 'warning'
  title?: string
  machine?: GraphMachine['kind']
  outcome?: NonNullable<GraphNode['outcome']>
}

/** The badges of one box, in the order the box shows them. A Harness figure the config could not
 *  state is not there, never a zero. */
export function graphNodeBadges(node: GraphNode, showMachine: boolean): GraphNodeBadge[] {
  const out: GraphNodeBadge[] = []
  const facts = node.harness
  if (facts) {
    out.push({ text: `${facts.sessions} session${facts.sessions === 1 ? '' : 's'}` })
    out.push({ text: `${facts.running} running` })
    if (facts.skillsInstalled !== undefined) out.push({ text: `${facts.skillsInstalled} skills installed` })
    if (facts.mcpConfigured !== undefined) out.push({ text: `${facts.mcpConfigured} MCP configured` })
  }
  if (node.agentId) out.push({ text: graphAgentLabel(node.agentId) })
  if (showMachine && node.machine && node.kind !== 'harness') out.push({ text: node.machine.label, machine: node.machine.kind })
  if (node.state) out.push({ text: GRAPH_STATE_LABEL[node.state] ?? node.state, role: 'state' })
  if (node.handedOver) out.push({ text: 'handed work' })
  if (node.outcome) out.push({ text: node.outcome, outcome: node.outcome })
  if (node.activity === 'stale') out.push({ text: 'no recent signal' })
  if (node.reentered) out.push({ text: 're-entered', role: 'loop' })
  if (node.maybeRuns) {
    out.push({ text: `maybe ×${node.maybeRuns}`, role: 'warning', title: 'Hooks cannot tell whether this run was this stage or another, so it is not counted.' })
  }
  if (node.missingAgent) {
    out.push({ text: 'no agent file found', role: 'warning', title: 'Built-in and plugin agents have no file, so this does not mean it cannot run.' })
  }
  return out
}

export type GraphGlow = 'working' | 'attention' | 'idle'

/** The status glow of a session box: working, needs you, or idle. Only a session has a turn to be in. */
export function sessionGlow(node: Pick<GraphNode, 'kind' | 'state'>): GraphGlow | undefined {
  if (node.kind !== 'session') return undefined
  if (node.state === 'working') return 'working'
  if (node.state === 'waiting' || node.state === 'blocked') return 'attention'
  if (node.state === 'done') return 'idle'
  return undefined
}

/** The role token each glow is drawn in (CLAUDE.md "Semantic colours"). Idle is the colour a finished
 *  run's dot already uses. */
export const GLOW_COLOR: Readonly<Record<GraphGlow, string>> = {
  working: 'var(--state-working)',
  attention: 'var(--state-attention)',
  idle: 'var(--state-success)'
}

/** The text a box shows, as lines: its title with its run count, its subtitle, its badges and its
 *  description. The 3D view's tooltip is this, so hovering a sphere reads what the box says. */
export function graphNodeTextLines(node: GraphNode, showMachine: boolean): string[] {
  const lines = [node.runs ? `${node.title} ×${node.runs}` : node.title]
  if (node.subtitle) lines.push(node.subtitle)
  const badges = graphNodeBadges(node, showMachine).map((b) => b.text)
  if (badges.length) lines.push(badges.join(' · '))
  if (node.description) lines.push(node.description)
  return lines
}
