// The switches file the mods read on every event: `{ "<mod>": false }` = off, a missing key = on.
// DisTerm writes it whole (read, change, publish atomically); keys it does not know are kept.
import fs from 'fs'
import path from 'path'
import { TOKEN_SAVER_IDS, type TokenSaverId } from '../../shared/token-savers'
import { writeFileAtomic } from '../fs-atomic'

export function parseSwitches(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function switchesView(json: Record<string, unknown>): Record<TokenSaverId, boolean> {
  const out = {} as Record<TokenSaverId, boolean>
  for (const id of TOKEN_SAVER_IDS) out[id] = json[id] !== false
  return out
}

/** Off is `false`; on deletes the key, so a file the user never touched stays empty. */
export function withSwitch(json: Record<string, unknown>, id: string, on: boolean): Record<string, unknown> {
  const next = { ...json }
  if (on) delete next[id]
  else next[id] = false
  return next
}

export async function readSwitches(file: string): Promise<Record<string, unknown>> {
  try {
    return parseSwitches(await fs.promises.readFile(file, 'utf8'))
  } catch {
    return {}
  }
}

export async function writeSwitch(file: string, id: TokenSaverId, on: boolean): Promise<Record<string, unknown>> {
  const next = withSwitch(await readSwitches(file), id, on)
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  return next
}
