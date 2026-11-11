// Pure parts of efficient-browser-use: which tools it watches, where the images sit in a result,
// how big they are, how small they become, and which host program shrinks them. No engine calls
// here, so DisTerm's own tests import this file directly.

export { isBrowserTool } from './common'

/** An image's long side after shrinking. */
export const MAX_SIDE = 1280

/** Images that cost fewer tokens than this pass as they are. */
export const MIN_TOKENS = 1200

/** Image tokens as the API counts them, roughly. */
export function imageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750)
}

export interface Size {
  width: number
  height: number
}

/** The size to shrink to, or null when the image is already small enough. */
export function shrinkTarget(size: Size, maxSide = MAX_SIDE, minTokens = MIN_TOKENS): Size | null {
  const long = Math.max(size.width, size.height)
  if (long <= maxSide) return null
  if (imageTokens(size.width, size.height) < minTokens) return null
  const k = maxSide / long
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) }
}

/** True when Claude itself chose how the picture is sized (a zoom, an explicit scale). */
export function claudeSizedIt(input: Record<string, unknown>): boolean {
  const own = (a: unknown): boolean =>
    typeof a === 'object' && a !== null && ((a as Record<string, unknown>).action === 'zoom' || typeof (a as Record<string, unknown>).scale === 'number')
  if (own(input)) return true
  return Array.isArray(input.actions) && input.actions.some(own)
}

// ---- base64 and image headers ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX: Record<string, number> = {}
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]!] = i

/** Decodes the first `maxBytes` bytes of a base64 string (whitespace ignored). */
export function decodeHead(b64: string, maxBytes: number): Uint8Array {
  const chars = Math.ceil((maxBytes * 4) / 3 / 4) * 4
  const src = b64.slice(0, chars + 64).replace(/[^A-Za-z0-9+/]/g, '')
  const out: number[] = []
  for (let i = 0; i + 1 < src.length && out.length < maxBytes; i += 4) {
    const a = B64_INDEX[src[i]!] ?? 0
    const b = B64_INDEX[src[i + 1]!] ?? 0
    const c = src[i + 2] !== undefined ? B64_INDEX[src[i + 2]!] : undefined
    const d = src[i + 3] !== undefined ? B64_INDEX[src[i + 3]!] : undefined
    out.push(((a << 2) | (b >> 4)) & 255)
    if (c !== undefined) out.push((((b & 15) << 4) | (c >> 2)) & 255)
    if (c !== undefined && d !== undefined) out.push((((c & 3) << 6) | d) & 255)
  }
  return Uint8Array.from(out.slice(0, maxBytes))
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!

/** Width and height read from a PNG, JPEG, GIF or WebP header, or null. */
export function imageSize(bytes: Uint8Array): Size | null {
  const b = bytes
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: u32be(b, 16), height: u32be(b, 20) }
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: u16le(b, 6), height: u16le(b, 8) }
  }
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    if (chunk === 'VP8X') return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
    if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const marker = b[i + 1]!
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) return { width: u16be(b, i + 7), height: u16be(b, i + 5) }
      i += 2 + u16be(b, i + 2)
    }
  }
  return null
}

/** The size of a base64 image, from its first 256 KiB at most. */
export function base64ImageSize(b64: string): Size | null {
  return imageSize(decodeHead(b64, 262144))
}

// ---- where images sit in a result ----

