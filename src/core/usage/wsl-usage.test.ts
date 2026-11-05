// What the `usage:remote` surface does for a distribution. The command is the SSH one, covered with a
// real /bin/sh in remote-claude-usage.test.ts; this is the part that differs: no boot, no ssh target.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import type { RemoteAccountUsage } from '../../shared/types'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform, type FakePlatform } from '../platform-fake'
import type { RemoteUsageTarget } from './remote-claude-usage'
import { startUsageService, type UsageService } from './usage-service'
import { defaultWslUsageDeps, wslUsageTarget, type WslUsageDeps } from './wsl-usage'

const reply = (...lines: string[]): string => ['__NTU_BEGIN__', ...lines, '__NTU_END__'].join('\n')
const OK = reply(
  '__NTU_EMAIL__me@example.com',
  JSON.stringify({ limits: [{ kind: 'weekly_all', group: 'weekly', percent: 1 }] }),
  '__NTU_HTTP__200'
)
const HOST = 'wsl:Ubuntu'

let platform: FakePlatform
let service: UsageService | undefined

beforeEach(() => {
  resetPlatformForTests()
  platform = fakePlatform()
  initPlatform(platform)
})
afterEach(() => {
  service?.dispose()
  service = undefined
  resetPlatformForTests()
})

function deps(over: Partial<WslUsageDeps> = {}): WslUsageDeps & { run: ReturnType<typeof vi.fn> } {
  return { isRunning: async () => true, run: vi.fn(async () => OK), ...over } as never
}
const ask = (q: { hostKey?: string; force?: boolean }): Promise<RemoteAccountUsage[]> =>
  platform.handlers[IPC.usageRemote](q) as Promise<RemoteAccountUsage[]>

describe('wslUsageTarget', () => {
  it('names the row the way its terminal row reads', () => {
    expect(wslUsageTarget(HOST)).toMatchObject({ hostKey: HOST, accountId: null, label: 'WSL: Ubuntu' })
  })

  it.each(['wsl:-d', 'wsl:', 'root@host', 'wsl:a%0Ab', undefined])(
    'refuses %s, because the name becomes an argv element',
    (value) => {
      expect(wslUsageTarget(value)).toBeNull()
    }
  )
})

describe('usage:remote for a distribution', () => {
  it('has no real reader off Windows, whatever the renderer asks', async () => {
    expect(defaultWslUsageDeps('linux')).toBeNull()
    expect(defaultWslUsageDeps('darwin')).toBeNull()
    expect(defaultWslUsageDeps('win32')).not.toBeNull()
    service = startUsageService({ shouldPoll: () => false, wsl: null })
    await expect(ask({ hostKey: HOST })).resolves.toEqual([])
  })

  it('reads inside the distribution with no ssh deps at all, which is the Server Edition', async () => {
    const wsl = deps()
    service = startUsageService({ shouldPoll: () => false, wsl })
    const rows = await ask({ hostKey: HOST })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ hostKey: HOST, label: 'WSL: Ubuntu', accountId: null })
    expect(rows[0].usage.status).toBe('ok')
    expect(wsl.run).toHaveBeenCalledTimes(1)
  })

  it('never reads a stopped distribution, so a pill cannot boot one', async () => {
    const wsl = deps({ isRunning: async () => false })
    service = startUsageService({ shouldPoll: () => false, wsl })
    await expect(ask({ hostKey: HOST })).resolves.toEqual([])
    expect(wsl.run).not.toHaveBeenCalled()
  })

  it('treats a failed running check as not running', async () => {
    const wsl = deps({ isRunning: async () => { throw new Error('no wsl') } })
    service = startUsageService({ shouldPoll: () => false, wsl })
    await expect(ask({ hostKey: HOST })).resolves.toEqual([])
    expect(wsl.run).not.toHaveBeenCalled()
  })

  it('keeps the last numbers when the distribution stops', async () => {
    let up = true
    const wsl = deps({ isRunning: async () => up })
    service = startUsageService({ shouldPoll: () => false, wsl })
    await ask({ hostKey: HOST })
    up = false
    const rows = await ask({ hostKey: HOST, force: true })
    expect(rows[0].usage.limits).toHaveLength(1)
    expect(wsl.run).toHaveBeenCalledTimes(1)
  })

  it('answers inside the debounce from cache, and ⟳ goes past it', async () => {
    const wsl = deps()
    service = startUsageService({ shouldPoll: () => false, wsl })
    await ask({ hostKey: HOST })
    await ask({ hostKey: HOST })
    expect(wsl.run).toHaveBeenCalledTimes(1)
    await ask({ hostKey: HOST, force: true })
    expect(wsl.run).toHaveBeenCalledTimes(2)
  })

  it('is not evicted by a read of an SSH host, which it is not one of', async () => {
    const wsl = deps()
    const target: RemoteUsageTarget = { key: 'u@a#', hostKey: 'u@a', projectId: 'p', accountId: null, label: 'u@a' }
    service = startUsageService({
      shouldPoll: () => false,
      wsl,
      remote: { targets: () => [target], run: async () => OK }
    })
    await ask({ hostKey: HOST })
    await ask({ hostKey: 'u@a' })
    await ask({ hostKey: HOST })
    expect(wsl.run).toHaveBeenCalledTimes(1)
  })

  it('reports an expired login as such, and it is not a failure', async () => {
    const wsl = deps({ run: vi.fn(async () => reply('__NTU_EMAIL__', '{}', '__NTU_HTTP__401')) as never })
    service = startUsageService({ shouldPoll: () => false, wsl })
    const [row] = await ask({ hostKey: HOST })
    expect(row.usage.status).toBe('unavailable')
    expect(row.provider !== 'codex' && row.usage.loginExpired).toBe(true)
  })
})
