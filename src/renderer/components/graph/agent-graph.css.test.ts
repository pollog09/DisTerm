// The flow dots' stylesheet contract. A dot moves once per real event and stops, so nothing here may
// loop, and nothing may read the covered-canvas gate: that gate lives on the same .react-flow and would
// freeze a dot mid-line.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(join(__dirname, 'agent-graph.css'), 'utf8').replace(/\r\n/g, '\n')
const rule = (selector: string): string => {
  const at = CSS.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return CSS.slice(at, CSS.indexOf('\n}', at))
}

describe('agent-graph.css', () => {
  it('a flow dot runs once, in both directions, and is not gated', () => {
    const dot = rule('.agent-graph-edge__dot')
    expect(dot).toContain('animation: agent-graph-dot 900ms ease-in-out 1 forwards')
    expect(dot).not.toContain('infinite')
    expect(dot).not.toContain('--nt-anim-state')
    expect(rule('.agent-graph-edge__dot[data-reverse]')).toContain('animation-name: agent-graph-dot-back')
  })

  it('the dot keyframes carry it along its path and back, and fade at both ends', () => {
    const forward = CSS.slice(CSS.indexOf('@keyframes agent-graph-dot {'), CSS.indexOf('@keyframes agent-graph-dot-back'))
    expect(forward).toContain('0% { offset-distance: 0%; opacity: 0; }')
    expect(forward).toContain('100% { offset-distance: 100%; opacity: 0; }')
    const back = CSS.slice(CSS.indexOf('@keyframes agent-graph-dot-back'))
    expect(back).toContain('0% { offset-distance: 100%; opacity: 0; }')
    expect(back).toContain('100% { offset-distance: 0%; opacity: 0; }')
  })

  it('reduced motion hides the dots', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n  \.agent-graph-edge__dot \{\n    display: none;/)
  })

  it('nothing in the file loops', () => {
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('infinite')
  })
})
