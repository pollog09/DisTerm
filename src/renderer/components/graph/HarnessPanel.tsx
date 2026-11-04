import type { AgentIntegrationsSettings } from '@shared/agent-integrations'
import { AGENT_CONFIG, type BuiltinAgentId } from '@shared/agents/config'
import type { ShipConfigResult } from '@shared/ship-config'
import type { AgentGraphModel, GraphMachine } from '../../lib/agentGraphModel'
import {
  configOf,
  harnessInventory,
  integrationView,
  sessionStateCounts,
  type IntegrationStatus
} from '../../lib/harnessPanelModel'
import { shipMachineName } from './ShipProcessPanel'

/**
 * The harness, written out: the machine, the sessions on it and what state they are in, which agents
 * are hooked, and which skills and MCP servers exist beside the ones that were actually used. The
 * graph draws only what was used; everything that is merely installed lives here, so the picture
 * stays about what moved. It reads and writes nothing.
 */
export interface HarnessPanelProps {
  model: Pick<AgentGraphModel, 'nodes' | 'usage'>
  result: ShipConfigResult | null
  /** The session this project runs under: a team tab's "local" machine is its host. */
  session?: { source: string; label: string } | null
  integrations: AgentIntegrationsSettings
  /** `user@host` of an SSH project's server; null for anything else. */
  sshHostKey: string | null
  onReload: () => void
}

const STATUS_WORDS: Readonly<Record<IntegrationStatus, string>> = {
  enabled: 'hooked',
  declined: 'declined',
  'not asked': 'not asked'
}

const agentName = (id: string): string => AGENT_CONFIG[id as BuiltinAgentId]?.label ?? id

export function HarnessPanel({ model, result, session, integrations, sshHostKey, onReload }: HarnessPanelProps) {
  const config = configOf(result)
  const harnesses = model.nodes.filter((n) => n.kind === 'harness')
  // The machine the graph drew a Harness box for, matched to the one the config describes when there
  // are several; failing that, the first one drawn.
  const describedByConfig = (m: GraphMachine | undefined): boolean =>
    !!m && !!config && (config.machine.kind === 'ssh' ? m.kind === 'ssh' && m.label === config.machine.label : m.kind !== 'ssh')
  const machine: GraphMachine | null = harnesses.find((h) => describedByConfig(h.machine))?.machine ?? harnesses[0]?.machine ?? null
  const machineName = config ? shipMachineName(config.machine, session) : machine?.label
  const counts = sessionStateCounts(model.nodes, machine ?? undefined)
  const agentsHere = [...new Set(model.nodes.flatMap((n) => (n.kind === 'session' && n.agentId && (!machine || n.machine?.label === machine.label) ? [n.agentId] : [])))]
  const hooks = machine ? integrationView(machine, agentsHere, integrations, sshHostKey) : null
  const inv = harnessInventory(config, model.usage)
  const usedSkills = inv.skills.filter((s) => s.installed && s.calls > 0).length

  return (
    <div className="ship-panel harness-panel">
      <section>
        <h4 className="ship-panel__head">Machine</h4>
        <p className="ship-panel__summary">{machineName ?? 'No session on this canvas has a harness yet.'}</p>
      </section>

      {result && !result.ok && (
        <section>
          <p className="ship-panel__warning" role="alert">{result.reason}</p>
          <p className="ship-panel__muted">What was used is still listed below. What is installed is not known.</p>
          <button className="ship-panel__action" onClick={onReload}>Retry</button>
        </section>
      )}

      <section>
        <h4 className="ship-panel__head">Sessions</h4>
        <div className="harness-panel__counts">
          <span>{counts.running} running</span>
          <span>{counts.needsYou} needs you</span>
          <span>{counts.idle} idle</span>
          <span title="These agents have not reported anything this app run, so they are not claimed to be idle.">{counts.noSignal} no signal yet</span>
        </div>
      </section>

      <section>
        <h4 className="ship-panel__head">Hook integrations</h4>
        {hooks?.statement && <p className="ship-panel__muted">{hooks.statement}</p>}
        {hooks && hooks.rows.length === 0 && !hooks.statement && <p className="ship-panel__muted">No agent on this canvas can be hooked.</p>}
        <ul className="harness-panel__list">
          {hooks?.rows.map((r) => (
            <li key={r.agent}>
              <span>{agentName(r.agent)}</span>
              <span className="harness-panel__meta" data-status={r.status}>{STATUS_WORDS[r.status]}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="ship-panel__head">Skills</h4>
        {!config && <p className="ship-panel__muted">Installed skills are not known{result && !result.ok ? '.' : ' yet.'}</p>}
        {config && <p className="ship-panel__muted">{config.skills.length} installed, {usedSkills} used this app run.</p>}
        {inv.skills.length === 0 && config && <p className="ship-panel__muted">No skills installed or used.</p>}
        <ul className="harness-panel__list">
          {inv.skills.map((s) => (
            <li key={s.name} data-used={s.calls > 0 || undefined}>
              <span className="harness-panel__name">{s.name}</span>
              <span className="harness-panel__meta">
                {s.calls > 0 ? `used ×${s.calls}` : 'not used'}
                {s.calls > 0 && !s.installed ? (s.command ? ' · command' : ' · plugin or built-in') : ''}
                {s.typedCalls > 0 ? ` · ${s.typedCalls} typed` : ''}
              </span>
            </li>
          ))}
        </ul>
        <p className="ship-panel__muted">Skills from plugins are not listed until they are used.</p>
      </section>

      <section>
        <h4 className="ship-panel__head">MCP servers</h4>
        {config && !inv.mcpRead && (
          <p className="ship-panel__muted">Not read on an SSH host. MCP servers appear here once used.</p>
        )}
        {config && inv.mcpRead && <p className="ship-panel__muted">{config.mcpServers.length} configured.</p>}
        {!config && <p className="ship-panel__muted">Configured servers are not known{result && !result.ok ? '.' : ' yet.'}</p>}
        <ul className="harness-panel__list">
          {inv.mcp.map((m) => (
            <li key={m.name} data-used={m.calls > 0 || undefined}>
              <span className="harness-panel__name">{m.name}</span>
              <span className="harness-panel__meta">
                {m.server ? `${m.server.transport} · ${m.server.scope}` : 'connector or plugin'}
                {` · ${m.calls > 0 ? `used ×${m.calls}${m.tool ? `, newest ${m.tool}` : ''}` : 'not used'}`}
              </span>
            </li>
          ))}
        </ul>
        <p className="ship-panel__muted">Claude.ai connectors are not in these files, so they appear only once used.</p>
      </section>

      {config && config.warnings.length > 0 && (
        <section>
          <h4 className="ship-panel__head">Warnings</h4>
          {config.warnings.map((w) => <p className="ship-panel__warning" key={w}>{w}</p>)}
        </section>
      )}
    </div>
  )
}
