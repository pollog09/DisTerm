import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { ShipProcessPanel } from '../../graph/ShipProcessPanel'
import { useShipConfig } from '../../graph/useAgentGraphData'
import '../../graph/agent-graph.css'
import { sessionForProject } from '../../../session/session'
import { useProjects } from '../../../state/projects'

const ROWS = {
  ship: {
    title: 'Ship process',
    description:
      'The agents on the machine this project runs on, and the optional ship-graph.json that routes work between them.'
  }
}

const ENTRIES = [ROWS.ship]

/**
 * The graph view's ship panel, for the active project. Every section renders whenever Settings is
 * open, visible or not, so the config is read (and polled) only while this one is on screen: an
 * unmounted-looking section must not keep an ssh read going.
 */
export function ShipProcessSection({ isActive, onClose }: { isActive: boolean; onClose: () => void }) {
  const projectId = useProjects((s) => s.activeProjectId) ?? ''
  const session = projectId ? sessionForProject(projectId) : undefined
  const api = session?.api
  const { result, reload } = useShipConfig(isActive ? api : undefined, projectId)

  return (
    <SettingsSection
      id="ship-process"
      title="Ship process"
      description="Read from each machine's own Claude agents and config. Nothing here is built in, and nothing in these files is ever run."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.ship}>
        {projectId ? (
          <ShipProcessPanel
            projectId={projectId}
            result={result}
            api={api?.agentGraph}
            session={session}
            onReload={reload}
            onOpenFile={(path, ssh) => {
              onClose()
              window.dispatchEvent(new CustomEvent('nodeterm:open-file', { detail: { path, ssh } }))
            }}
          />
        ) : (
          <p className="text-sm text-muted">Open a project to see its ship process.</p>
        )}
      </SearchableRow>
    </SettingsSection>
  )
}
