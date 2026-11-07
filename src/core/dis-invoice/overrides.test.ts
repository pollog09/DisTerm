import { describe, expect, it } from 'vitest'
import { disInvoiceDevOverrides, disInvoiceProofOverrides } from './overrides'

const LOOPBACK = 'http://127.0.0.1:8799/api/connector'

const env = (url?: string, documents?: string): NodeJS.ProcessEnv => ({
  ...(url ? { DISTERM_DIS_INVOICE_URL: url } : {}),
  ...(documents ? { DISTERM_DIS_INVOICE_DOCUMENTS: documents } : {})
})

describe('disInvoiceDevOverrides', () => {
  it('a packaged build takes none, whatever the environment says', () => {
    expect(disInvoiceDevOverrides(env(LOOPBACK, '/sandbox'), true)).toEqual({})
  })

  it('a development build takes the loopback connector and its folder', () => {
    expect(disInvoiceDevOverrides(env(LOOPBACK, '/sandbox'), false)).toEqual({ url: LOOPBACK, documentsDir: '/sandbox' })
  })

  it.each([undefined, 'https://evil.example/api/connector', 'https://127.0.0.1:8799/api/connector'])(
    'moves the base folder only with a loopback connector, not with %s',
    (url) => {
      expect(disInvoiceDevOverrides(env(url, '/sandbox'), false)).toEqual({})
    }
  )
})

describe('disInvoiceProofOverrides', () => {
  const NEEDS_URL = "DISTERM_DIS_INVOICE_URL must be a loopback http:// URL, such as the fake connector's."
  const NEEDS_DOCUMENTS = 'DISTERM_DIS_INVOICE_DOCUMENTS must be an absolute path to a scratch folder.'

  it('passes both overrides through', () => {
    expect(disInvoiceProofOverrides(env(`${LOOPBACK}/`, '/sandbox'))).toEqual({
      ok: true,
      overrides: { url: LOOPBACK, documentsDir: '/sandbox' }
    })
  })

  it.each([
    [undefined, '/sandbox', NEEDS_URL],
    ['https://portal.distriib.com/api/connector', '/sandbox', NEEDS_URL],
    ['http://evil.example/api/connector', '/sandbox', NEEDS_URL],
    [LOOPBACK, undefined, NEEDS_DOCUMENTS],
    [LOOPBACK, 'relative/folder', NEEDS_DOCUMENTS]
  ])('refuses %s with %s', (url, documents, message) => {
    expect(disInvoiceProofOverrides(env(url, documents))).toEqual({ ok: false, message })
  })
})
