import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assembleLaunchCommand } from '../../shared/agents/launch'
import { disInvoiceBrief } from '../../shared/dis-invoice'
import type { ProfileExec } from '../terminal-profiles'
import { readableBriefPathInWsl } from './wsl-brief'

const WINDOWS_FILE = "C:\\Users\\Jane Doe\\it's\\launch-prompts\\t1\\nodeterm-prompt-1.txt"

// No Windows machine here, so `wsl.exe` is the one stand-in: the argv after `--exec` runs under a real
// /bin/sh's PATH, with a fake `wslpath` that maps C:\ to <root>/mnt/c the way drvfs does. The `test -r`
// and the `"$(cat ...)"` line are the real ones, against a real file.
describe.skipIf(process.platform === 'win32')('a dis-invoice brief reaching a pane in a distribution', () => {
  let root: string
  let calls: string[][]

  const fakeWsl = (wslpath: string): ProfileExec => {
    const bin = path.join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(bin, 'wslpath'), `#!/bin/sh\n${wslpath}\n`)
    chmodSync(path.join(bin, 'wslpath'), 0o755)
    return async (_file, args) => {
      calls.push(args)
      const [program, ...rest] = args.slice(args.indexOf('--exec') + 1)
      const run = spawnSync(program, rest, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROOT: root } })
      return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr }
    }
  }

  const DRVFS = `printf '%s' "$3" | sed -e "s#^C:#$ROOT/mnt/c#" -e 's#\\\\#/#g'`

  const typedLine = (promptFile: string): string =>
    assembleLaunchCommand({ agentId: 'claude', promptFile, launchCmdOverride: "printf '[%s]\\n'" }, {}).command

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-dis-wsl-'))
    calls = []
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const writeBrief = (text: string): string => {
    const linuxPath = path.join(root, 'mnt/c/Users/Jane Doe/it\'s/launch-prompts/t1/nodeterm-prompt-1.txt')
    mkdirSync(path.dirname(linuxPath), { recursive: true })
    writeFileSync(linuxPath, text)
    return linuxPath
  }

  it('the Windows path on the typed line reads nothing, which is the failure this exists for', () => {
    const run = spawnSync('/bin/sh', ['-c', typedLine(WINDOWS_FILE)], { encoding: 'utf8' })
    expect(run.stdout).toBe('[]\n')
  })

  it('the translated path hands the agent the whole brief as one argument', async () => {
    const brief = disInvoiceBrief('Migrar el DNS\n\nClient: Exotic', 101)
    const linuxPath = writeBrief(brief)
    const answer = await readableBriefPathInWsl('wsl:Ubuntu', WINDOWS_FILE, fakeWsl(DRVFS))
    expect(answer).toEqual({ ok: true, path: linuxPath })
    expect(calls).toEqual([
      ['-d', 'Ubuntu', '--exec', 'wslpath', '-a', '-u', WINDOWS_FILE],
      ['-d', 'Ubuntu', '--exec', 'test', '-r', linuxPath]
    ])
    expect(execFileSync('/bin/sh', ['-c', typedLine(linuxPath)], { encoding: 'utf8' })).toBe(`[${brief}]\n`)
  })

  it('follows whatever the distribution answers, so a custom automount root works', async () => {
    const custom = path.join(root, 'windows/c/nodeterm-prompt-1.txt')
    mkdirSync(path.dirname(custom), { recursive: true })
    writeFileSync(custom, 'brief')
    const answer = await readableBriefPathInWsl('wsl:Ubuntu', WINDOWS_FILE, fakeWsl(`printf '%s' '${custom}'`))
    expect(answer).toEqual({ ok: true, path: custom })
  })

  it('refuses a path wslpath cannot translate, such as a network share, with its reason', async () => {
    const share = '\\\\server\\share\\nodeterm-prompt-1.txt'
    const answer = await readableBriefPathInWsl('wsl:Ubuntu', share, fakeWsl(`echo 'wslpath: not a drive' >&2; exit 1`))
    expect(answer).toEqual({ ok: false, message: `WSL could not open "${share}" in Ubuntu: wslpath: not a drive` })
  })

  it('refuses a translated path the distribution cannot read, rather than start on an empty prompt', async () => {
    const linuxPath = path.join(root, 'mnt/c/Users/Jane Doe/it\'s/launch-prompts/t1/nodeterm-prompt-1.txt')
    const answer = await readableBriefPathInWsl('wsl:Ubuntu', WINDOWS_FILE, fakeWsl(DRVFS))
    expect(answer).toEqual({ ok: false, message: `Ubuntu cannot read ${linuxPath}.` })
  })

  it('refuses a shell value that is not a distribution, without running anything', async () => {
    const exec: ProfileExec = async () => {
      throw new Error('must not run')
    }
    expect(await readableBriefPathInWsl('pwsh', WINDOWS_FILE, exec)).toEqual({ ok: false, message: 'That is not a WSL distribution.' })
    expect(await readableBriefPathInWsl('wsl:-rf', WINDOWS_FILE, exec)).toEqual({ ok: false, message: 'That is not a WSL distribution.' })
  })

  it('answers a wsl.exe that cannot run with its reason, not a throw', async () => {
    const exec: ProfileExec = async () => {
      throw new Error('wsl.exe did not answer')
    }
    expect(await readableBriefPathInWsl('wsl:Ubuntu', WINDOWS_FILE, exec)).toEqual({ ok: false, message: 'wsl.exe did not answer' })
  })
})
