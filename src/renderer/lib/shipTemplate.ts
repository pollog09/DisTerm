/**
 * What the empty graph says about setting a project up with the starter pipeline. Pure, so the three
 * answers cannot drift from their tests.
 */
import { SHIP_NO_FOLDER_MESSAGE, type ShipConfigResult, type ShipTemplateCreateResult } from '@shared/ship-config'

export const SHIP_TEMPLATE_ACTION = 'Set up graph engineering'
export const SHIP_TEMPLATE_DESCRIPTION =
  "Adds an implement, document, review pipeline to this project's .claude folder: three agents, a /ship-change command and ship-graph.json. Anything already there is kept, and so is any agent or command of the same name on the machine this project runs on. Nothing runs until you ask."
export const SHIP_TEMPLATE_RUN_HINT = 'Type /ship-change <task> in a Claude session to run it.'

export type ShipTemplateOffer = { kind: 'none' } | { kind: 'offer' } | { kind: 'disabled'; reason: string }

/**
 * Whether to offer it. Nothing until the machine has answered: a read still out or a read that failed
 * says nothing about what is there, and the failure has its own notice. A routing file anywhere, usable
 * or not, means this project already has a process, and a project file would replace a global one whole.
 */
export function shipTemplateOffer(result: ShipConfigResult | null): ShipTemplateOffer {
  if (!result?.ok) return { kind: 'none' }
  const { config } = result
  if (
    config.graphSource !== null ||
    config.projectGraphExists ||
    config.projectGraphBlocked ||
    config.globalGraphExists ||
    config.globalGraphBlocked
  ) {
    return { kind: 'none' }
  }
  if (config.projectGraphPath === null) return { kind: 'disabled', reason: SHIP_NO_FOLDER_MESSAGE }
  return { kind: 'offer' }
}

/** The line after it worked. Says what was left alone too, since a kept agent is the person's own. */
export function shipTemplateCreatedText(result: Extract<ShipTemplateCreateResult, { ok: true }>): string {
  const n = result.created.length
  const created = n ? `Created ${n} file${n === 1 ? '' : 's'} in ${result.root}.` : `Nothing new was needed in ${result.root}.`
  const kept = result.kept.length ? ` Kept what was already there: ${result.kept.join(', ')}.` : ''
  return `${created}${kept} ${SHIP_TEMPLATE_RUN_HINT}`
}
