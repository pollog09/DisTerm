import { describe, expect, it } from 'vitest'
import { mobileStoreLinks, mobileStoreNames } from './links'

describe('mobile store links', () => {
  it('offers no store: the mobile apps are upstream\'s and need a relay this build does not have', () => {
    expect(mobileStoreLinks()).toEqual([])
  })

  it('still names the stores for the license copy, which is about past purchases', () => {
    expect(mobileStoreNames()).toBe('the App Store or Google Play')
  })
})
