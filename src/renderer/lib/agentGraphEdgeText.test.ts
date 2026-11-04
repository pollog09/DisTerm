import { describe, expect, it } from 'vitest'
import { graphEdgeColor, graphEdgeLabel, graphEdgeTitle, graphLegend, HARNESS_LINE, MCP_LINE, SKILL_LINE } from './agentGraphEdgeText'
import type { GraphEdge } from './agentGraphModel'

const uses = (over: Partial<GraphEdge>): GraphEdge => ({ id: 'u', source: 'a', target: 'b', kind: 'uses-mcp', traversals: 3, subject: 'demo', ...over })

describe('skill, MCP and harness lines', () => {
  it('each wears a colour none of the process or message lines uses', () => {
    const colors = [SKILL_LINE, MCP_LINE, HARNESS_LINE]
    expect(new Set(colors).size).toBe(3)
    expect(graphEdgeColor(uses({ kind: 'uses-skill' }))).toBe('var(--sys-teal)')
    expect(graphEdgeColor(uses({}))).toBe('var(--sys-indigo)')
    expect(graphEdgeColor({ id: 'h', source: 'h', target: 's', kind: 'harness' })).toBe('rgba(var(--tint-rgb), 0.28)')
    for (const state of ['success', 'queued', 'warning', 'error', 'attention', 'automation']) {
      expect(colors).not.toContain(`var(--state-${state})`)
    }
  })

  it('says how many calls, and nothing at all on the quiet harness line', () => {
    expect(graphEdgeLabel(uses({}))).toBe('×3')
    expect(graphEdgeLabel({ id: 'h', source: 'h', target: 's', kind: 'harness' })).toBe('')
  })

  it('names what happened on hover, the newest tool and the typed share included', () => {
    expect(graphEdgeTitle(uses({ tool: 'echo_it' }))).toBe('3 calls to mcp demo this app run, newest echo_it')
    expect(graphEdgeTitle(uses({ kind: 'uses-skill', traversals: 1, subject: 'grill' }))).toBe('1 call to skill grill this app run')
    expect(graphEdgeTitle(uses({ kind: 'uses-skill', subject: 'grill', typedCalls: 2 }))).toBe('3 calls to skill grill this app run (2 typed as /grill)')
  })

  it('the legend lists a skill call and an MCP call only when drawn, and never the harness line', () => {
    const harness: GraphEdge = { id: 'h', source: 'h', target: 's', kind: 'harness' }
    expect(graphLegend([harness])).toEqual([])
    expect(graphLegend([harness, uses({ kind: 'uses-skill' }), uses({})]).map((l) => l.label)).toEqual(['skill call', 'MCP call'])
  })
})
