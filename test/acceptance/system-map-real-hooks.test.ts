/**
 * The system map's live touches, against what Claude Code 2.1.322 really sent: the recorded Edit/Write
 * payloads (see the fixture's `_provenance`) go through the real extractor, the real touch matcher
 * registered with a real compiled map, the real agent graph log and snapshot read, and the real
 * picture model, in the order the hook route does them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentGraphLog } from '../../src/core/agent-graph/event-log'
import { readAgentGraphSnapshot } from '../../src/core/agent-graph/handlers'
import { SystemMapTouches } from '../../src/core/system-map/touches'
import { claudeFileEdit } from '../../src/shared/agents/file-edit'
import { WORKING_STALE_MS } from '../../src/shared/agents/stale'
import { compileSystemMap, parseSystemMap } from '../../src/shared/system-map'
import { buildSystemMapPicture } from '../../src/renderer/lib/systemMapModel'

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, '../../src/shared/agents/__fixtures__/claude/file-edit-hook-payloads.json'), 'utf8')
) as { scenarios: { edit_write_subagent: { events: Array<Record<string, unknown>> } } }
const events = FIXTURE.scenarios.edit_write_subagent.events

const NODE = 'orch'
const PROJECT = 'P'
const NOW = 5_000_000

const parsed = parseSystemMap(
  JSON.stringify({
    version: 1,
    title: 'Fixture',
    parts: [
      { id: 'api', label: 'API', kind: 'service', files: ['src/api/**'] },
      { id: 'db', label: 'DB', kind: 'store', files: ['src/db/**'] }
    ]
  })
)
if (!parsed.ok) throw new Error(parsed.problems.join('\n'))
const MAP = parsed.map

function play(payloads: readonly Record<string, unknown>[], touches: SystemMapTouches): void {
  payloads.forEach((payload, i) => {
    const edit = claudeFileEdit(payload)
    if (edit) touches.recordEdit(NODE, edit, NOW + i)
  })
}

async function snapshot() {
  return readAgentGraphSnapshot(PROJECT, { route: () => ({ kind: 'unsupported' }) })
}

async function picture(now: number) {
  return buildSystemMapPicture({
    map: MAP,
    emptyParts: [],
    events: (await snapshot()).events,
    projectId: PROJECT,
    sessions: new Map([[NODE, 'Orchestrator']]),
    now
  })
}

let touches: SystemMapTouches
beforeEach(() => {
  agentGraphLog.clear()
  touches = new SystemMapTouches(agentGraphLog)
  touches.set(PROJECT, ['/fixture-repo'], compileSystemMap(MAP))
})
afterEach(() => agentGraphLog.clear())

describe('a session that writes and edits files, and a subagent that writes one', () => {
  it('lights api for the session, db for the subagent with its type, and counts tool.sh as unmatched', async () => {
    play(events, touches)
    const p = await picture(NOW + 100)
    const api = p.boxes.find((b) => b.id === 'api')!
    const db = p.boxes.find((b) => b.id === 'db')!
    expect(api.touchers.map((t) => t.title)).toEqual(['Orchestrator'])
    expect(db.touchers.map((t) => [t.title, t.subId])).toEqual([['Orchestrator › general-purpose', 'a404fab851c0d8e25']])
    expect(p.unmatchedEdits).toBe(1)
  })

  it('counts each call once: the Pre events add nothing', async () => {
    play(events.filter((e) => e.hook_event_name === 'PreToolUse'), touches)
    expect((await snapshot()).events).toEqual([])
    play(events, touches)
    const rows = (await snapshot()).events.filter((e) => e.kind === 'map-touch') as Array<{ partId?: string; subId?: string; count: number }>
    expect(rows.map((r) => [r.partId ?? null, r.subId ?? null, r.count])).toEqual([
      ['api', null, 2], // Write then Edit of server.go
      [null, null, 1], // tool.sh
      ['db', 'a404fab851c0d8e25', 1]
    ])
  })

  it('nothing is lit once the window has passed', async () => {
    play(events, touches)
    const p = await picture(NOW + 7 + WORKING_STALE_MS)
    expect(p.boxes.every((b) => b.touchers.length === 0)).toBe(true)
    expect(p.nextFadeAt).toBeUndefined()
  })

  it('no edited path reaches the snapshot', async () => {
    play(events, touches)
    const text = JSON.stringify(await snapshot())
    const paths = events.map((e) => (e.tool_input as { file_path: string }).file_path)
    for (const p of new Set(paths)) expect(text).not.toContain(p)
    for (const s of ['/fixture-repo', 'server.go', 'schema.sql', 'tool.sh']) expect(text).not.toContain(s)
  })

  it('with no viewer registered nothing is recorded', async () => {
    touches.drop(PROJECT)
    play(events, touches)
    expect((await snapshot()).events).toEqual([])
  })
})
