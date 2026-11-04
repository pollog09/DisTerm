/**
 * The Server Edition's `settings` verb (@shared/settings-verb): reads work, changes are refused by
 * name.
 *
 * WHY `--set` IS REFUSED HERE. On the desktop every change is a dialog, and the user's click is the
 * consent. This edition's canvas control is HEADLESS — its admission is verified node identity plus
 * process-local creator ownership (`HeadlessNodeFactory`), and nothing on the path ever asks a
 * person. The operator's opt-in (`NODETERM_SERVER_CANVAS_CONTROL=1`, #537) decides that agents may
 * drive the canvas at all; it is not a statement about any particular setting, and treating it as
 * standing consent to grant capabilities would be exactly the waiver `settings` refuses on the
 * desktop. So a change is refused with a permanent, named reason, and the agent is told to ask the
 * user to change it in Settings.
 *
 * `--get` answers from the same stores the delivery gate reads — the capability view is
 * `workspaceStore.capabilityProjectFor`, i.e. the file flag plus this machine's recorded answer — so
 * a read can never say "on" where a delivery would be refused. `--project` is limited to the
 * caller's OWN project: this edition keeps no `open-project` grant ledger that main's
 * `gateProjectTarget` could consult, and a read of another project's switch is not worth inventing
 * one for.
 */
import {
  SETTINGS_VERB_KEY_LIST,
  parseSettingsRequest,
  renderSettingsGet,
  type SettingsProjectView
} from '../shared/settings-verb'
import type { CapabilityAckMap } from '../shared/project-capability-consent'
import type { ProjectCapability } from '../shared/project-capabilities'
import type { Settings } from '../shared/types'
import { CONTROL_UNSUPPORTED_ERROR } from './control-unsupported'
import type { ServerControlReply } from './headless-node-factory'

export const SETTINGS_SET_UNSUPPORTED_MESSAGE =
  `${CONTROL_UNSUPPORTED_ERROR}: changing settings from the canvas CLI needs a person to confirm ` +
  'it, and DisTerm Server Edition has no confirmation dialog for canvas control. Ask the user to ' +
  'change it in Settings. This is permanent on this host — do not retry.'

export interface ServerSettingsControlDeps {
  persistedCanvases(): Array<{ id: string; nodes: ReadonlyArray<{ id: string }> }>
  capabilityProjectFor(
    projectId: string
  ): (Partial<Record<ProjectCapability, boolean>> & { capabilityAck?: CapabilityAckMap }) | undefined
  projectName(projectId: string): string | undefined
  settings(): Settings
}

export function serverSettingsControl(
  deps: ServerSettingsControlDeps,
  sourceNodeId: string,
  args: Record<string, string>
): ServerControlReply {
  const request = parseSettingsRequest(args)
  if ('error' in request) return { ok: false, error: request.error }
  if (request.action === 'set') {
    return { ok: false, error: CONTROL_UNSUPPORTED_ERROR, message: SETTINGS_SET_UNSUPPORTED_MESSAGE }
  }
  const callerProjectId = deps
    .persistedCanvases()
    .find((p) => p.nodes.some((n) => n.id === sourceNodeId))?.id
  if (request.project !== undefined && request.project !== callerProjectId) {
    return {
      ok: false,
      error:
        'project-target-refused: on DisTerm Server Edition, settings can only be read for your own project'
    }
  }
  let project: SettingsProjectView | undefined
  if (callerProjectId) {
    project = {
      id: callerProjectId,
      name: deps.projectName(callerProjectId) ?? callerProjectId,
      ...(deps.capabilityProjectFor(callerProjectId) ?? {})
    }
  }
  return renderSettingsGet({
    keys: request.action === 'get' ? [request.key] : SETTINGS_VERB_KEY_LIST,
    settings: deps.settings(),
    project
  })
}
