import { describe, expect, it } from 'vitest'
import { wslCreateOptions } from './wslCreateOptions'

describe('wslCreateOptions', () => {
  it('makes a terminal choice carrying the shell, with a key of its own', () => {
    const [row] = wslCreateOptions([{ label: 'WSL: Ubuntu', shell: 'wsl:Ubuntu' }])
    expect(row.label).toBe('WSL: Ubuntu')
    expect(row.choice).toEqual({ kind: 'terminal', shell: 'wsl:Ubuntu' })
    expect(row.key).not.toBe('terminal')
  })

  it('adds nothing when there are no distributions', () => {
    expect(wslCreateOptions([])).toEqual([])
  })
})
