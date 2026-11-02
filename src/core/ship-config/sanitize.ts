import { oneLine } from '../../shared/one-line'
import { isRecord } from '../../shared/is-record'
import type { ShipEdge, ShipEdgeKind, ShipPipeline, ShipStage } from '../../shared/ship-config'

/**
 * `.claude/ship-graph.json` arrives in a clone, so this treats it as hostile. The result is the only
 * thing that leaves the core, and it is display data: nothing here is executed, nothing is used as a
 * path, and every id is a short token so it can sit in a React Flow id without quoting.
 *
 * Fields are read one by one from what the file says, so an unknown key or a `__proto__` never
 * reaches the output. A file that is not JSON gives a warning and no pipelines; a bad part of a good
 * file gives a warning per drop, because a stage that silently vanished reads as a broken graph.
 */

/** Bigger than any honest file, small enough to parse on the main thread without a thought. */
export const SHIP_GRAPH_MAX_BYTES = 256 * 1024
const MAX_PIPELINES = 16
const MAX_STAGES = 32
const MAX_EDGES = 64
const NAME_MAX = 120

/** An agent or command name. `:` is real here: `plugin:agent`, `git:commit`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const isName = (v: unknown): v is string => typeof v === 'string' && NAME.test(v)
/** A pipeline or stage id. No `:`, which separates them inside React Flow ids: pipeline `a:b` with
 *  stage `c` and pipeline `a` with stage `b:c` would be one box. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)

function text(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = oneLine(v).slice(0, NAME_MAX)
  return s || undefined
}

function sanitizeStages(raw: unknown, where: string, warnings: string[]): ShipStage[] {
  if (!Array.isArray(raw)) {
    warnings.push(`${where}: "stages" is not a list.`)
    return []
  }
  if (raw.length > MAX_STAGES) warnings.push(`${where}: only the first ${MAX_STAGES} of ${raw.length} stages are used.`)
  const seen = new Set<string>()
  const out: ShipStage[] = []
  for (const s of raw.slice(0, MAX_STAGES)) {
    if (!isRecord(s) || !isId(s.id) || !isName(s.agent)) {
      warnings.push(`${where}: skipped a stage without a usable "id" and "agent".`)
      continue
    }
    if (seen.has(s.id)) {
      warnings.push(`${where}: skipped a second stage named "${s.id}".`)
      continue
    }
    seen.add(s.id)
    const label = text(s.label)
    out.push({ id: s.id, agent: s.agent, ...(label ? { label } : {}) })
  }
  return out
}

function sanitizeEdges(raw: unknown, stages: readonly ShipStage[], where: string, warnings: string[]): ShipEdge[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    warnings.push(`${where}: "edges" is not a list.`)
    return []
  }
  if (raw.length > MAX_EDGES) warnings.push(`${where}: only the first ${MAX_EDGES} of ${raw.length} edges are used.`)
  const ids = new Set(stages.map((s) => s.id))
  const seen = new Set<string>()
  const out: ShipEdge[] = []
  for (const e of raw.slice(0, MAX_EDGES)) {
    if (!isRecord(e) || !isId(e.from) || !isId(e.to) || !ids.has(e.from) || !ids.has(e.to)) {
      warnings.push(`${where}: skipped an edge between stages that do not exist.`)
      continue
    }
    if (e.kind !== undefined && e.kind !== 'next' && e.kind !== 'reject') {
      warnings.push(`${where}: skipped an edge of unknown kind.`)
      continue
    }
    const kind: ShipEdgeKind = e.kind === 'reject' ? 'reject' : 'next'
    const key = `${e.from}>${e.to}>${kind}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ from: e.from, to: e.to, kind })
  }
  return out
}

export interface SanitizedShipGraph {
  /** null = the file could not be read as a ship graph at all. */
  pipelines: ShipPipeline[] | null
  warnings: string[]
}

/** `label` names the file in every warning, so a person can tell which of the two it is about. */
export function sanitizeShipGraph(source: string, label: string): SanitizedShipGraph {
  if (Buffer.byteLength(source, 'utf8') > SHIP_GRAPH_MAX_BYTES) {
    return { pipelines: null, warnings: [`${label}: larger than ${SHIP_GRAPH_MAX_BYTES / 1024} KiB, so it was ignored.`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return { pipelines: null, warnings: [`${label}: not valid JSON, so it was ignored.`] }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.pipelines)) {
    return { pipelines: null, warnings: [`${label}: expected an object with a "pipelines" list, so it was ignored.`] }
  }
  const warnings: string[] = []
  if (parsed.pipelines.length > MAX_PIPELINES) {
    warnings.push(`${label}: only the first ${MAX_PIPELINES} of ${parsed.pipelines.length} pipelines are used.`)
  }
  const seen = new Set<string>()
  const pipelines: ShipPipeline[] = []
  for (const p of parsed.pipelines.slice(0, MAX_PIPELINES)) {
    if (!isRecord(p) || !isId(p.id)) {
      warnings.push(`${label}: skipped a pipeline without a usable "id".`)
      continue
    }
    if (seen.has(p.id)) {
      warnings.push(`${label}: skipped a second pipeline named "${p.id}".`)
      continue
    }
    const where = `${label}, ${p.id}`
    const stages = sanitizeStages(p.stages, where, warnings)
    if (stages.length === 0) {
      warnings.push(`${where}: has no usable stages, so it was skipped.`)
      continue
    }
    seen.add(p.id)
    const trigger = isRecord(p.trigger) ? p.trigger : undefined
    const triggerCommand = trigger && isName(trigger.command) ? trigger.command : undefined
    pipelines.push({
      id: p.id,
      name: text(p.name) ?? p.id,
      ...(triggerCommand ? { triggerCommand } : {}),
      stages,
      edges: sanitizeEdges(p.edges, stages, where, warnings)
    })
  }
  return { pipelines, warnings }
}
