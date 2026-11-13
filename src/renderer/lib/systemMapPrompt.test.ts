import { describe, expect, it } from 'vitest'
import { SYSTEM_MAP_FILE, SYSTEM_MAP_PROMPT } from '@shared/system-map'
import { LAUNCH_PROMPT_BUDGET_BYTES, flattenPrompt, promptExceedsLineBudget } from './promptSpill'

describe('SYSTEM_MAP_PROMPT', () => {
  it('fits the inline launch budget after flattening, so Map this repo never spills to a file', () => {
    expect(new TextEncoder().encode(flattenPrompt(SYSTEM_MAP_PROMPT)).length).toBeLessThanOrEqual(LAUNCH_PROMPT_BUDGET_BYTES)
    expect(promptExceedsLineBudget(SYSTEM_MAP_PROMPT)).toBe(false)
    expect(flattenPrompt(SYSTEM_MAP_PROMPT)).toContain(SYSTEM_MAP_FILE)
  })
})
