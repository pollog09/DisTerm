import { describe, expect, it } from 'vitest'
import { promises as fs, writeFileSync } from 'node:fs'
import path from 'node:path'
import { disInvoiceBaseDir, disInvoiceFolderName, ensureDisInvoiceFolder } from './folders'
import { testTmpDir } from '../test-tmp'

describe('disInvoiceFolderName', () => {
  it.each([
    ['Exotic Garage Cr', 'Exotic Garage Cr'],
    ['Café Central', 'Café Central'],
    ['../../etc/passwd', '.._.._etc_passwd'],
    ['..', 'proyecto-7'],
    ['.', 'proyecto-7'],
    ['...', 'proyecto-7'],
    ['   ', 'proyecto-7'],
    ['', 'proyecto-7'],
    ['a/b\\c', 'a_b_c'],
    ['C:\\Windows', 'C__Windows'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['Com1', '_Com1'],
    ['trailing dots...', 'trailing dots'],
    ['  padded  ', 'padded'],
    ['bell\u0007name', 'bell_name'],
    ['what?*"<>|', 'what______'],
    ['x'.repeat(200), 'x'.repeat(80)],
    [`${'y'.repeat(79)}. tail`, 'y'.repeat(79)]
  ])('%j -> %j', (nombre, expected) => {
    expect(disInvoiceFolderName(nombre, 7, new Set())).toBe(expected)
  })

  it('gives same-named projects their own folder, regardless of case', () => {
    const taken = new Set<string>()
    expect(disInvoiceFolderName('Web', 1, taken)).toBe('Web')
    expect(disInvoiceFolderName('Web', 2, taken)).toBe('Web (2)')
    expect(disInvoiceFolderName('WEB', 3, taken)).toBe('WEB (3)')
    expect(disInvoiceFolderName('Otro', 4, taken)).toBe('Otro')
  })
})

describe('disInvoiceBaseDir', () => {
  it('sits under the shell-supplied Documents folder', () => {
    expect(disInvoiceBaseDir(path.join('/mnt', 'OneDrive', 'Documents'))).toBe(path.join('/mnt', 'OneDrive', 'Documents', 'Distriib'))
  })
})

describe('ensureDisInvoiceFolder', () => {
  it('creates missing parents and reports an empty new folder', async () => {
    const folder = path.join(testTmpDir('dis-folder-'), 'Documents', 'Distriib', 'Web')
    expect(await ensureDisInvoiceFolder(folder)).toEqual({ ok: true, folder, created: true, empty: true, isRepo: false })
  })

  it('leaves an existing folder alone and says what is in it', async () => {
    const folder = testTmpDir('dis-folder-')
    writeFileSync(path.join(folder, 'notes.md'), 'keep me')
    expect(await ensureDisInvoiceFolder(folder)).toEqual({ ok: true, folder, created: false, empty: false, isRepo: false })
    expect(await fs.readFile(path.join(folder, 'notes.md'), 'utf8')).toBe('keep me')
    await fs.mkdir(path.join(folder, '.git'))
    expect(await ensureDisInvoiceFolder(folder)).toEqual({ ok: true, folder, created: false, empty: false, isRepo: true })
  })

  it('refuses when a file already holds the name', async () => {
    const dir = testTmpDir('dis-folder-')
    const folder = path.join(dir, 'Web')
    writeFileSync(folder, 'a file')
    expect(await ensureDisInvoiceFolder(folder)).toEqual({ ok: false, message: `Could not create ${folder} (EEXIST).` })
  })
})
