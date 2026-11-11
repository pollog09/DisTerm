import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

/** A PNG's opening bytes for a w x h image, padded to `pad` bytes, as base64. */
function png(w: number, h: number, pad: number): string {
  const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be(w), ...be(h)]
  while (bytes.length < pad) bytes.push(0)
  return btoa(String.fromCharCode(...bytes))
}

const SHOT = png(2560, 1440, 3000)
const SMALL = png(1280, 720, 600)

function world(on: On, opts: { resizer?: string } = {}) {
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  const toasts: string[] = []
  mock.env(on, { HOME: '/home/u' })
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    const script = e.argv[2] ?? ''
    let stdout = ''
    if (script.includes('uname -s')) stdout = `${opts.resizer ?? ''}\nos=Linux\n`
    else if (script.includes('mktemp -d')) stdout = SMALL
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { runs, toasts }
}

type Blocks = { result: Record<string, unknown>[] }

test('a large screenshot is shrunk, with a scale note and a ledger line', async ($, on) => {
  const w = world(on, { resizer: 'magick' })
  on('tool.call', () => ({ result: [{ type: 'image', data: SHOT, mimeType: 'image/png' }] }))
  const r = (await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'screenshot' })) as Blocks
  expect(r.result[0]?.data).toBe(SMALL)
  expect(String(r.result[1]?.text)).toContain('2560x1440 to 1280x720')
  expect(String(r.result[1]?.text)).toContain('multiply x and y by 2')
  const shrink = w.runs.find((run) => (run.argv[2] ?? '').includes('mktemp -d'))
  expect(shrink?.argv[4]).toBe('magick')
  expect(shrink?.stdin).toBe(SHOT)
  const line = JSON.parse(w.runs.find((run) => run.argv.join(' ').includes('cat >>'))?.stdin ?? '{}')
  expect(line.mod).toBe('efficient-browser-use')
  expect(line.before).toBe(Math.ceil((2560 * 1440) / 750))
  expect(line.after).toBe(Math.ceil((1280 * 720) / 750))
})

test('an image in API spelling keeps that spelling', async ($, on) => {
  world(on, { resizer: 'python3' })
  on('tool.call', () => ({
    result: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: SHOT } }],
  }))
  const r = (await $.tool.call({ tool: 'mcp__playwright__browser_take_screenshot' })) as Blocks
  expect((r.result[0]?.source as { data: string }).data).toBe(SMALL)
})

test('a small screenshot passes as it is', async ($, on) => {
  const w = world(on, { resizer: 'magick' })
  on('tool.call', () => ({ result: [{ type: 'image', data: SMALL, mimeType: 'image/png' }] }))
  const r = (await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'screenshot' })) as Blocks
  expect(r.result.length).toBe(1)
  expect(w.runs.length).toBe(0)
})

test('a zoom Claude asked for is left alone', async ($, on) => {
  const w = world(on, { resizer: 'magick' })
  on('tool.call', () => ({ result: [{ type: 'image', data: SHOT, mimeType: 'image/png' }] }))
  const r = (await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'zoom' })) as Blocks
  expect(r.result[0]?.data).toBe(SHOT)
  expect(w.runs.length).toBe(0)
})

test('with no resizer the image passes, nothing is recorded, and one toast says why', async ($, on) => {
  const w = world(on, { resizer: '' })
  on('tool.call', () => ({ result: [{ type: 'image', data: SHOT, mimeType: 'image/png' }] }))
  const r = (await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'screenshot' })) as Blocks
  await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'screenshot' })
  expect(r.result[0]?.data).toBe(SHOT)
  expect(w.runs.some((run) => run.argv.join(' ').includes('cat >>'))).toBe(false)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('install ImageMagick')
})

test('tools that are not browsers are not touched', async ($, on) => {
  const w = world(on, { resizer: 'magick' })
  on('tool.call', () => ({ result: [{ type: 'image', data: SHOT, mimeType: 'image/png' }] }))
  const r = (await $.tool.call({ tool: 'mcp__figma__get_image' })) as Blocks
  expect(r.result[0]?.data).toBe(SHOT)
  expect(w.runs.length).toBe(0)
})
