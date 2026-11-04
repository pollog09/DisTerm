import { describe, expect, it } from 'vitest'
import { RELAY_UNAVAILABLE_REASON } from '@shared/relay-availability'
import { shareDisabledReason } from './liveLink'

describe('sharing a live link with no relay in this build', () => {
  const base = { serverEdition: false, relayTab: false, activeLinks: 0 }

  it('is refused with the one reason, before the Pro gate could ask for anything', () => {
    expect(shareDisabledReason({ ...base, relayConfigured: false })).toBe(RELAY_UNAVAILABLE_REASON)
    // Not answered yet is not a yes.
    expect(shareDisabledReason({ ...base, relayConfigured: null })).toBe(RELAY_UNAVAILABLE_REASON)
  })

  it('stays available once a relay is configured', () => {
    expect(shareDisabledReason({ ...base, relayConfigured: true })).toBeNull()
  })
})
