// Which file a Claude session edited, for the system map's live touches (core/system-map/touches.ts).
// Pure, and the only place that reads that fact out of a hook payload.
//
// MEASURED on Claude Code 2.1.322 (fixture `__fixtures__/claude/file-edit-hook-payloads.json`):
//   - Edit and Write fire PreToolUse and PostToolUse, both with tool_input.file_path ABSOLUTE and `cwd`.
//   - From a subagent the same events carry `agent_id` + `agent_type`.
//
// The payload is forgeable and hostile. The path is only checked for shape here; it is matched against
// the viewed maps in the core and goes NOWHERE else: no event, log or reply ever carries it.
import { whoMade } from './tool-access'

export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write'])
export const FILE_EDIT_PATH_MAX = 4096

export interface FileEdit { path: string; cwd?: string; subId?: string; subType?: string }

function usablePath(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= FILE_EDIT_PATH_MAX && !v.includes('\0')
}

/** PostToolUse of Edit/Write only (PreToolUse is the same call again). */
export function claudeFileEdit(payload: unknown): FileEdit | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown; cwd?: unknown }
  if (p.hook_event_name !== 'PostToolUse' || typeof p.tool_name !== 'string' || !FILE_EDIT_TOOLS.has(p.tool_name)) return null
  const input = p.tool_input
  const path = input && typeof input === 'object' ? (input as { file_path?: unknown }).file_path : undefined
  if (!usablePath(path)) return null
  return { path, ...(usablePath(p.cwd) ? { cwd: p.cwd } : {}), ...whoMade(p) }
}
