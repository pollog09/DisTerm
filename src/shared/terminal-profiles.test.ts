import { describe, expect, it } from 'vitest'
import { safeSessionProgram } from './node-exec'
import { parseWslShell, wslShellValue } from './terminal-profiles'

describe('WSL shell values', () => {
  it.each(['Ubuntu', 'RedHatEnterpriseLinux-9.8', 'My Distro', "it's (mine)!", 'Débian'])(
    'round-trips %s and stays a safe session program',
    (name) => {
      const value = wslShellValue(name)
      expect(parseWslShell(value)).toBe(name)
      expect(safeSessionProgram(value)).toBe(value)
    }
  )

  it.each([
    undefined,
    '',
    'wsl',
    'wsl:',
    'bash',
    'wsl:has space',
    'wsl:a;rm -rf',
    'wsl:$(id)',
    'wsl:%zz',
    'wsl:-d',
    'wsl:%2Dd',
    'wsl:a%0Ab'
  ])('refuses %s', (value) => {
    expect(parseWslShell(value)).toBeNull()
  })

  it('does not let a refused WSL value through as a session program', () => {
    expect(safeSessionProgram('wsl:a;rm -rf')).toBeUndefined()
    expect(safeSessionProgram('wsl:%2Dd')).toBeUndefined()
  })
})