export interface ImageRef {
  base64: string
  mime: string
  /** Puts a new image in the block's place, in the block's own spelling. */
  put: (base64: string, mime: string) => Record<string, unknown>
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The image in one content block (MCP `{ data, mimeType }` or API `{ source: { data } }`). */
export function imageIn(block: unknown): ImageRef | null {
  if (!isObj(block) || block.type !== 'image') return null
  if (typeof block.data === 'string') {
    return {
      base64: block.data,
      mime: String(block.mimeType ?? 'image/png'),
      put: (base64, mime) => ({ ...block, data: base64, mimeType: mime }),
    }
  }
  const src = block.source
  if (isObj(src) && typeof src.data === 'string') {
    return {
      base64: src.data,
      mime: String(src.media_type ?? 'image/png'),
      put: (base64, mime) => ({ ...block, source: { ...src, data: base64, media_type: mime } }),
    }
  }
  return null
}

/** The content blocks of a result: the result itself when it is a list, or its `content` list. */
export function blocksOf(result: unknown): unknown[] | null {
  if (Array.isArray(result)) return result
  if (isObj(result) && Array.isArray(result.content)) return result.content
  return null
}

/** The result with its blocks replaced, in the same outer shape. */
export function withBlocks(result: unknown, blocks: unknown[]): unknown {
  if (Array.isArray(result)) return blocks
  if (isObj(result)) return { ...result, content: blocks }
  return result
}

/** The note added after a shrunk screenshot, so clicks read off it still land. */
export function scaleNote(from: Size, to: Size): string {
  const k = Math.round((from.width / to.width) * 1000) / 1000
  return (
    `[efficient-browser-use] The screenshot above was shrunk from ${from.width}x${from.height} to ${to.width}x${to.height}. ` +
    `If you read a coordinate off it to click or type, multiply x and y by ${k}. ` +
    'To see small text, zoom or read the page as text; the person can type /efficient-browser full for one full-size screenshot.'
  )
}

// ---- which host program shrinks ----

export type Platform = 'darwin' | 'linux' | 'windows' | 'other'
export type Resizer = 'sips' | 'magick' | 'convert' | 'python3' | 'powershell'

/** The resizer to use, given the platform and the programs found on the host. */
export function chooseResizer(platform: Platform, found: readonly string[]): Resizer | null {
  const has = (r: Resizer) => found.includes(r)
  if (platform === 'windows') return has('powershell') ? 'powershell' : null
  const order: Resizer[] = platform === 'darwin' ? ['sips', 'magick', 'convert', 'python3'] : ['magick', 'convert', 'python3']
  return order.find(has) ?? null
}

/** The output format for a source type: JPEG stays JPEG, everything else becomes PNG. */
export function outputFormat(mime: string): { ext: 'jpg' | 'png'; mime: 'image/jpeg' | 'image/png'; name: 'jpeg' | 'png' } {
  return /jpe?g/i.test(mime) ? { ext: 'jpg', mime: 'image/jpeg', name: 'jpeg' } : { ext: 'png', mime: 'image/png', name: 'png' }
}

/** Lists, one per line, the resizers a POSIX host has, then `uname -s`. */
export const POSIX_PROBE = [
  'for c in sips magick; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done',
  'convert -version 2>/dev/null | grep -q ImageMagick && echo convert',
  'python3 -I -c "import PIL" >/dev/null 2>&1 && echo python3',
  'echo "os=$(uname -s)"',
].join('\n')

/** Reads the probe's output. */
export function readProbe(stdout: string): { platform: Platform; found: string[] } {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  const os = lines.find((l) => l.startsWith('os='))?.slice(3) ?? ''
  const platform: Platform = os === 'Darwin' ? 'darwin' : os === 'Linux' ? 'linux' : 'other'
  return { platform, found: lines.filter((l) => !l.startsWith('os=')) }
}

const PIL_SCRIPT = [
  'import sys',
  'from PIL import Image',
  'src, dst, side, fmt = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]',
  'im = Image.open(src)',
  'im.thumbnail((side, side), Image.LANCZOS)',
  "if fmt == 'jpeg' and im.mode not in ('RGB', 'L'): im = im.convert('RGB')",
  "im.save(dst, 'JPEG' if fmt == 'jpeg' else 'PNG', **({'quality': 85} if fmt == 'jpeg' else {}))",
].join('\n')

/**
 * The POSIX shrink script. The image arrives base64 on stdin and leaves base64 on stdout; it
 * touches disk only inside a `mktemp -d` folder removed on exit. Arguments:
 * $1 resizer, $2 extension, $3 long side, $4 format name, $5 the PIL script.
 */
export const POSIX_SHRINK = [
  'set -e',
  'd=$(mktemp -d 2>/dev/null || mktemp -d -t disterm-shrink)',
  'trap \'rm -rf "$d"\' EXIT',
  'tee "$d/in.b64" >/dev/null',
  'base64 -d < "$d/in.b64" > "$d/in.$2" 2>/dev/null || base64 -D -i "$d/in.b64" -o "$d/in.$2"',
  'case "$1" in',
  '  sips) sips -s format "$4" -Z "$3" "$d/in.$2" --out "$d/out.$2" >/dev/null ;;',
  '  magick) magick "$d/in.$2" -resize "${3}x${3}>" -quality 85 "$d/out.$2" ;;',
  '  convert) convert "$d/in.$2" -resize "${3}x${3}>" -quality 85 "$d/out.$2" ;;',
  '  python3) python3 -I -c "$5" "$d/in.$2" "$d/out.$2" "$3" "$4" ;;',
  '  *) exit 3 ;;',
  'esac',
  'base64 < "$d/out.$2" | tr -d "\\n\\r "',
].join('\n')

/** The Windows shrink script: base64 on stdin, base64 on stdout, System.Drawing in memory. */
export const WINDOWS_SHRINK = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Drawing',
  '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '$img = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(,$bytes)))',
  '$side = [int]$env:DISTERM_SHRINK_SIDE',
  '$k = [Math]::Min(1.0, $side / [double][Math]::Max($img.Width, $img.Height))',
  '$w = [Math]::Max(1, [int][Math]::Round($img.Width * $k)); $h = [Math]::Max(1, [int][Math]::Round($img.Height * $k))',
  '$bmp = New-Object System.Drawing.Bitmap($w, $h)',
  '$g = [System.Drawing.Graphics]::FromImage($bmp)',
  "$g.InterpolationMode = 'HighQualityBicubic'",
  '$g.DrawImage($img, 0, 0, $w, $h); $g.Dispose()',
  '$out = New-Object System.IO.MemoryStream',
  "if ($env:DISTERM_SHRINK_FORMAT -eq 'jpeg') { $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Jpeg) } else { $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) }",
  '[Console]::Out.Write([Convert]::ToBase64String($out.ToArray()))',
].join('; ')

export interface ShrinkCommand {
  argv: string[]
  env?: Record<string, string>
}

/** The command that shrinks one image with `resizer`; the image itself goes on stdin. */
export function shrinkCommand(resizer: Resizer, mime: string, side = MAX_SIDE): ShrinkCommand {
  const fmt = outputFormat(mime)
  if (resizer === 'powershell') {
    return {
      argv: ['powershell', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SHRINK],
      env: { DISTERM_SHRINK_SIDE: String(side), DISTERM_SHRINK_FORMAT: fmt.name },
    }
  }
  return { argv: ['sh', '-c', POSIX_SHRINK, 'sh', resizer, fmt.ext, String(side), fmt.name, PIL_SCRIPT] }
}
