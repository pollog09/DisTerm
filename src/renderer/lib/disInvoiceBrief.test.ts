import { describe, expect, it } from 'vitest'
import { disInvoiceBriefFile, type DisInvoiceBriefRequest } from './disInvoiceBrief'

const WINDOWS = 'C:\\Users\\me\\AppData\\launch-prompts\\t\\nodeterm-prompt-1.txt'

function harness(over: { saved?: string | null; inWsl?: { ok: true; path: string } | { ok: false; message: string } } = {}) {
  const log: string[] = []
  const io = {
    saveUpload: async (name: string, data: string) => {
      log.push(`save ${name.startsWith('nodeterm-prompt-')} ${atob(data).startsWith('You are starting work on task #7')}`)
      return over.saved === undefined ? WINDOWS : over.saved
    },
    encodeBase64: (text: string) => btoa(text),
    readableBriefPathInWsl: async (shell: string, file: string) => {
      log.push(`translate ${shell} ${file}`)
      return over.inWsl ?? { ok: true as const, path: '/mnt/c/Users/me/AppData/launch-prompts/t/nodeterm-prompt-1.txt' }
    }
  }
  const ask = (request: Partial<DisInvoiceBriefRequest>) =>
    disInvoiceBriefFile({ text: 'Migrar', taskId: 7, ssh: false, paneShell: undefined, ...request }, io)
  return { ask, log }
}

describe('disInvoiceBriefFile', () => {
  it.each([undefined, '', 'pwsh', 'cmd'])('a pane on this machine (%s) reads the saved path as it is', async (paneShell) => {
    const { ask, log } = harness()
    expect(await ask({ paneShell })).toEqual({ ok: true, path: WINDOWS })
    expect(log).toEqual(['save true true'])
  })

  it('a pane in a distribution gets the path that distribution reads', async () => {
    const { ask, log } = harness()
    expect(await ask({ paneShell: 'wsl:Ubuntu' })).toEqual({ ok: true, path: '/mnt/c/Users/me/AppData/launch-prompts/t/nodeterm-prompt-1.txt' })
    expect(log).toEqual(['save true true', `translate wsl:Ubuntu ${WINDOWS}`])
  })

  it('a path the distribution cannot read refuses the start and says why', async () => {
    const { ask } = harness({ inWsl: { ok: false, message: 'Ubuntu cannot read /mnt/c/x.' } })
    expect(await ask({ paneShell: 'wsl:Ubuntu' })).toEqual({
      ok: false,
      notice: 'This agent would start in WSL, where it cannot read the task brief, so it was not started. Ubuntu cannot read /mnt/c/x.'
    })
  })

  it('a malformed wsl: value is still asked about, not treated as this machine', async () => {
    const { ask, log } = harness({ inWsl: { ok: false, message: 'That is not a WSL distribution.' } })
    expect((await ask({ paneShell: 'wsl:-rf' })).ok).toBe(false)
    expect(log).toEqual(['save true true', `translate wsl:-rf ${WINDOWS}`])
  })

  it('an SSH project refuses before anything is written', async () => {
    const { ask, log } = harness()
    expect(await ask({ ssh: true, paneShell: 'wsl:Ubuntu' })).toEqual({
      ok: false,
      notice: 'An agent on an SSH project cannot read the brief, because it stays on this machine.'
    })
    expect(log).toEqual([])
  })

  it('a brief that could not be written refuses the start', async () => {
    const { ask } = harness({ saved: null })
    expect(await ask({})).toEqual({ ok: false, notice: 'Could not write the task brief, so no agent was started.' })
  })
})
