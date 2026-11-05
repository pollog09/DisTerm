import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

// package.json `name` stays `node-terminal`, so `app.name` does too, and Electron words these roles
// from it ("Quit node-terminal") unless they carry a label. Nothing else may read `app.name` either.
const SRC = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

describe('the visible app name in the main process', () => {
  it('labels every role Electron would word from app.name', () => {
    expect(SRC).toContain("{ role: 'about', label: 'About DisTerm' }")
    expect(SRC).toContain("{ role: 'hide', label: 'Hide DisTerm' }")
    expect(SRC).toContain("{ role: 'quit', label: 'Quit DisTerm' }")
    expect(SRC).toContain("{ role: 'quit', label: process.platform === 'win32' ? 'Exit' : 'Quit DisTerm' }")
    expect(SRC).not.toMatch(/\{ role: '(about|hide|quit)' \}/)
  })

  it('never builds a visible string from app.name, and the window starts titled DisTerm', () => {
    expect(SRC).not.toMatch(/\bapp\.(name|getName\(\))/)
    expect(SRC).toContain("'DisTerm (test instance)' : 'DisTerm'")
  })
})
