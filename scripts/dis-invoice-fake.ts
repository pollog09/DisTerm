import { FAKE_CONNECTOR_KEY, FAKE_DEMO_SEED, startFakeConnector } from '../src/core/dis-invoice/fake-connector'

function arg(name: string): number | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : Number(process.argv[at + 1])
}

void startFakeConnector({ port: arg('port') ?? 8799, pageSize: arg('page-size'), seed: FAKE_DEMO_SEED }).then((fake) => {
  console.log(`fake connector  ${fake.url}`)
  console.log(`connector key   ${FAKE_CONNECTOR_KEY}`)
  console.log(`seeded          ${FAKE_DEMO_SEED.cards.length} cards, ${FAKE_DEMO_SEED.columns.length} columns`)
})
