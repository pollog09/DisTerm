import { afterEach, describe, expect, it } from 'vitest'
import { FAKE_CONNECTOR_KEY, startFakeConnector, type FakeConnector } from './fake-connector'

let fake: FakeConnector | undefined

afterEach(async () => {
  await fake?.close()
  fake = undefined
})

const origin = (f: FakeConnector): string => new URL(f.url).origin
const force = (f: FakeConnector, body: string): Promise<Response> =>
  fetch(`${origin(f)}/__control/force`, { method: 'POST', body })
const columns = (f: FakeConnector): Promise<Response> =>
  fetch(`${f.url}/columns`, { headers: { Authorization: `Bearer ${FAKE_CONNECTOR_KEY}` } })

describe('the fake connector control route', () => {
  it.each([
    ['a status that is not a number', '{"status":{"X-Evil":"1"},"route":"columns"}'],
    ['a status outside 100-599', '{"status":42,"route":"columns"}'],
    ['an unknown route', '{"status":500,"route":"__proto__"}'],
    ['a page that is not a positive integer', '{"status":500,"route":"tasks","page":"2"}'],
    ['a value that is not an object', '"500"']
  ])('refuses %s and keeps answering normally', async (_case, body) => {
    fake = await startFakeConnector()
    const answer = await force(fake, body)
    expect(answer.status).toBe(400)
    expect((await columns(fake)).status).toBe(200)
  })

  it('applies a well-formed force, and clears it with null', async () => {
    fake = await startFakeConnector()
    expect((await force(fake, '{"status":503,"route":"columns"}')).status).toBe(200)
    const forced = await columns(fake)
    expect(forced.status).toBe(503)
    expect(await forced.json()).toEqual({ error: 'Forzado.' })
    expect((await force(fake, 'null')).status).toBe(200)
    expect((await columns(fake)).status).toBe(200)
  })
})
