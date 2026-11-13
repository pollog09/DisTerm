import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * SOURCE-LEVEL pins for the `map` verb and the system map's live touches (core/system-map/). Each
 * piece is well-typed whether or not it is wired — a handler registration left out, the verb answered
 * after the renderer forward, an optional `systemMapRead` dep never passed, the edit extraction placed
 * before the pane-origin gate — so the feature could pass typecheck and every unit test and ship inert
 * on one shell. The behaviour is proven in `core/system-map/*.test.ts`.
 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const main = read('./index.ts')
const serverIndex = read('../server/index.ts')
const serverControl = read('../server/canvas-control.ts')
const hookServer = read('../core/agents/hook-server.ts')

describe('desktop main', () => {
  const handler = main.slice(main.indexOf('hookServer.setControlHandler('))
  const at = handler.indexOf('if (verb === SYSTEM_MAP_VERB) {')
  const block = handler.slice(at, at + 400)

  it('answers map after the GitHub read block and before any forward', () => {
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(handler.indexOf('if (GITHUB_READ_VERBS.has(verb)) {'))
    expect(at).toBeLessThan(handler.indexOf("'window unavailable'"))
    expect(at).toBeLessThan(handler.indexOf('controlForwarder.forward('))
  })

  it('has its own verified guard and reads the caller\'s own project through the ship-config router', () => {
    expect(block).toContain('if (!verified) return { ok: false, error: SYSTEM_MAP_CONTROL_REFUSAL, message: SYSTEM_MAP_CONTROL_REFUSAL }')
    expect(block.indexOf('if (!verified)')).toBeLessThan(block.indexOf('answerSystemMapControl('))
    expect(block).toContain('answerSystemMapControl(projectIdOfNode(nodeId), args, (id) => readSystemMapFull(id, shipConfigRouter))')
  })

  it('registers the system map handlers with the hoisted ship-config router', () => {
    expect(main).toContain('const shipConfigRouter: ShipConfigRouter = {')
    expect(main).toContain('registerShipConfigHandlers(corePlatform, shipConfigRouter)')
    expect(main).toContain('registerSystemMapHandlers(corePlatform, shipConfigRouter)')
  })
})

describe('Server Edition', () => {
  it('registers the system map handlers with the hoisted router', () => {
    expect(serverIndex).toContain('const shipConfigRouter: ShipConfigRouter = {')
    expect(serverIndex).toContain('registerShipConfigHandlers(platform, shipConfigRouter)')
    expect(serverIndex).toContain('registerSystemMapHandlers(platform, shipConfigRouter)')
  })

  it('passes systemMapRead into canvas control, and the action answers through the same core module', () => {
    expect(serverIndex).toContain('systemMapRead: (projectId) => readSystemMapFull(projectId, shipConfigRouter)')
    const at = serverControl.indexOf('systemMap: async (sourceNodeId, args) =>')
    expect(at).toBeGreaterThan(-1)
    const block = serverControl.slice(at, at + 600)
    expect(block).toContain('map-unavailable: the system map is not available on this server. Do not retry.')
    expect(block).toContain('answerSystemMapControl(')
    expect(block).toContain('projectIdsForNode(sourceNodeId)')
  })
})

describe('hook server', () => {
  const gate = hookServer.indexOf('await this.paneOrigin.admit(nodeId, parseClaudeHookOrigin(form))')
  const edit = hookServer.indexOf('const edit = claudeFileEdit(payload)')

  it('extracts the edit after the pane-origin gate', () => {
    expect(gate).toBeGreaterThan(-1)
    expect(edit).toBeGreaterThan(gate)
  })

  it('inside the same try as the access record, before the raw listener', () => {
    const tryAt = hookServer.lastIndexOf('try {', edit)
    const access = hookServer.indexOf('const access = claudeToolAccess(payload)', tryAt)
    const catchAt = hookServer.indexOf('} catch', tryAt)
    expect(tryAt).toBeGreaterThan(gate)
    expect(access).toBeGreaterThan(tryAt)
    expect(edit).toBeGreaterThan(access)
    expect(edit).toBeLessThan(catchAt)
    expect(hookServer.slice(edit, catchAt)).toContain('if (edit) systemMapTouches.recordEdit(nodeId, edit)')
    expect(edit).toBeLessThan(hookServer.indexOf('this.rawListener?.(agentId, nodeId, payload'))
  })

  it('map is verified-only with its own refusal', () => {
    const set = hookServer.slice(hookServer.indexOf('export const requiresVerified'), hookServer.indexOf('])', hookServer.indexOf('export const requiresVerified')))
    expect(set).toContain("'map'")
    expect(hookServer).toContain("if (verb === 'map') return SYSTEM_MAP_CONTROL_REFUSAL")
  })
})
