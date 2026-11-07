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

  it('a dot grows in and out with a halo in its line\'s colour, still once per event', () => {
    const dot = rule('.agent-graph-edge__dot')
    expect(dot).toContain('scale: 0.45')
    expect(dot).toContain('filter: drop-shadow(0 0 2.5px currentColor)')
    for (const name of ['agent-graph-dot {', 'agent-graph-dot-back {']) {
      const at = CSS.indexOf(`@keyframes ${name}`)
      const body = CSS.slice(at, CSS.indexOf('\n}', at))
      expect(body).toMatch(/14% \{ opacity: 1; scale: 1; \}/)
      expect(body).toMatch(/86% \{ opacity: 1; scale: 1; \}/)
    }
  })

  it('a box and a line come in once when they first appear, and nothing new is gated', () => {
    expect(rule('.agent-graph .react-flow__node')).toContain('animation: agent-graph-enter 340ms cubic-bezier(0.2, 0.8, 0.2, 1) 1 both')
    const edgeEnter = CSS.slice(CSS.indexOf('.agent-graph-edge,\n.agent-graph-edge__label {'), CSS.indexOf('@keyframes agent-graph-enter'))
    expect(edgeEnter).toContain('animation: agent-graph-edge-enter 420ms ease-out 1 both')
    for (const sel of ['.agent-graph .react-flow__node', ".agent-graph-node[data-glow='working']", ".agent-graph-node[data-glow='attention']"]) {
      expect(rule(sel), sel).not.toContain('infinite')
      expect(rule(sel), sel).not.toContain('--nt-anim-state')
    }
  })

  it('a session glows by status in the role colours; working and needs-you pulse four times, idle is still', () => {
    expect(rule(".agent-graph-node[data-glow='working']")).toContain('--agent-graph-glow: var(--state-working)')
    expect(rule(".agent-graph-node[data-glow='working']")).toContain('animation: agent-graph-glow-working 2.6s ease-in-out 4')
    expect(rule(".agent-graph-node[data-glow='attention']")).toContain('--agent-graph-glow: var(--state-attention)')
    expect(rule(".agent-graph-node[data-glow='attention']")).toContain('animation: agent-graph-glow-attention 2s ease-in-out 4')
    expect(rule(".agent-graph-node[data-glow='idle']")).toContain('--agent-graph-glow: var(--state-success)')
    expect(rule(".agent-graph-node[data-glow='idle']")).not.toContain('animation')
  })

  it('the glow starts and ends at its resting value, so it settles without a jump', () => {
    expect(rule('.agent-graph-node[data-glow]')).toContain('box-shadow: var(--agent-graph-glow-rest)')
    for (const name of ['agent-graph-glow-working', 'agent-graph-glow-attention']) {
      const at = CSS.indexOf(`@keyframes ${name} {`)
      expect(at, name).toBeGreaterThanOrEqual(0)
      expect(CSS.slice(at, CSS.indexOf('\n}', at)), name).toContain('0%, 100% { box-shadow: var(--agent-graph-glow-rest); }')
    }
  })

  it('working and needs-you name different keyframes, so a change between them restarts the pulse', () => {
    // The box element survives a status change and an animation keeps running while its name is the
    // same: with one shared name, working to needs-you after the first pulse ended would never pulse.
    const name = (sel: string): string => /animation:\s*([\w-]+)/.exec(rule(sel))?.[1] ?? ''
    const working = name(".agent-graph-node[data-glow='working']")
    const attention = name(".agent-graph-node[data-glow='attention']")
    expect(working).toBe('agent-graph-glow-working')
    expect(attention).toBe('agent-graph-glow-attention')
    expect(working).not.toBe(attention)
    const frames = (n: string): string => {
      const at = CSS.indexOf(`@keyframes ${n} {`)
      return CSS.slice(CSS.indexOf('{', at), CSS.indexOf('\n}', at))
    }
    expect(frames(working)).toBe(frames(attention))
  })

  it('reduced motion stops the entrance and the glow pulse, and an idle window holds the glow lit', () => {
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\n  \.agent-graph \.react-flow__node,\n  \.agent-graph-edge,\n  \.agent-graph-edge__label,\n  \.agent-graph-node\[data-glow\] \{\n    animation: none;/
    )
    expect(rule(":root[data-nt-window='idle'] .agent-graph-node[data-glow]")).toContain('animation: none')
  })

  it('only a moving chevron loops, and it reads the animation gate', () => {
    const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{[^{}]*infinite[^{}]*\}/g) ?? []
    expect(rules).toHaveLength(1)
    expect(rules[0]).toContain('.agent-graph-edge__chevron[data-moving]')
    expect(rules[0]).toContain('animation-play-state: var(--nt-anim-state)')
  })
})
