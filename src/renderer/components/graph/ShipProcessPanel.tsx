import { useState } from 'react'
import { errorText } from '@shared/error-text'
import { SHIP_AGENT_MODELS, isShipAgentModel, type ShipAgent, type ShipConfigResult, type ShipMachine, type ShipScope } from '@shared/ship-config'
import type { AgentGraphApi } from '@shared/types'
import { thisMachine } from '../../lib/machineName'

/**
 * What this machine's ship process is made of, and the door to the one file that routes it. One
 * component on both surfaces that show it (the graph view's side panel, Settings → Ship process), so
 * they cannot describe a machine differently.
 */
export interface ShipProcessPanelProps {
  projectId: string
  result: ShipConfigResult | null
  api: Pick<AgentGraphApi, 'createShipGraph' | 'setAgentModel'> | undefined
  /** The session this project runs under: a team tab's "local" machine is its host, not this one. */
  session?: { source: string; label: string } | null
  onReload: () => void
  /** Open a config file for editing; `ssh` = it is on the project's host. */
  onOpenFile: (path: string, ssh: boolean) => void
}

/** Shown wherever the process is, because each of these reads as a bug if nobody says it. */
export const SHIP_KNOWN_LIMITS: readonly string[] = [
  'Stages are matched to live subagents by agent name, and that signal exists for Claude only.',
  'Workflow agent() runs and SubagentStop gate results are not shown: neither is confirmed visible to hooks.',
  'Routing is edited in the file. There is no visual pipeline editor yet.'
]

/** Whose agents these are. The core answers `local` for itself, which from a relay tab is the host. */
export function shipMachineName(machine: ShipMachine, session?: { source: string; label: string } | null): string {
  if (machine.kind === 'ssh') return machine.label
  if (session?.source === 'relay') return session.label || 'the host'
  return thisMachine()
}

const nameList = (names: readonly string[]): string => (names.length ? names.join(', ') : 'none')

/** What the picker's hover says an edit will reach. */
export function agentModelHint(agent: Pick<ShipAgent, 'scope' | 'fileName'>, machine: string): string {
  if (!agent.fileName) return 'Could not tell which file declares this agent, so its model cannot be changed here.'
  const where = agent.scope === 'global' ? `every project on ${machine}` : 'this project'
  return `Writes the model: line of ${agent.fileName} (through its link, if it is one). Applies to ${where} from the next time the agent starts.`
}

function AgentModelPicker({ agent, machine, api, projectId, onChanged }: {
  agent: ShipAgent
  machine: string
  api: ShipProcessPanelProps['api']
  projectId: string
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = agent.model ?? ''
  const known = isShipAgentModel(current)
  const set = (model: string): void => {
    if (!api?.setAgentModel || !isShipAgentModel(model) || model === current) return
    setBusy(true)
    setError(null)
    void api
      .setAgentModel(projectId, agent.scope, agent.name, model)
      .then((r) => {
        if (r.ok) onChanged()
        else setError(r.message)
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false))
  }
  return (
    <>
      <select
        className="ship-panel__model"
        aria-label={`Model for ${agent.name}`}
        title={agentModelHint(agent, machine)}
        value={current}
        disabled={busy || !api?.setAgentModel || !agent.fileName}
        onChange={(e) => set(e.target.value)}
      >
        {/* No model: line runs the agent on Claude Code's default, which is not the same promise as inherit. */}
        {!current && <option value="" disabled>no model set</option>}
        {current && !known && <option value={current} disabled>{current}</option>}
        {SHIP_AGENT_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      {error && <span className="ship-panel__warning" role="alert">{error}</span>}
    </>
  )
}

export function ShipProcessPanel({ projectId, result, api, session, onReload, onOpenFile }: ShipProcessPanelProps) {
  const [createError, setCreateError] = useState<string | null>(null)

  if (!result) return <p className="ship-panel__muted">Reading this machine's agents…</p>
  if (!result.ok) {
    return (
      <div className="ship-panel">
        <p className="ship-panel__muted">{result.reason} The graph still draws what it observes.</p>
        <button className="ship-panel__action" onClick={onReload}>Retry</button>
      </div>
    )
  }
  const { config } = result
  const ssh = config.machine.kind === 'ssh'
  const machine = shipMachineName(config.machine, session)

  const create = (scope: ShipScope): void => {
    setCreateError(null)
    void api?.createShipGraph(projectId, scope).then((r) => {
      if (r.ok) {
        onReload()
        onOpenFile(r.path, ssh)
      } else {
        setCreateError(r.message)
      }
    }).catch((err: unknown) => setCreateError(errorText(err)))
  }

  const fileRow = (scope: ShipScope, label: string, path: string | null, exists: boolean, blocked?: boolean) =>
    path && (
      <div className="ship-panel__file" key={scope}>
        <div className="ship-panel__file-text">
          <span>{label}</span>
          <code title={path}>{path}</code>
        </div>
        {blocked ? (
          // Something is there that is not a readable file: opening it could hang, and Create would refuse.
          <span className="ship-panel__warning">Not usable</span>
        ) : exists ? (
          <button className="ship-panel__action" onClick={() => onOpenFile(path, ssh)}>Open</button>
        ) : (
          <button className="ship-panel__action" onClick={() => create(scope)} title="Writes the ship-change example. Nothing is created until you ask.">
            Create example
          </button>
        )}
      </div>
    )

  return (
    <div className="ship-panel">
      <p className="ship-panel__summary">
        {config.agents.length} agent{config.agents.length === 1 ? '' : 's'} on {machine}.{' '}
        {config.graphSource
          ? `Routing comes from the ${config.graphSource} ship-graph.json.`
          : 'No routing file, so the graph draws what it observes.'}
      </p>

      <section>
        <h4 className="ship-panel__head">Routing</h4>
        {fileRow('project', 'This project', config.projectGraphPath, config.projectGraphExists, config.projectGraphBlocked)}
        {fileRow('global', 'All projects', config.globalGraphPath, config.globalGraphExists, config.globalGraphBlocked)}
        {createError && <p className="ship-panel__warning" role="alert">{createError}</p>}
      </section>

      {config.warnings.length > 0 && (
        <section>
          <h4 className="ship-panel__head">Warnings</h4>
          {config.warnings.map((w) => <p className="ship-panel__warning" key={w}>{w}</p>)}
        </section>
      )}

      <section>
        <h4 className="ship-panel__head">Agents</h4>
        {config.agents.length === 0 && <p className="ship-panel__muted">No agent files found.</p>}
        <ul className="ship-panel__agents">
          {config.agents.map((a) => (
            <li key={a.name} title={a.description}>
              <span className="ship-panel__agent-name" data-color={a.color}>{a.name}</span>
              <span className="ship-panel__agent-meta">
                {a.scope === 'project' ? (a.overridesGlobal ? 'project, overrides global' : 'project') : 'global'}
              </span>
              <AgentModelPicker agent={a} machine={machine} api={api} projectId={projectId} onChanged={onReload} />
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="ship-panel__head">Also available</h4>
        <p className="ship-panel__muted">Commands: {nameList(config.commands)}</p>
        <p className="ship-panel__muted">Workflows: {nameList(config.workflows)}</p>
        <p className="ship-panel__muted">Skills: {nameList(config.skills)}</p>
      </section>

      <section>
        <h4 className="ship-panel__head">Limits</h4>
        {SHIP_KNOWN_LIMITS.map((l) => <p className="ship-panel__muted" key={l}>{l}</p>)}
      </section>
    </div>
  )
}
