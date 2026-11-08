import { describe, expect, it } from 'vitest'
import { readCopilotComposer } from './copilot-screen'

const rule = '─'.repeat(120)
const box = (prompt: string, below = ' ● Ready      Claude Sonnet 5.5') =>
  `~/proj [⎇ main]\n${rule}\n${prompt}\n${rule}\n${below}`

describe('readCopilotComposer (measured on copilot 1.0.107)', () => {
  it('a bare prompt is empty', () => {
    expect(readCopilotComposer(box('❯'))).toBe('empty')
    expect(readCopilotComposer(box('❯ '))).toBe('empty')
  })
  it('text after the prompt, including a slash filter, is a draft', () => {
    expect(readCopilotComposer(box('❯ hello draft'))).toBe('draft')
    expect(readCopilotComposer(box('❯ /add-dir'))).toBe('draft')
  })
  it('a continuation line is a draft', () => {
    const s = `${rule}\n❯\nsecond line\n${rule}\n status`
    expect(readCopilotComposer(s)).toBe('draft')
  })
  it('a choice dialog or a missing box is no prompt', () => {
    expect(readCopilotComposer('│ ❯ 1. Yes │\n│   2. No  │')).toBe('no-prompt')
    expect(readCopilotComposer(`${rule}\n❯\n${rule}\na\nb\nc\nd\ne`)).toBe('no-prompt')
  })
  it('an empty capture is unknown', () => {
    expect(readCopilotComposer('')).toBe('unknown')
  })
})
