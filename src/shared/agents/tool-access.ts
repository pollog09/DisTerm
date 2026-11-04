// Which skill or MCP server a Claude session reached for. Pure, and the only place that reads those
// facts out of a hook payload.
//
// MEASURED on Claude Code 2.1.318 (fixture `__fixtures__/claude/tool-access-hook-payloads.json`):
//   - A skill call is PreToolUse with tool_name `Skill` and tool_input.skill = the name.
//   - An MCP call is PreToolUse with tool_name `mcp__<server>__<tool>`.
//   - From a subagent the same events carry `agent_id` + `agent_type`.
//   - A typed `/name` fires ONLY UserPromptSubmit with the prompt: no Skill tool event.
//   - ToolSearch comes before MCP use. It is not an MCP access and is ignored.
//
// The payload is forgeable and hostile. A name is accepted from a closed alphabet or the event is
// dropped whole, never repaired, and nothing but names leaves: tool_input ARGUMENTS and the rest of
// a prompt are never carried (an MCP argument can be a token, a prompt can be anything).
import { isClaudeAgentId } from './claude-subagents'
import { oneLine } from '../one-line'

export type ToolAccessTarget = 'skill' | 'mcp'

export interface ToolAccess {
  target: ToolAccessTarget
  /** The skill's name as written (`plugin:skill` stays), or the MCP server's name. */
  name: string
  /** MCP only: the tool that was called. */
  tool?: string
  /** The subagent that made the call, when it was not the session itself. */
  subId?: string
  subType?: string
  /** A skill the person typed as `/name`: the model did not call it. */
  typed?: true
}

export const TOOL_ACCESS_NAME_MAX = 64
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
/** A leading `/name` token. `/etc/passwd` has a `/` inside the token, so the alphabet stops at `/etc`
 *  and the next character is not whitespace: no match. */
const TYPED_SKILL_RE = /^\/([A-Za-z0-9][A-Za-z0-9._:-]{0,63})(\s|$)/
const MCP_TOOL_RE = /^mcp__([^_](?:[^_]|_(?!_))*)__(.+)$/
const SUBTYPE_MAX = 64

export const validSkillName = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= TOOL_ACCESS_NAME_MAX && SKILL_NAME_RE.test(v)
export const validMcpName = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= TOOL_ACCESS_NAME_MAX && MCP_NAME_RE.test(v)

interface AccessPayload {
  hook_event_name?: unknown
  tool_name?: unknown
  tool_input?: unknown
  prompt?: unknown
  agent_id?: unknown
  agent_type?: unknown
}

function whoMade(p: AccessPayload): Pick<ToolAccess, 'subId' | 'subType'> {
  if (!isClaudeAgentId(p.agent_id)) return {}
  const type = typeof p.agent_type === 'string' ? oneLine(p.agent_type).trim().slice(0, SUBTYPE_MAX) : ''
  return { subId: p.agent_id, ...(type ? { subType: type } : {}) }
}

/** What this Claude hook payload accessed, or null. One count per call, so only the PreToolUse of a
 *  tool call counts (its PostToolUse is the same call again). */
export function claudeToolAccess(payload: unknown): ToolAccess | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as AccessPayload
  if (p.hook_event_name === 'UserPromptSubmit') {
    if (typeof p.prompt !== 'string') return null
    const name = TYPED_SKILL_RE.exec(p.prompt)?.[1]
    return name ? { target: 'skill', name, typed: true } : null
  }
  if (p.hook_event_name !== 'PreToolUse' || typeof p.tool_name !== 'string') return null
  if (p.tool_name === 'Skill') {
    const input = p.tool_input
    const skill = input && typeof input === 'object' ? (input as { skill?: unknown }).skill : undefined
    return validSkillName(skill) ? { target: 'skill', name: skill, ...whoMade(p) } : null
  }
  const m = MCP_TOOL_RE.exec(p.tool_name)
  if (!m) return null
  const [, server, tool] = m
  if (!validMcpName(server) || !validMcpName(tool)) return null
  return { target: 'mcp', name: server, tool, ...whoMade(p) }
}
