import { describe, expect, it } from 'vitest'
import type { ShipConfig, ShipConfigResult } from '@shared/ship-config'
import { shipTemplateCreatedText, shipTemplateOffer } from './shipTemplate'

const config = (over: Partial<ShipConfig> = {}): ShipConfigResult => ({
  ok: true,
  config: {
    machine: { kind: 'local', label: '' },
    agents: [], commands: [], workflows: [], skills: [], mcpServers: [], mcpRead: true, pipelines: [],
    graphSource: null,
    projectGraphPath: '/p/.claude/ship-graph.json',
    globalGraphPath: '/g/ship-graph.json',
    projectGraphExists: false,
    globalGraphExists: false,
    warnings: [],
    ...over
  }
})

describe('shipTemplateOffer', () => {
  it('says nothing until the machine has answered, or when it could not', () => {
    expect(shipTemplateOffer(null)).toEqual({ kind: 'none' })
    expect(shipTemplateOffer({ ok: false, reason: 'down' })).toEqual({ kind: 'none' })
  })

  it('offers it to a project with no routing file', () => {
    expect(shipTemplateOffer(config())).toEqual({ kind: 'offer' })
  })

  it('a global file that did not parse or cannot be read still ends it: a failed read is not absence', () => {
    expect(shipTemplateOffer(config({ globalGraphExists: true }))).toEqual({ kind: 'none' })
    expect(shipTemplateOffer(config({ globalGraphBlocked: true }))).toEqual({ kind: 'none' })
  })

  it('a file anywhere that routes, or anything at the project path, ends the offer', () => {
    expect(shipTemplateOffer(config({ graphSource: 'global', globalGraphExists: true }))).toEqual({ kind: 'none' })
    expect(shipTemplateOffer(config({ projectGraphExists: true }))).toEqual({ kind: 'none' })
    expect(shipTemplateOffer(config({ projectGraphBlocked: true }))).toEqual({ kind: 'none' })
  })

  it('a canvas with no folder is told why', () => {
    expect(shipTemplateOffer(config({ projectGraphPath: null }))).toEqual({ kind: 'disabled', reason: 'This canvas has no project folder.' })
  })
})

describe('shipTemplateCreatedText', () => {
  it('names what it made, what it kept, and how to run it', () => {
    const text = shipTemplateCreatedText({ ok: true, root: '/p/.claude', created: ['a', 'b'], kept: ['agents/doc-writer.md'] })
    expect(text).toBe('Created 2 files in /p/.claude. Kept what was already there: agents/doc-writer.md. Type /ship-change <task> in a Claude session to run it.')
  })

  it('has singular and nothing-new forms', () => {
    expect(shipTemplateCreatedText({ ok: true, root: '/r', created: ['a'], kept: [] })).toContain('Created 1 file in /r.')
    expect(shipTemplateCreatedText({ ok: true, root: '/r', created: [], kept: ['a'] })).toContain('Nothing new was needed in /r.')
  })
})
