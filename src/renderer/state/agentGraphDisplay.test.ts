// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_GRAPH_VIEW_KEY, parseAgentGraphDimension } from './agentGraphDisplay'

describe('parseAgentGraphDimension', () => {
  it.each([
    [null, '2d'],
    ['', '2d'],
    ['2d', '2d'],
    ['3d', '3d'],
    ['3D', '2d'],
    ['"3d"', '2d'],
    ['webgpu', '2d']
  ])('%j reads as %s', (raw, dimension) => {
    expect(parseAgentGraphDimension(raw)).toBe(dimension)
  })
})

describe('useAgentGraphDisplay', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })
  afterEach(() => vi.restoreAllMocks())

  const load = async () => (await import('./agentGraphDisplay')).useAgentGraphDisplay

  it('opens in 2D the first time', async () => {
    expect((await load()).getState().dimension).toBe('2d')
  })

  it('remembers the last choice on this machine', async () => {
    ;(await load()).getState().setDimension('3d')
    expect(localStorage.getItem(AGENT_GRAPH_VIEW_KEY)).toBe('3d')
    vi.resetModules()
    expect((await load()).getState().dimension).toBe('3d')
  })

  it('storage that throws on read or write never fails the view', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const store = await load()
    expect(store.getState().dimension).toBe('2d')
    expect(() => store.getState().setDimension('3d')).not.toThrow()
    expect(store.getState().dimension).toBe('3d')
  })
})
