// The mods' pure logic, run by `npm test` too (vitest does not glob resources/, and `claude plugin
// test` needs the CLI). Engine-free modules only: they import types from 'claude-code', nothing else.
import path from 'path'
import { describe, expect, it } from 'vitest'

// Loaded by path, not by a static import: the repo's tsc would otherwise follow it into the mods,
// which are typed against the engine's own `claude-code` declarations, not this project's.
const MODS = path.join(__dirname, '..', '..', '..', 'resources', 'claude-mods', 'plugins')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (rel: string): Promise<any> => import(path.join(MODS, rel))
const { configFrom, decide, isRoutable, parseVerdict } = await load('model-router/hooks/policy.ts')
const { isInstructionFile, plainCatTarget } = await load('input-router/hooks/routing.ts')
const { chooseResizer, imageSize, shrinkTarget } = await load('efficient-browser-use/hooks/images.ts')

describe('model-router policy', () => {
  const cfg = configFrom({})
  it('moves down only past the lower bar, up past the raise bar, never without a confidence', () => {
    expect(decide('claude-opus-5-5', { tier: 'light', confidence: 0.9, why: '' }, cfg).model).toBe(cfg.lightModel)
    expect(decide('claude-opus-5-5', { tier: 'light', confidence: 0.5, why: '' }, cfg).model).toBeNull()
    expect(decide('claude-sonnet-5-5', { tier: 'heavy', confidence: 0.35, why: '' }, cfg).model).toBe(cfg.heavyModel)
    expect(decide('claude-opus-5-5', { tier: 'light', confidence: null, why: '' }, cfg).model).toBeNull()
    expect(decide('mystery-model', { tier: 'light', confidence: 1, why: '' }, cfg).model).toBeNull()
  })
  it('routes only a general-purpose spawn that set no model of its own', () => {
    const base = { fork: false, subagentType: 'general-purpose' }
    expect(isRoutable(base)).toBe(true)
    expect(isRoutable({ ...base, model: 'opus' })).toBe(false)
    expect(isRoutable({ ...base, fork: true })).toBe(false)
    expect(isRoutable({ ...base, subagentType: 'reviewer' })).toBe(false)
  })
  it('reads the first JSON object of the judge, and refuses an unknown tier', () => {
    expect(parseVerdict('ok {"tier":"standard","confidence":0.7,"why":"x"} done')?.tier).toBe('standard')
    expect(parseVerdict('{"tier":"fast","confidence":1}')).toBeNull()
    expect(parseVerdict('{"tier":"light","confidence":7}')?.confidence).toBeNull()
  })
})

describe('input-router routing', () => {
  it('treats only a plain cat of one file as a file read', () => {
    expect(plainCatTarget('cat src/a.ts')).toBe('src/a.ts')
    expect(plainCatTarget("cat 'my file.txt'")).toBe('my file.txt')
    expect(plainCatTarget('cat a.ts | grep x')).toBeNull()
    expect(plainCatTarget('cat $(echo a)')).toBeNull()
    expect(plainCatTarget('cat -n a.ts')).toBeNull()
  })
  it('never summarises instruction files', () => {
    expect(isInstructionFile('/repo/CLAUDE.md')).toBe(true)
  })
})

describe('efficient-browser-use images', () => {
  it('picks a resizer per platform, Linux first ImageMagick then python', () => {
    expect(chooseResizer('linux', ['python3', 'convert'])).toBe('convert')
    expect(chooseResizer('linux', ['python3'])).toBe('python3')
    expect(chooseResizer('linux', ['sips'])).toBeNull()
    expect(chooseResizer('darwin', ['sips', 'magick'])).toBe('sips')
    expect(chooseResizer('windows', [])).toBeNull()
  })
  it('shrinks only images past the long side and the token floor', () => {
    expect(shrinkTarget({ width: 2560, height: 1440 })).toEqual({ width: 1280, height: 720 })
    expect(shrinkTarget({ width: 1280, height: 800 })).toBeNull()
  })
  it('reads a PNG header', () => {
    const png = new Uint8Array(24)
    png.set([0x89, 0x50, 0x4e, 0x47], 0)
    new DataView(png.buffer).setUint32(16, 1920)
    new DataView(png.buffer).setUint32(20, 1080)
    expect(imageSize(png)).toEqual({ width: 1920, height: 1080 })
  })
})
