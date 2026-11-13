import { describe, expect, it } from 'vitest'
import { COL_GAP, PART_H, PART_W, ROW_GAP, SAME_COLUMN_BULGE, layoutSystemMap } from './systemMapLayout'
import type { SystemMapBox, SystemMapLine } from './systemMapModel'

const box = (id: string, column: number, row: number): SystemMapBox => ({ id, label: id, kind: 'service', column, row, noFiles: false, touchers: [] })
const line = (from: string, to: string): SystemMapLine => ({ id: `line:${from}>${to}`, from, to, implied: false })

// Column 0 holds three parts, column 1 one, column 2 two.
const boxes = [box('a0', 0, 0), box('a1', 0, 1), box('a2', 0, 2), box('b0', 1, 0), box('c0', 2, 0), box('c1', 2, 1)]
const STEP = PART_H + ROW_GAP

describe('layoutSystemMap', () => {
  const { positions, routes } = layoutSystemMap(boxes, [line('a0', 'b0'), line('c1', 'b0'), line('a0', 'a2'), line('a0', 'ghost')], 3)

  it('x by column', () => {
    expect(positions.get('a1')!.x).toBe(0)
    expect(positions.get('b0')!.x).toBe(PART_W + COL_GAP)
    expect(positions.get('c1')!.x).toBe(2 * (PART_W + COL_GAP))
  })

  it('the tallest column starts at the top; a shorter one is centred on it', () => {
    expect([0, 1, 2].map((r) => positions.get(`a${r}`)!.y)).toEqual([0, STEP, 2 * STEP])
    expect(positions.get('b0')!.y).toBe(STEP) // (3 - 1) rows / 2
    expect(positions.get('c0')!.y).toBe(STEP / 2) // (3 - 2) rows / 2
    expect(positions.get('c1')!.y).toBe(STEP / 2 + STEP)
  })

  it('left to right: source right-middle to target left-middle', () => {
    const s = positions.get('a0')!
    const t = positions.get('b0')!
    expect(routes.get('line:a0>b0')).toEqual([{ x: s.x + PART_W, y: s.y + PART_H / 2 }, { x: t.x, y: t.y + PART_H / 2 }])
  })

  it('right to left: source left-middle to target right-middle', () => {
    const s = positions.get('c1')!
    const t = positions.get('b0')!
    expect(routes.get('line:c1>b0')).toEqual([{ x: s.x, y: s.y + PART_H / 2 }, { x: t.x + PART_W, y: t.y + PART_H / 2 }])
  })

  it('same column: out to the right, a bulge, and back in', () => {
    const s = positions.get('a0')!
    const t = positions.get('a2')!
    const right = s.x + PART_W
    expect(routes.get('line:a0>a2')).toEqual([
      { x: right, y: s.y + PART_H / 2 },
      { x: right + SAME_COLUMN_BULGE, y: s.y + PART_H / 2 },
      { x: right + SAME_COLUMN_BULGE, y: t.y + PART_H / 2 },
      { x: right, y: t.y + PART_H / 2 }
    ])
  })

  it('a line to a part with no box has no route', () => {
    expect(routes.has('line:a0>ghost')).toBe(false)
  })

  it('nothing to lay out is an empty layout', () => {
    expect(layoutSystemMap([], [], 0)).toEqual({ positions: new Map(), routes: new Map() })
  })
})
