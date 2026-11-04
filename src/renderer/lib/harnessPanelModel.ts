/**
 * What the Harness panel says, as data: the machine's inventory laid against what was actually used.
 * Pure, because every line in it is a claim about a machine (is this skill installed, was that server
 * configured, did the host agree to hooks) and the claim has to be right or absent. The panel only
 * reads. Nothing here writes config.
 */
import { INTEGRATION_AGENT_IDS, type AgentIntegrationsSettings, type IntegrationChoice } from '@shared/agent-integrations'
import type { ShipConfig, ShipConfigResult, ShipMcpServer } from '@shared/ship-config'
import type { GraphMachine, GraphNode, GraphUsage } from './agentGraphModel'

export interface SessionStateCounts {
  running: number
  needsYou: number
  idle: number
  /** An agent session that has reported nothing this app run. Not idle: nothing says it is. */
  noSignal: number
}

/** Agent sessions only: a plain terminal a line happens to touch reports no state by design. */
export function sessionStateCounts(nodes: readonly GraphNode[], machine?: GraphMachine): SessionStateCounts {
  const counts: SessionStateCounts = { running: 0, needsYou: 0, idle: 0, noSignal: 0 }
  for (const n of nodes) {
    if (n.kind !== 'session' || !n.agentId) continue
    if (machine && (n.machine?.kind !== machine.kind || n.machine.label !== machine.label)) continue
    if (n.state === 'working') counts.running++
    else if (n.state === 'waiting' || n.state === 'blocked') counts.needsYou++
    else if (n.state === 'done') counts.idle++
    else counts.noSignal++
  }
  return counts
}

export type IntegrationStatus = 'enabled' | 'declined' | 'not asked'

export interface IntegrationView {
  /** Why no rows can be given, when that is the case. */
  statement?: string
  rows: Array<{ agent: string; status: IntegrationStatus }>
}

const statusOf = (choice: IntegrationChoice | undefined): IntegrationStatus => choice ?? 'not asked'

/**
 * Which agents may nodeterm hook on this machine. Stated for the machine the session runs on only: a
 * relay tab's hooks are the host's choice and are not ours to read, and an SSH host's needs the host
 * AND the agent to be enabled.
 */
export function integrationView(
  machine: GraphMachine,
  agentsOnCanvas: readonly string[],
  settings: AgentIntegrationsSettings,
  hostKey: string | null
): IntegrationView {
  if (machine.kind === 'relay') {
    return { statement: 'The host decides which agents are hooked. That choice is not readable from this tab.', rows: [] }
  }
  const present = new Set(agentsOnCanvas)
  const agents = INTEGRATION_AGENT_IDS.filter((a) => present.has(a) || settings.agents?.[a] === 'enabled')
  if (machine.kind === 'ssh') {
    if (!hostKey) return { statement: 'This host\'s hook choice could not be matched to a saved connection, so it is not stated.', rows: [] }
    const host: IntegrationChoice | undefined = settings.hosts?.[hostKey] ?? settings.hostDefault
    return {
      statement: `Hooks on ${hostKey} need the host and the agent both enabled.`,
      rows: agents.map((agent) => {
        const mine = settings.agents?.[agent]
        if (host === 'declined' || mine === 'declined') return { agent, status: 'declined' as const }
        return { agent, status: host === 'enabled' && mine === 'enabled' ? ('enabled' as const) : ('not asked' as const) }
      })
    }
  }
  return { rows: agents.map((agent) => ({ agent, status: statusOf(settings.agents?.[agent]) })) }
}

/** Claude names an MCP server in a tool id with anything outside [A-Za-z0-9_-] replaced by `_`. */
export const mcpNameKey = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_')

export interface SkillRow {
  name: string
  /** Installed as a skill folder on this machine. */
  installed: boolean
  /** Not a skill folder but a command of that name (a typed `/name`). */
  command: boolean
  calls: number
  typedCalls: number
}

export interface McpRow {
  name: string
  server?: ShipMcpServer
  calls: number
  tool?: string
}

export interface HarnessInventory {
  skills: SkillRow[]
  /** `mcpRead` false = the config was never read, so "configured" cannot be stated at all. */
  mcpRead: boolean
  mcp: McpRow[]
}

/**
 * The inventory laid against the use. An installed skill that was never used is listed, once, as
 * installed; a used one the machine has no folder for is listed as used and said to be a plugin's or
 * built in, because the inventory covers skill folders and not plugins.
 */
export function harnessInventory(
  config: ShipConfig | null,
  usage: { skills: readonly GraphUsage[]; mcp: readonly GraphUsage[] }
): HarnessInventory {
  const installed = new Set(config?.skills ?? [])
  const commands = new Set(config?.commands ?? [])
  const usedSkill = new Map(usage.skills.map((u) => [u.name, u]))
  const names = [...new Set([...installed, ...usedSkill.keys()])]
  const skills = names
    .map((name): SkillRow => ({
      name,
      installed: installed.has(name),
      command: !installed.has(name) && commands.has(name),
      calls: usedSkill.get(name)?.calls ?? 0,
      typedCalls: usedSkill.get(name)?.typedCalls ?? 0
    }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))

  const configured = new Map((config?.mcpServers ?? []).map((s) => [mcpNameKey(s.name), s]))
  const usedMcp = new Map(usage.mcp.map((u) => [u.name, u]))
  const keys = [...new Set([...configured.keys(), ...usedMcp.keys()])]
  const mcp = keys
    .map((key): McpRow => {
      const server = configured.get(key)
      const used = usedMcp.get(key)
      return { name: server?.name ?? key, ...(server ? { server } : {}), calls: used?.calls ?? 0, ...(used?.tool ? { tool: used.tool } : {}) }
    })
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
  return { skills, mcpRead: !!config?.mcpRead, mcp }
}

/** The ship config when the read worked; the reason when it did not. */
export const configOf = (result: ShipConfigResult | null): ShipConfig | null => (result?.ok ? result.config : null)
