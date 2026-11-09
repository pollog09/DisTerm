import type { Graph3dSurface, Rgba } from '../../lib/agentGraph3d'

/** An equirectangular map: x runs once round the equator, y from pole to pole. */
export const SURFACE_WIDTH = 256
export const SURFACE_HEIGHT = 128

/** Toward white for k > 0, toward black for k < 0. */
export function tone(c: Rgba, k: number): Rgba {
  const t = Math.max(-1, Math.min(1, k))
  const to = t > 0 ? 255 : 0
  const mix = (v: number): number => Math.round(v + (to - v) * Math.abs(t))
  return { r: mix(c.r), g: mix(c.g), b: mix(c.b), a: 1 }
}

function shade(c: Rgba, k: number, alpha = 1): string {
  const { r, g, b } = tone(c, k)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Park-Miller, as the star field uses: the same seed paints the same world on every mount. */
function random(seed: number): () => number {
  let s = (seed % 2147483646) + 1
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646
}

/** Draws once, and again a width over when it crosses the seam, so the map wraps with no cut. */
function wrapped(x: number, reach: number, draw: (x: number) => void): void {
  draw(x)
  if (x - reach < 0) draw(x + SURFACE_WIDTH)
  if (x + reach > SURFACE_WIDTH) draw(x - SURFACE_WIDTH)
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
  wrapped(x, r, (cx) => {
    ctx.beginPath()
    ctx.arc(cx, y, r, 0, Math.PI * 2)
    ctx.fillStyle = fill
    ctx.fill()
  })
}

function gas(ctx: CanvasRenderingContext2D, base: Rgba, rand: () => number): void {
  const waves = [5 + rand() * 4, 11 + rand() * 6, 23 + rand() * 8].map((f) => ({ f, p: rand() * Math.PI * 2 }))
  for (let y = 0; y < SURFACE_HEIGHT; y++) {
    const t = y / SURFACE_HEIGHT
    const band = waves.reduce((sum, w, i) => sum + Math.sin(t * Math.PI * w.f + w.p) * [0.5, 0.3, 0.2][i], 0)
    const pole = Math.pow(Math.abs(t - 0.5) * 2, 3)
    ctx.fillStyle = shade(base, band * 0.26 - pole * 0.3)
    ctx.fillRect(0, y, SURFACE_WIDTH, 1)
  }
  for (let i = 0; i < 9; i++) {
    const y = SURFACE_HEIGHT * (0.15 + rand() * 0.7)
    const from = rand() * SURFACE_WIDTH
    const length = 40 + rand() * 120
    ctx.fillStyle = shade(base, rand() > 0.5 ? 0.35 : -0.3, 0.18)
    wrapped(from + length / 2, length / 2, (cx) => ctx.fillRect(cx - length / 2, y, length, 1 + rand() * 2))
  }
  const x = rand() * SURFACE_WIDTH
  const y = SURFACE_HEIGHT * (0.35 + rand() * 0.3)
  const rx = 10 + rand() * 10
  wrapped(x, rx, (cx) => {
    ctx.beginPath()
    ctx.ellipse(cx, y, rx, rx * 0.45, 0, 0, Math.PI * 2)
    ctx.fillStyle = shade(base, -0.28, 0.85)
    ctx.fill()
    ctx.beginPath()
    ctx.ellipse(cx, y, rx * 0.55, rx * 0.22, 0, 0, Math.PI * 2)
    ctx.fillStyle = shade(base, 0.2, 0.7)
    ctx.fill()
  })
}

function rock(ctx: CanvasRenderingContext2D, base: Rgba, rand: () => number, dark: number, craters: number): void {
  ctx.fillStyle = shade(base, dark)
  ctx.fillRect(0, 0, SURFACE_WIDTH, SURFACE_HEIGHT)
  for (let i = 0; i < 70; i++) {
    disc(ctx, rand() * SURFACE_WIDTH, rand() * SURFACE_HEIGHT, 3 + rand() * 13, shade(base, dark + (rand() - 0.5) * 0.3, 0.35))
  }
  for (let i = 0; i < craters; i++) {
    const x = rand() * SURFACE_WIDTH
    const y = SURFACE_HEIGHT * (0.1 + rand() * 0.8)
    const r = 1.5 + rand() * 5.5
    disc(ctx, x, y, r, shade(base, dark - 0.3, 0.75))
    wrapped(x, r, (cx) => {
      ctx.beginPath()
      ctx.arc(cx, y, r, Math.PI * 0.9, Math.PI * 1.9)
      ctx.strokeStyle = shade(base, dark + 0.3, 0.8)
      ctx.lineWidth = 1.2
      ctx.stroke()
    })
  }
}

function ice(ctx: CanvasRenderingContext2D, base: Rgba, rand: () => number): void {
  ctx.fillStyle = shade(base, 0.45)
  ctx.fillRect(0, 0, SURFACE_WIDTH, SURFACE_HEIGHT)
  for (let i = 0; i < 30; i++) disc(ctx, rand() * SURFACE_WIDTH, rand() * SURFACE_HEIGHT, 6 + rand() * 18, shade(base, 0.25 + rand() * 0.4, 0.3))
  ctx.lineWidth = 1
  for (let i = 0; i < 16; i++) {
    let x = rand() * SURFACE_WIDTH
    let y = rand() * SURFACE_HEIGHT
    ctx.strokeStyle = shade(base, -0.05, 0.55)
    ctx.beginPath()
    ctx.moveTo(x, y)
    for (let k = 0; k < 5; k++) {
      x += (rand() - 0.5) * 30
      y += (rand() - 0.5) * 14
      ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
}

/** Paints a world's map onto a canvas the caller sized to SURFACE_WIDTH by SURFACE_HEIGHT. */
export function paintSurface(ctx: CanvasRenderingContext2D, surface: Graph3dSurface, base: Rgba, seed: number): void {
  const rand = random(seed)
  if (surface === 'gas') gas(ctx, base, rand)
  else if (surface === 'ice') ice(ctx, base, rand)
  else if (surface === 'asteroid') rock(ctx, base, rand, -0.2, 34)
  else rock(ctx, base, rand, -0.04, 18)
}

/* Light that is tinted by the sprite that wears it, so each is painted once, in white. */

/** A star's corona: a hot core fading out, crossed by long uneven rays. */
export function paintCorona(ctx: CanvasRenderingContext2D, size: number): void {
  const c = size / 2
  const rand = random(7)
  ctx.save()
  ctx.translate(c, c)
  for (let i = 0; i < 110; i++) {
    const angle = rand() * Math.PI * 2
    const reach = c * (0.45 + rand() * 0.55)
    const spread = 0.012 + rand() * 0.03
    const ray = ctx.createLinearGradient(0, 0, Math.cos(angle) * reach, Math.sin(angle) * reach)
    ray.addColorStop(0, `rgba(255, 255, 255, ${0.12 + rand() * 0.14})`)
    ray.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = ray
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(Math.cos(angle - spread) * reach, Math.sin(angle - spread) * reach)
    ctx.lineTo(Math.cos(angle + spread) * reach, Math.sin(angle + spread) * reach)
    ctx.fill()
  }
  ctx.restore()
  const glow = ctx.createRadialGradient(c, c, 0, c, c, c)
  glow.addColorStop(0, 'rgba(255, 255, 255, 0.95)')
  glow.addColorStop(0.16, 'rgba(255, 255, 255, 0.55)')
  glow.addColorStop(0.4, 'rgba(255, 255, 255, 0.16)')
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)
}

/** The soft light round a planet. */
export function paintGlow(ctx: CanvasRenderingContext2D, size: number): void {
  const c = size / 2
  const glow = ctx.createRadialGradient(c, c, 0, c, c, c)
  glow.addColorStop(0, 'rgba(255, 255, 255, 0.7)')
  glow.addColorStop(0.35, 'rgba(255, 255, 255, 0.28)')
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)
}

/** A cloud of dust: many faint overlapping puffs, thickest in the middle. */
export function paintNebula(ctx: CanvasRenderingContext2D, size: number, seed: number): void {
  const rand = random(seed)
  const c = size / 2
  for (let i = 0; i < 70; i++) {
    const r = size * (0.06 + rand() * 0.16)
    const d = c * 0.62 * Math.sqrt(rand())
    const a = rand() * Math.PI * 2
    const x = c + Math.cos(a) * d
    const y = c + Math.sin(a) * d * 0.7
    const puff = ctx.createRadialGradient(x, y, 0, x, y, r)
    puff.addColorStop(0, `rgba(255, 255, 255, ${0.05 + rand() * 0.07})`)
    puff.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = puff
    ctx.fillRect(x - r, y - r, r * 2, r * 2)
  }
}
