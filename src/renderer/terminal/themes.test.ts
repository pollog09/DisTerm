import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TERMINAL_THEME_ID,
  TERMINAL_THEMES,
  resolveTerminalTheme
} from './themes'

const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

describe('TERMINAL_THEMES', () => {
  it('has unique ids', () => {
    const ids = TERMINAL_THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('includes the default id', () => {
    expect(TERMINAL_THEMES.some((t) => t.id === DEFAULT_TERMINAL_THEME_ID)).toBe(true)
  })

  // A theme missing an ANSI slot doesn't fail loudly — xterm silently falls back to ITS default
  // for that one colour, so e.g. a Solarized terminal renders one Tango-green among eight
  // Solarized ones. Only a full-palette check catches that.
  it.each(TERMINAL_THEMES.map((t) => [t.id, t] as const))(
    '%s defines a complete palette',
    (_id, t) => {
      for (const key of ANSI_KEYS) {
        expect(t.theme[key], `${t.id}.${key}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
      expect(t.theme.background, `${t.id}.background`).toMatch(/^#[0-9a-f]{6}$/i)
      expect(t.theme.foreground, `${t.id}.foreground`).toMatch(/^#[0-9a-f]{6}$/i)
      expect(t.theme.cursor, `${t.id}.cursor`).toMatch(/^#[0-9a-f]{6}$/i)
      expect(t.theme.cursorAccent, `${t.id}.cursorAccent`).toMatch(/^#[0-9a-f]{6}$/i)
      expect(t.theme.selectionBackground, `${t.id}.selectionBackground`).toMatch(
        /^#[0-9a-f]{6,8}$/i
      )
    }
  )

  it('has a non-empty label for every theme', () => {
    for (const t of TERMINAL_THEMES) expect(t.label.trim().length).toBeGreaterThan(0)
  })

  it('offers at least one light theme', () => {
    expect(TERMINAL_THEMES.some((t) => !t.dark)).toBe(true)
  })
})

describe('green-on-black', () => {
  const channel = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const { theme, dark } = resolveTerminalTheme('green-on-black')

  it('is green text on a black field, and resolves by its own id', () => {
    expect(resolveTerminalTheme('green-on-black').id).toBe('green-on-black')
    expect(dark).toBe(true)
    expect(theme.background).toBe('#000000')
    expect(theme.foreground).toBe('#00ff00')
  })

  // `black` is the background on purpose (Gruvbox and One Dark do the same). Every other slot is
  // text that programs print, and agent CLIs print their dim lines in brightBlack.
  it.each(ANSI_KEYS.filter((k) => k !== 'black'))('%s keeps 4.5:1 on the background', (key) => {
    expect(contrast(theme[key]!, theme.background!)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps selected text readable', () => {
    expect(contrast(theme.foreground!, theme.selectionBackground!)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('parrot-os', () => {
  it("matches Parrot's Konsole colours", () => {
    const { id, dark, theme } = resolveTerminalTheme('parrot-os')
    expect(id).toBe('parrot-os')
    expect(dark).toBe(true)
    expect([theme.background, theme.foreground, theme.cursor]).toEqual([
      '#000000',
      '#18f018',
      '#ff0000'
    ])
    expect(ANSI_KEYS.map((key) => theme[key])).toEqual([
      '#000000',
      '#fa4b4b',
      '#18b218',
      '#b26818',
      '#1818b2',
      '#e11ee1',
      '#18b2b2',
      '#b2b2b2',
      '#686868',
      '#ff5454',
      '#54ff54',
      '#ffff54',
      '#5454ff',
      '#ff54ff',
      '#54ffff',
      '#ffffff'
    ])
  })
})

describe('the default theme reproduces the pre-themes appearance', () => {
  // LOAD-BEARING. Before themes, both call sites hardcoded these two colours and let xterm fill
  // in the rest from its own (Tango) palette. Anyone who never picks a theme must keep seeing
  // exactly that — an update is not allowed to repaint their terminals. Changing these values
  // means deciding to do that on purpose.
  const d = resolveTerminalTheme(DEFAULT_TERMINAL_THEME_ID).theme

  it('keeps the hardcoded background and foreground', () => {
    expect(d.background).toBe('#1e1e1e')
    expect(d.foreground).toBe('#e6e6e6')
  })

  it("keeps xterm's own default ANSI palette", () => {
    expect(d.black).toBe('#2e3436')
    expect(d.red).toBe('#cc0000')
    expect(d.green).toBe('#4e9a06')
    expect(d.yellow).toBe('#c4a000')
    expect(d.blue).toBe('#3465a4')
    expect(d.magenta).toBe('#75507b')
    expect(d.cyan).toBe('#06989a')
    expect(d.white).toBe('#d3d7cf')
    expect(d.brightBlack).toBe('#555753')
    expect(d.brightRed).toBe('#ef2929')
    expect(d.brightGreen).toBe('#8ae234')
    expect(d.brightYellow).toBe('#fce94f')
    expect(d.brightBlue).toBe('#729fcf')
    expect(d.brightMagenta).toBe('#ad7fa8')
    expect(d.brightCyan).toBe('#34e2e2')
    expect(d.brightWhite).toBe('#eeeeec')
  })
})

describe('resolveTerminalTheme', () => {
  it('resolves a known id', () => {
    expect(resolveTerminalTheme('dracula').id).toBe('dracula')
  })

  // settings.json is hand-editable and travels between versions. Handing xterm an undefined theme
  // would drop the terminal to xterm's own black background — a visibly broken app from a typo.
  it('falls back to the default for an unknown id', () => {
    expect(resolveTerminalTheme('no-such-theme').id).toBe(DEFAULT_TERMINAL_THEME_ID)
  })

  it('falls back for undefined and empty input', () => {
    expect(resolveTerminalTheme(undefined).id).toBe(DEFAULT_TERMINAL_THEME_ID)
    expect(resolveTerminalTheme('').id).toBe(DEFAULT_TERMINAL_THEME_ID)
  })

  // `applyLiveOptions` detects a palette change by object identity, so resolution must be stable.
  it('returns the same object for the same id', () => {
    expect(resolveTerminalTheme('nord').theme).toBe(resolveTerminalTheme('nord').theme)
  })
})
