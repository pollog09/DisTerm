import { describe, expect, it } from 'vitest'
import { safeSessionProgram } from './node-exec'
import { parseWslShell, wslShellLabel, wslShellOfPath, wslShellValue } from './terminal-profiles'

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

describe('wslShellOfPath', () => {
  it.each([
    ['\\\\wsl.localhost\\Ubuntu\\home\\me', 'wsl:Ubuntu'],
    ['\\\\wsl$\\Ubuntu', 'wsl:Ubuntu'],
    ['//wsl.localhost/My Distro/srv', 'wsl:My%20Distro']
  ])('names the distribution holding %s', (path, shell) => {
    expect(wslShellOfPath(path)).toBe(shell)
  })

  it.each(['C:\\repo', '/home/me', '\\\\server\\share\\x', '', undefined, null])('is null for %s', (path) => {
    expect(wslShellOfPath(path)).toBeNull()
  })

  it('refuses a name that would read as an option', () => {
    expect(wslShellOfPath('\\\\wsl.localhost\\-d\\x')).toBeNull()
  })
})

describe('wslShellLabel', () => {
  it('reads as its terminal row does', () => {
    expect(wslShellLabel('wsl:My%20Distro')).toBe('WSL: My Distro')
    expect(wslShellLabel('pwsh')).toBeNull()
  })
})
